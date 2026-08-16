# Architektur-Konzept: Cheat-sicheres Offline-Play

> **Die eine Idee:** Der Client darf offline alles *vorausberechnen* — aber der berechnete
> Zustand ist nie echt. Echt wird er erst, wenn der Server ihn deterministisch nachrechnet
> und absegnet. „Nicht cheatbar" heißt nicht „der Client kann nichts Falsches rechnen",
> sondern **der Server akzeptiert niemals unvalidierten Zustand.**

---

## 1. Grundprinzip: Server-Authoritative Simulation

Ein normales Client-Server-Game vertraut dem Client zu oft: der Client sagt „ich habe jetzt
500 Gold" und der Server glaubt es (oder prüft nur stichprobenartig). Das ist die Wurzel
fast aller Cheats.

Wir drehen das um:

- **Der Client schickt niemals Zustand.** Nicht „ich habe 500 Gold", sondern nur *Aktionen*:
  „pflanze Weizen auf Feld 3 zu Tick T".
- **Der Server ist die einzige Quelle der Wahrheit.** Er hält den kanonischen Zustand und
  leitet jeden neuen Zustand ausschließlich selbst aus geprüften Aktionen ab.
- **Der Client rechnet dieselbe Logik nur lokal mit**, um sofort etwas anzeigen zu können
  (optimistic prediction). Diese lokale Rechnung ist Wegwerf-Ware bis zur Bestätigung.

Offline-Spielen ist damit einfach eine **Vorhersage, die später bestätigt oder verworfen
wird** — nicht ein zweiter, gleichberechtigter Spielstand.

---

## 2. Kernmechanik: Command-Log + Deterministische Simulation

Das Fundament sind zwei Bausteine, die zusammen alles tragen.

### 2.1 Command-Log

Jede Spieleraktion wird als kompaktes, unveränderliches **Command** aufgezeichnet:

```jsonc
{
  "seq": 1043,              // fortlaufende Nummer pro Spieler (lückenlos, geordnet)
  "tick": 92718,            // Spielzeit-Tick, an dem die Aktion passiert (nicht Wanduhr!)
  "type": "PLANT",
  "args": { "field": 3, "crop": "wheat" },
  "clientTs": 1734350400   // Client-Zeitstempel, NUR informativ, nie vertrauenswürdig
}
```

Offline sammelt der Client diese Commands einfach in einer lokalen Queue. Es ist ein
append-only Log — nie editieren, nie löschen.

### 2.2 Deterministische Simulation

Die gesamte Spiellogik ist eine reine Funktion:

```
neuerZustand = simulate(alterZustand, command)
```

Gleicher Input → **bit-für-bit gleicher Output**, egal ob auf iPhone, Android oder Server.
Das ist die Bedingung, die alles ermöglicht: Client und Server rechnen garantiert dasselbe
Ergebnis, also kann der Server die Client-Rechnung reproduzieren und vergleichen.

Regeln für Determinismus (nicht verhandelbar):

- **Keine Floats in der Spiellogik.** Alles Integer / Fixed-Point. Ein Farmgame kommt damit
  problemlos aus (Mengen, Zeiten, Preise sind alle ganzzahlig).
- **Zeit in Ticks, nicht in Sekunden.** 1 Tick = z.B. 1 Sekunde Spielzeit. Wachstum,
  Produktion etc. wird in Ticks gemessen.
- **Deterministischer RNG**, ausschließlich mit servergesetztem Seed (siehe §5).
- **Geordnete Iteration** über alle Collections (nach seq / stabiler ID), nie über Hash-Maps
  in undefinierter Reihenfolge.
- **Keine Systemzeit, keine Locale, keine Plattform-APIs** in der Sim.

---

## 3. Der Sync-Flow (das Herzstück)

```
                        OFFLINE                                    RECONNECT
   ┌─────────────────────────────────────────┐        ┌──────────────────────────────┐
   │  Client startet von letztem validen       │        │  1. Client sendet:           │
   │  Snapshot (S0) + valider Tick (T0)        │        │     - baseSeq / baseSnapshot │
   │                                           │        │     - Command-Log [seq>base] │
   │  Spieler handelt →                        │        │                              │
   │    command 1041, 1042, 1043 ...           │        │  2. Server re-simuliert:     │
   │    lokal optimistisch angewandt           │  ───►  │     state = S0               │
   │    (UI reagiert sofort)                   │        │     for cmd in log:          │
   │                                           │        │       assert legal(cmd)      │
   │  Zeit läuft lokal weiter, ABER            │        │       assert timeOk(cmd)     │
   │  Wachstum ist nur "vorläufig"             │        │       state = sim(state,cmd) │
   └─────────────────────────────────────────┘        │                              │
                                                        │  3a. alles valide →          │
                                                        │      commit, neuer Snapshot  │
                                                        │      "als wäre nix passiert"  │
                                                        │  3b. etwas invalide →        │
                                                        │      Rollback auf S0,         │
                                                        │      Client resynct           │
                                                        └──────────────────────────────┘
```

**Ergebnis aus Spielersicht:**

- Ehrlicher Spieler: nahtlos. Seine Offline-Aktionen werden 1:1 bestätigt, der Client hatte
  ja lokal dasselbe gerechnet. Er merkt vom Sync nichts.
- Cheater: Rollback. Der manipulierte Zustand wird verworfen. Genau das gewünschte Verhalten
  — „gecheatet" heißt hier „passiert einfach nicht".

---

## 4. Zeit ist der eigentliche Feind

Bei einem Hay-Day-Style-Game ist **Zeit die Kernressource** (Weizen wächst 2h). Das ist der
gefährlichste Angriffsvektor: ein Cheater stellt offline einfach die Geräteuhr vor und
erntet „nach 2h" sofort.

**Regel: Wachstum/Zeitfortschritt wird NIE über die Client-Uhr validiert.**

Stattdessen ein **servergemessenes Zeitbudget**:

- Der Server kennt den echten Wanduhr-Zeitpunkt des letzten Syncs (`serverTs_lastSync`).
- Beim Reconnect misst *der Server* die real vergangene Zeit: `Δreal = serverTs_now − serverTs_lastSync`.
- Der Server gewährt **maximal `Δreal` an Zeitfortschritt** — egal was die Command-Ticks des
  Clients behaupten.

Konkret in der Validierung:

```
maxTick = T0 + secondsToTicks(serverTs_now − serverTs_lastSync)
assert command.tick <= maxTick   // Client kann keine Zeit "erfinden"
```

**Schöner Nebeneffekt:** reine Idle-Progression („weggehen, später wiederkommen") wird damit
trivial und *kostenlos* offline-fähig. Ob du 2h wirklich weg warst oder 2h offline gespielt
hast — der Server gewährt in beiden Fällen genau 2h Wachstum. Fast-forward ist unmöglich.

> Optional: `Δreal` deckeln (z.B. max. 14 Tage Offline-Fortschritt gutschreiben), damit
> jemand nicht ein halbes Jahr wegbleibt und dann eine absurde Ernte einfährt. Reines
> Balancing, keine Security-Frage.

---

## 5. Zufall gehört dem Server

Alles Zufällige (Loot, Drops, Kisten, seltene Events) darf **offline nicht endgültig
aufgelöst** werden — sonst würfelt der Client heimlich neu, bis das Ergebnis passt.

Zwei saubere Muster:

1. **Deferred Resolution:** Offline wird die *Aktion* geloggt („Kiste geöffnet"), aber das
   *Ergebnis* erst beim Sync serverseitig gewürfelt und zurückgeschickt. Der Client zeigt
   offline eine „wird beim nächsten Online-Sync aufgelöst"-Animation.
2. **Server-Seed-Ableitung:** Der Server gibt dem Client bei jedem Sync einen frischen,
   signierten Seed mit, den der Client *nicht vorhersehen* kann. Zufall wird deterministisch
   aus `hash(seed, command.seq)` abgeleitet. Der Client kann rechnen, aber nicht steuern —
   und der Server verifiziert es beim Re-Sim.

Muster 1 ist einfacher und für die meisten Belohnungen die richtige Wahl.

---

## 6. Was offline geht — und was nicht

Nicht alles lässt sich offline abbilden. Die klare Trennung:

| ✅ Offline-fähig (optimistic + reconcile)       | ❌ Online-only                          |
| ----------------------------------------------- | -------------------------------------- |
| Eigene Farm: pflanzen, ernten, bauen, craften   | Marktplatz / Handel mit anderen        |
| Deterministische Produktion / Rezepte           | Nachbarn, Besuche, soziale Interaktion |
| Idle-Zeitprogression (server-gedeckelt, §4)     | Zufallsbelohnungen (Auflösung, §5)     |
| Lokale Quests mit deterministischem Fortschritt | Live-Events, Leaderboards, PvP         |

Faustregel: **Alles, was nur den eigenen Zustand betrifft und deterministisch ist → offline.
Alles, was geteilte Welt oder echten Zufall braucht → online.** In der UI werden Online-only-
Features offline einfach ausgegraut mit „braucht Verbindung".

---

## 7. Kapazitätsgrenzen & Overflow (Lagerlimits)

### Die gute Nachricht: offline überschreiten geht gar nicht

Ein Lagerlimit ist eine **Regel innerhalb der Sim** — kein nachträglicher Server-Check. Der
Client rechnet dieselbe Regel mit derselben Funktion. `simulate()` lehnt die Aktion ab oder
clampt sie, lokal exakt wie am Server. Es gibt also kein „offline drüber gehen und beim Sync
fällt's auf".

Das ist ein Beispiel für ein allgemeines Prinzip, das viel Arbeit spart:

> **Jede Regel, die in der Sim lebt, ist automatisch auch offline durchgesetzt.**
> Nur Regeln, die die *geteilte Welt* brauchen, müssen online sein.

### Was du entscheiden musst: was passiert am Limit

Drei legitime Varianten — Hauptsache deterministisch:

| Variante | Verhalten | Gefühl |
| --- | --- | --- |
| **Hard block** | Ernte nicht möglich, Feld bleibt reif stehen | kein Verlust, aber blockiert |
| **Waste** | Ernte klappt, Überschuss verfällt | flüssig, aber stiller Verlust |
| **Soft-Cap** | Überfüllen erlaubt, Produktion pausiert bis drunter | kulant, komplexer |

**Empfehlung:** Hard block für *Spieleraktionen* (nie stiller Verlust bei etwas, das der
Spieler selbst ausgelöst hat) + Produktionsstopp für *passive* Erzeugung.

### Der eigentliche Fallstrick: gedeckelte Akkumulation

Du bist 5h offline, das Lager ist nach 1h voll. Rechnet der Client `rate × Δt` und der Server
tick-genau mit Clamping (oder umgekehrt) → **Divergenz → R1 → Rollback für einen ehrlichen
Spieler.** Genau die Bug-Sorte, die das Konzept am meisten gefährdet.

Regel: Produktion ist **eine geschlossene Funktion**, identisch auf beiden Seiten:

```
produce(fromTick, toTick, rate, capacity, contents) -> newContents
```

Niemals zwei Implementierungen („die schnelle im Client, die genaue am Server").

**Bonus — das entschärft gleichzeitig R4:** Zwischen zwei Commands passiert nichts
Spielerseitiges. Es genügt also, diese Funktion **pro Segment** auszuwerten (Segmente =
Anzahl Commands + 1) statt Tick für Tick über 5h zu loopen. Ein Sync kostet damit
`O(Commands)` statt `O(vergangene Zeit)`.

### Der harte Fall: was *währenddessen* von außen ankommt

Hier tut das Lagerlimit wirklich weh. Während du offline warst, ist server-seitig etwas
passiert, das du unmöglich wissen konntest:

- ein Nachbar schickt ein Geschenk
- ein Marktverkauf geht durch, Gold/Restware kommt zurück
- ein Live-Event schüttet Belohnungen aus

Beim Sync wollen jetzt **deine offline produzierten Güter** *und* **diese Lieferungen** in ein
Lager, das nicht für beide reicht.

Regel: **Niemals etwas vernichten, von dem der Spieler nichts wissen konnte.**

1. **Deine Offline-Aktionen zuerst.** Sie liegen in deiner Zeitlinie früher — und der Client
   hat sie lokal genau so gerechnet. Jede andere Reihenfolge erzeugt Divergenz.
2. **Server-Lieferungen danach in einen Overflow-Puffer („Postfach")**, nicht ins Lager
   zwingen und nicht verfallen lassen. Der Spieler räumt auf und holt sie ab.
3. Das Postfach hat selbst ein großzügiges Limit + Ablauffrist, damit es kein Zweitlager wird.

Ein Postfach willst du für Geschenke, Event-Belohnungen und Entschädigungen ohnehin — es löst
diesen Fall nebenbei sauber mit.

### Nebeneffekt: Limits sind Inflationsschutz

R6 warnt, dass offline produzierte Güter in den geteilten Markt fließen und jede
Validierungslücke die Ökonomie *für alle* inflationiert. Ein Lagerlimit **deckelt strukturell**,
wie viel Offline-Produktion überhaupt in die Wirtschaft gelangen kann — egal wie lange jemand
weg war. Das ist ein zweites Netz unter der Zeit-Autorität aus §4: selbst wenn die Zeitprüfung
mal versagt, begrenzt das Lager den Schaden.

---

## 8. Reconciliation & Rollback (UX)

Der ehrliche Fall ist unsichtbar. Für die seltenen Konflikte (Client- und Server-Zustand
weichen ab — durch Bug, Manipulation oder verlorene Verbindung mitten im Sync):

- **Server gewinnt immer.** Kein Merge-Verhandeln, der kanonische Zustand ist der Server-Zustand.
- **Snapshot-Anker:** Nach jedem erfolgreichen Sync schreibt der Server einen neuen Snapshot
  (`S_n`, `seq_n`, `serverTs_n`). Das ist der neue Startpunkt für die nächste Offline-Phase.
  Der Client speichert diesen Snapshot signiert lokal.
- **Bei Divergenz:** Client verwirft seine optimistische lokale Rechnung, lädt den Server-
  Snapshot, spielt sanft „zurück auf den echten Stand". Für den Spieler idealerweise eine
  kurze Sync-Animation, kein hartes Zurückspringen.
- **Manipulationsschutz des Snapshots:** Server signiert Snapshots (HMAC/Signatur). Der
  Client kann sie nicht fälschen, um mit einem besseren „letzten validen Stand" zu starten.

---

## 9. Grober Tech-Zuschnitt

Die Architektur ist bewusst tech-agnostisch, aber ein pragmatischer Startpunkt:

- **Sim-Kern als eine gemeinsame, portable Codebase** (der `simulate`-Kern läuft *identisch*
  auf Client und Server). Kandidaten: Rust (→ WASM für Web/Mobile, nativ am Server),
  TypeScript (ein Sprachstamm überall), oder C#. Wichtigstes Kriterium: derselbe Code, keine
  zwei Implementierungen, die auseinanderlaufen können.
- **Client (mobile-first):** UI-Layer + lokaler Sim-Kern + Command-Queue + Snapshot-Store.
  Engine z.B. Unity/Godot oder ein eigener Renderer — die Engine ruft nur den Sim-Kern.
- **Server:** derselbe Sim-Kern hinter einer Validierungs-Pipeline + Persistenz (kanonischer
  Zustand + Command-Log + Snapshots) + Zeitautorität.
- **Transport:** Beim Sync nur der Command-Log hoch, Snapshot + aufgelöster Zufall runter.
  Winzige Payloads, weil kein Zustand übertragen wird.

---

## 10. Offene Fragen / nächste Schritte

- [ ] Tick-Auflösung festlegen (1s? 1min?) — Trade-off Präzision vs. Log-Größe.
- [ ] Command-Set definieren (die vollständige Liste erlaubter Aktionen ist die eigentliche
      „Regel" des Spiels).
- [ ] Konkrete Sim-Sprache/Portabilität wählen (§9).
- [ ] Verhalten am Lagerlimit festlegen (hard block / waste / soft-cap, §7).
- [ ] Postfach: Kapazität, Ablauffrist, UI fürs Abholen (§7).
- [ ] Snapshot-Format + Signaturschema.
- [ ] Offline-Deckel (§4) und Balancing-Regeln.
- [ ] Konfliktdarstellung im UI (Sync-Animation statt hartem Rollback).
- [ ] Prototyp: nur „Feld pflanzen → wachsen → ernten" end-to-end mit vollem Sync-Zyklus,
      um Determinismus und Zeit-Handling früh zu beweisen.

> ⚠️ Vor dem Bauen: die Schwachstellen-Analyse in **[risks.md](risks.md)** lesen. Besonders
> R1 (Determinismus-Bugs treffen ehrliche Spieler) und R2 (Sim-Versionierung vs. Live-Service)
> sind der Grund, warum der erste Meilenstein ein *Determinismus-Beweis* sein muss, kein Feature.

---

*Dieses Konzept kombiniert bekannte Muster (deterministische Lockstep-Simulation aus RTS-
Games + Server-Reconciliation aus Multiplayer-Netcode) zu etwas, das so als nahtloses
Offline-Live-Service-Farmgame selten bis nie gebaut wurde. Der Aufwand steckt in
Determinismus-Disziplin und Zeit-Autorität — beides lösbar, wenn man es von Anfang an
mitdenkt.*

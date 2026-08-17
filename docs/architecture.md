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
                                                        │      legales Präfix bleibt,   │
                                                        │      Rest verworfen (§9)      │
                                                        └──────────────────────────────┘
```

**Ergebnis aus Spielersicht:**

- Ehrlicher Spieler: nahtlos. Seine Offline-Aktionen werden 1:1 bestätigt, der Client hatte
  ja lokal dasselbe gerechnet. Er merkt vom Sync nichts.
- Cheater: Der manipulierte Zustand wird verworfen. Genau das gewünschte Verhalten —
  „gecheatet" heißt hier „passiert einfach nicht".

Was genau verworfen wird, ist bewusst fein abgestuft — ein illegales Command kippt nicht die
legale Arbeit davor, und ein Determinismus-Bug kippt gar nichts. Details in §9.

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

> ### Verbindliche Produktregel
>
> **Alles, was offline gehen kann, geht offline. Was die geteilte Welt braucht, ist
> online-only und wird ausgegraut.**
>
> Das ist keine Priorisierung, sondern eine Voreinstellung, die sich umdreht: Nicht
> „welche Features machen wir offline-fähig", sondern **jedes Feature ist offline-fähig,
> bis bewiesen ist, dass es das nicht sein kann.** Und bewiesen heißt: Es braucht
> geteilten knappen Zustand oder echten Zufall — dann ist es Physik (§8), nicht Aufwand.
>
> Die Regel hat eine scharfe Kante, und die ist beabsichtigt: Ein soziales Feature
> nachträglich in den Kernkreislauf zu ziehen, macht den Kern online-pflichtig und bricht
> damit das Versprechen, mit dem das Spiel antritt. Solche Features gehören an den Rand,
> nie in die Mitte.

> **Nuance beim Handel:** Online-only ist nur der *Abschluss*. Aufträge platzieren, NPC-Handel
> und Geschenke funktionieren sehr wohl offline — siehe §8.

### Offline darf sich nicht tot anfühlen

Die Regel oben sagt, was offline *erlaubt* ist. Sie sagt nicht, dass offline auch etwas
*los* ist — und das ist ein eigener Fehlerfall. Im Feldtest war er in einer Minute
erreicht: alle Felder bepflanzt, Inventar leer, Silo unter dem Limit. Jeder Tap wurde
lokal korrekt abgelehnt. Das Spiel war nicht kaputt, es war leer.

> ### Verbindliche Produktregel
>
> **Es gibt keinen Zustand, in dem der Spieler offline nichts tun kann.**
> Ein Leerlauf ohne Netz ist ein Bug, keine Stimmung.

Drei Dinge sichern das, und alle drei sind Design, nicht Technik:

1. **Vorrat statt Verbindung.** Alles, was der Server ohnehin würfelt (Aufträge, Kunden,
   Wetterplan, Event-Aufgaben), wird als *Vorrat* mit dem Snapshot ausgeliefert — versiegelt
   vorgewürfelt (§5, Muster „Vorwissen ist kein Vorteil"). Offline geht der Nachschub
   dann nie aus; beim Sync füllt der Server auf. Faustregel: Der Vorrat muss den
   Offline-Deckel aus §4 überdauern, sonst ist er nur eine längere Leere.
2. **Kein Sackgassen-Zustand.** Der Kreislauf muss immer mindestens ein Ventil haben, das
   ohne Eingaben und ohne Netz funktioniert. Bei uns ist das der NPC-Verkauf (§8): Wer
   feststeckt, verkauft und hat wieder Münzen. Ohne so ein Ventil kann sich ein Spieler
   offline selbst blockieren — keine Münzen, kein Saatgut, kein Ausweg — und das trifft nur
   den, der gerade *kein* Netz hat.
3. **Kurze Timer neben langen.** Wenn alles Stunden dauert, ist offline ein Wartezimmer.
   Mindestens eine Produktionsstufe muss im Sekunden- bis Minutenbereich liegen, damit eine
   Zugfahrt eine Schleife hat und nicht nur einen Blick.

Der Prüfstein dafür ist billig und gehört in jeden Feldtest:

> **Leerlauf-Test:** Netz aus, beliebiger Spielstand. Gibt es innerhalb von 60 Sekunden
> etwas Sinnvolles zu tun? Wenn nein, fehlt Inhalt oder ein Ventil.

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

> **Invariante, die dieses Netz trägt:** Die Bremse wirkt nur, wenn **jeder** Ort mit einem
> Limit versehen ist, an dem Güter liegen können — Lager, Postfach, Handels-Escrow (§8),
> ausstehende Belohnungen. Ein einziger ungedeckelter Behälter macht das Lagerlimit wertlos.
> Bei jedem neuen Feature prüfen: *Entsteht hier ein neuer Ort, an dem Zeug liegen kann?*

**Und die Summe ist die Zahl, die zählt.** „Lagerlimit 100" ist nicht die Menge, die ein
Spieler halten kann — die echte Obergrenze ist

```
Lager + Auftrags-Slots × Stapelgröße + Postfachplätze × Stapelgröße
```

Im Prototyp sind das mit `100 + 4×20 + 20×20` ganze **580 Einheiten**, also fast das
Sechsfache des Lagerlimits. Das ist kein Leck — die Menge sättigt dort und wächst auch nach
tausenden Angriffsrunden nicht weiter (per Test abgesichert). Aber es ist eine Zahl, die man
**bewusst wählen** muss, statt sie aus drei unabhängig gesetzten Limits herausfallen zu lassen.

Wer das Lagerlimit als Balancing-Hebel benutzt, muss also alle drei Limits zusammen
betrachten — sonst reguliert er die eine Zahl, die den Spieler am wenigsten bindet.

---

## 8. Handel: was wirklich unmöglich ist — und was doch geht

### Der harte Kern ist tatsächlich unmöglich

Zwei offline Spieler können sich über **geteilten, knappen Zustand** nicht einigen. Wenn beide
offline die letzte Charge Weizen kaufen, ist das **kein Cheat** — beide sind ehrlich, und
trotzdem gibt es einen Konflikt.

Das ist der entscheidende Punkt: Es ist ein **Konsistenz**problem, kein Sicherheitsproblem.
Ohne gemeinsame Instanz während der Trennung gibt es keine Einigung — dieselbe Klasse Problem
wie das CAP-Theorem. Kein Engineering-Aufwand löst das.

> **Gleichzeitiger, bestätigter Handel zwischen offline Spielern = unmöglich. Punkt.**

### Aber du brauchst gar keinen Handel offline — du brauchst *Absicht*

Die Umdeutung, die fast alles rettet: Offline „handeln" heißt nicht *Trade abschließen*,
sondern *Auftrag erteilen*. Und ein Auftrag ist ein ganz normales Command wie jedes andere.

**Verkaufen ist einseitig → funktioniert offline gut.**

- Du committest Ware, die du nachweislich hast.
- **Escrow beim Command:** Der Weizen verlässt dein Lager in dem Moment, in dem du den Auftrag
  offline erteilst. Deterministisch, lokal, und damit ist ein Doppelverkauf strukturell
  ausgeschlossen.
- Beim Sync stellt der Server das Angebot real ein.

**Kaufen ist schwieriger → als Limit-Order lösen.**

- „Kaufe bis zu 50 Weizen für max. 12 Gold" — das Gold wird escrowed.
- Beim Sync füllt der Server, was verfügbar ist, und erstattet den Rest.
- **UI-Regel:** Offline **niemals** „gekauft" anzeigen, immer „Auftrag platziert". Der
  Unterschied zwischen Zusage und Absicht muss sichtbar sein — sonst fühlt sich ein nicht
  gefüllter Auftrag wie ein Verlust an, obwohl nichts verloren ging.

### ⚠️ Escrow darf kein unendliches Lager werden

Das Escrow aus dem letzten Abschnitt löst zwar den Doppelverkauf — reißt aber prompt ein neues
Loch auf, wenn man es nicht deckelt:

> **Der Exploit:** Lager voll (100 Weizen). Ich stelle 100 Weizen zu einem absurden Preis ein,
> den nie jemand zahlt. Die Ware wandert ins Escrow, das Lager ist leer, ich produziere weiter.
> Wiederholen. Ergebnis: 1000 Weizen „gelagert" bei einem Limit von 100 — und ich storniere
> später einfach alles.

Das ist nicht nur ein Lager-Exploit. Es **hebelt die Inflationsbremse aus §7 komplett aus**:
Wenn Escrow unbegrenzt ist, ist das Lagerlimit bedeutungslos.

**Die zugrundeliegende Regel — und die gilt allgemein:**

> **Jeder Ort, an dem ein Gut liegen kann, braucht ein Limit.** Lager, Escrow, Postfach,
> „ausstehende Belohnungen" — jeder ungedeckelte Behälter ist ein Loch im Lagerlimit.

Vier Maßnahmen, in der Reihenfolge ihrer Wirksamkeit:

1. **Auftrags-Slots (der strukturelle Fix, nicht verhandelbar).**
   Du hast N aktive Verkaufsaufträge, fertig. Escrow ist damit hart begrenzt auf
   `N × maxStapelProSlot`. Genau das macht Hay Day mit den Hofladen-Plätzen. Nebeneffekt: Slots
   sind eine schöne Progressions- und Monetarisierungsachse (mehr Plätze freischalten).

2. **Preisbänder.** Der Exploit lebt davon, zu einem *unverkäuflichen* Preis einzustellen. Wenn
   Preise auf ein sinnvolles Band um den Referenzwert begrenzt sind (z.B. 25–150 %), ist alles
   Eingestellte plausibel verkäuflich — Escrow wird echt transient statt zum Parkplatz.

3. **Ablauffrist → Postfach.** Aufträge verfallen nach z.B. 24h. Die Ware geht zurück — aber das
   Lager ist ja voll, also landet sie im **Postfach (§7)**, das selbst Limit und Ablauffrist
   hat. Die Kette terminiert damit sauber: Escrow → Postfach → weg. Nutzt Maschinerie, die es
   ohnehin schon gibt.

4. **Gebühren — dein Instinkt, aber richtig dosiert.** Wichtige Unterscheidung:
   - Eine **einmalige Einstellgebühr** ist als Exploit-Schutz *schwach*: Ein reicher Spieler
     zahlt sie aus der Portokasse und stasht weiter, ein armer wird beim ehrlichen Handel
     bestraft. Falscher Hebel.
   - Eine **Haltegebühr** (Gold pro Stunde im Escrow) trifft dagegen genau das richtige
     Verhalten: Echte Verkäufe füllen schnell und zahlen fast nichts, Dauerparken wird teuer.
   - Beides bleibt trotzdem wertvoll — aber als **Gold-Senke gegen Inflation (R6)**, nicht als
     Exploit-Schutz. Gebühren regulieren die Ökonomie; **gedeckelt wird strukturell.**

   ⚠️ Wenn eine Haltegebühr das Gold auf 0 treibt: Auftrag verfällt und geht ins Postfach — nie
   in negatives Gold laufen lassen.

**Und ganz wichtig:** All das muss **in der Sim** leben, nicht als Server-Check beim Sync. Slot-
und Preisgrenzen als Sim-Regeln sind nach dem Prinzip aus §7 automatisch offline durchgesetzt —
der Client lässt den Exploit gar nicht erst zu. Ein reiner Server-Check würde stattdessen beim
Sync zuschlagen und ehrlichen Spielern Rollbacks bescheren (R1).

### Der NPC-Markt ist der eigentliche Held

Ein Systemhändler mit definierten Preisen ist **kein geteilter knapper Zustand**, sondern eine
reine Sim-Regel. Damit ist er **voll offline-fähig**: kaufen und verkaufen sofort, mit echter
Bestätigung, ganz ohne Sync. Das deckt gefühlt den größten Teil von „Handel" ab.

- Preise kommen aus dem versionierten Ruleset (R2), damit sie deterministisch sind.
- ⚠️ Ein unbegrenzter NPC-Ankauf wäre eine Gold-Quelle, die man offline farmen kann. Gedeckelt
  wird das schon automatisch durch Lagerlimit (§7) und Zeitautorität (§4) — mehr Ware, als Zeit
  und Lager hergeben, existiert nicht. Zusätzlich sinnvoll: tägliche Ankaufkontingente.

### Geschenke gehen offline

Eine einseitige Übertragung braucht keinen Konsens: Escrow beim Senden, Zustellung beim Sync,
Landung im Postfach des Empfängers (§7).

### Der Spielermarkt offline: Snapshot + Auftragsbuch

Der Client cached den Marktzustand vom letzten Sync. Offline browst du eine **veraltete
Momentaufnahme**, deutlich markiert („Stand: vor 3 Stunden"). Aufträge werden dagegen platziert
und beim Sync abgeglichen.

Risiko: Der Spieler sieht ein Superangebot, das längst weg ist. Gegenmittel: Alter des
Snapshots prominent anzeigen und Aufträge konsequent als *Absicht* framen, nie als Abschluss.

### Der Glücksfall: das Genre macht es ohnehin schon so

Farmgame-Märkte sind **bereits asynchron**. Du stellst Ware in den Hofladen und irgendwann
kauft sie jemand — niemand erwartet dort die Sofortbestätigung eines Gegenübers.

Das heißt: Das Offline-Modell **passt zum Genre, statt dagegen zu arbeiten.** Der gefühlte
Verlust ist viel kleiner, als „Handel geht offline nicht" klingt.

### Was ehrlich online-only bleibt

- Live-Auktionen mit Echtzeit-Geboten
- „Wer zuerst kommt"-Limitware, Flash Sales
- Alles, wo **Gleichzeitigkeit selbst das Spielelement** ist

Das ist kein Kompromiss, sondern korrekt: Gleichzeitigkeit braucht nun mal eine Verbindung.

---

## 9. Reconciliation & Rollback (UX)

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

### Die wichtigste Weiche: illegal ≠ divergent

Determinismus wird nie 100 % erreicht. Deshalb braucht das System einen Plan für den
Restfall — und der darf **nicht** derselbe sein wie der Plan für Cheater. Es gibt genau
zwei Fälle, und sie werden strikt getrennt behandelt:

| Fall | Was der Server sieht | Reaktion |
| --- | --- | --- |
| **Log ist illegal** | Ein Command verletzt die Regeln oder das Zeitbudget | **Rollback.** Das ist der beabsichtigte Cheat-Pfad. |
| **Log ist legal, Hash weicht ab** | Alle Aktionen erlaubt, aber Client-Zustand ≠ Server-Zustand | **Kein Rollback.** Der Log wird angewandt, der Spieler behält seinen Fortschritt. |

Der zweite Fall ist **immer ein Bug auf unserer Seite**, nie eine Schuld des Spielers: Der
Server hat den Log ja soeben selbst als regelkonform bestätigt. Ihn dafür zurückzusetzen,
wäre die schlimmste Reaktion — genau das Vertrauensproblem aus R1.

### Und selbst „illegal" rollt nicht alles zurück

Auch im Cheat-Pfad wird nicht die ganze Sitzung verworfen. Der Server wendet das **legale
Präfix** an und verwirft erst ab dem ersten Verstoß:

```
Log:  [1 ✓] [2 ✓] [3 ✓] … [198 ✓] [199 ✗ illegal] [200 …]
                                    └── ab hier verworfen
      └──────────── übernommen ────┘
```

Warum das wichtig ist: Ein einziger Fehler ganz hinten im Log — durch einen Client-Bug, eine
Race Condition, eine kaputte Ruleset-Migration — würde sonst eine komplette Offline-Sitzung
kosten. Der Cheat landet trotzdem nicht, denn das illegale Command wird ja gerade nicht
angewandt. Alles *dahinter* fällt mit weg, weil es auf einem Zustand gerechnet wurde, den es
nie gegeben hat.

Das widerspricht der Atomarität aus R8 nicht: Der Sync bleibt **eine** Transaktion, die genau
einmal schreibt. Sie schreibt nur das geprüfte Präfix statt alles-oder-nichts. Ist schon das
erste neue Command illegal, wird gar nichts übernommen.

> **Regel: Ein Hash-Mismatch erzeugt ein Ticket, keine Sanktion.**

Konkret:

- **Divergenz blockiert den Sync nicht.** Der Log wird angewandt, der Server-Zustand ist
  kanonisch, die (typischerweise winzige) Differenz wird still korrigiert.
- **Alarm ins Monitoring**, mit Client-Version, Ruleset-Version, Command-Log und beiden
  Hashes — genug, um den Fall lokal nachzustellen.
- **Keine automatische Entschädigung.** So verlockend „gib dem Spieler die Differenz" klingt:
  Das wäre farmbar, sobald jemand Hash-Mismatches provozieren kann. Echte Vorfälle werden
  operativ entschädigt (Postfach-Kampagne an die betroffene Kohorte), nicht automatisch.
- **Blast Radius eindämmen:** Steigt die Divergenzrate einer Client-Version über einen
  Schwellwert, wird diese Version **quarantänisiert** — kürzere Sync-Intervalle oder
  vorübergehend online-only, bis der Patch draußen ist. Besser ein eingeschränktes Feature
  als eine Kohorte mit kaputten Spielständen.

### Verteidigung in der Tiefe

Weil kein einzelner Mechanismus Determinismus garantiert, stapeln sich fünf Schichten —
alle bis auf die letzte sind im [Prototyp](prototype.md) umgesetzt:

1. **Verhindern:** Integer-only, keine Systemzeit, keine Locale — statisch per CI-Wächter
   erzwungen, nicht per Code-Review-Disziplin.
2. **Beweisen (Einheit):** Die optimierte Produktionsformel wird gegen eine Tick-für-Tick-
   Grundwahrheit gefuzzt.
3. **Beweisen (Sitzung):** Hunderte zufällige Offline-Sitzungen über drei unabhängige
   Rechenwege — fängt Segmentierungsfehler, die Einzelfunktionen nie zeigen.
4. **Beweisen (Plattform):** Golden Vectors — ein festgeschriebener Korpus aus expliziten
   Command-Logs mit erwarteten Endzuständen, den *jede* Plattform abspielen muss. Bewusst
   ohne Seeds, denn ein Seed setzte gleichen PRNG voraus — also genau das, was zu prüfen ist.
5. **Erkennen & eindämmen:** Kanarienvogel-Hash im Sync, Alarm, Quarantäne (siehe oben).

---

## 10. Verbindungsmodell: es gibt keinen Offline-Modus

Die wichtigste Entscheidung in diesem Kapitel ist eine Nicht-Entscheidung:

> **Das Spiel hat nur einen Modus.** Es simuliert immer lokal und schreibt immer Commands in
> eine Queue. Die Verbindung entscheidet ausschließlich darüber, ob der Hintergrund-Sync
> gerade durchkommt.

Zwei Modi bedeuten Übergänge, und Übergänge sind der klassische Ort für Bugs: halb
umgeschaltete Zustände, doppelte Initialisierung, verlorene Eingaben im Moment des Wechsels.
Wenn es nur einen Modus gibt, kann der Übergang nicht schiefgehen — es gibt keinen.

**Der Tunnel ist damit kein Ereignis**, auf das das Spiel reagieren müsste, sondern nur ein
fehlgeschlagener Hintergrund-Request. Kein Reload, kein Dialog, kein Bruch.

### Was die Verbindung tatsächlich beeinflusst

| Anzeige | Bedeutung | Auswirkung aufs Gameplay |
| --- | --- | --- |
| `live` | letzter Sync erfolgreich | — |
| `catching-up` | Sync läuft gerade | — |
| `offline` | letzter Versuch fehlgeschlagen | nur: Online-only-Features ausgegraut (§8) |

Die Spalte rechts ist der Punkt: **In allen drei Zuständen verhält sich das Gameplay
identisch.** Pflanzen, ernten, bauen, NPC-Handel laufen weiter. Nur was die geteilte Welt
braucht, ist grau — und das war ohnehin schon so kategorisiert.

Ebenso wichtig: **Kein Netzwerkaufruf liegt im Gameplay-Pfad.** Der Sync wird nie abgewartet,
bevor der Spieler weitermachen darf. Ein hängender Request kann das Spiel deshalb nicht
blockieren.

### Der wirklich fiese Fall ist nicht „keine Verbindung"

Keine Verbindung ist einfach: Commands bleiben in der Queue, später nochmal senden.

Gefährlich ist die **verlorene Antwort**. Der Request kam an, der Server hat den Batch
angewandt — nur die Antwort ging im Tunnel verloren. Der Client weiß nicht, ob seine Arbeit
angekommen ist, und spielt weiter. Beim nächsten Versuch schickt er ab seinem alten Stand,
inklusive der Commands, die längst drin sind.

Ohne Gegenmaßnahme wäre das ununterscheidbar von einem Multi-Device-Fork (R3) — und der
ehrliche Spieler verlöre alles. Die Auflösung:

1. Der Client sendet **immer** ab seinem letzten *bestätigten* Snapshot. Nie raten, ob etwas
   angekommen ist.
2. Der Server vergleicht das überlappende Präfix Command für Command mit dem, was er bereits
   angewandt hat.
3. **Identisch** → dieselbe Arbeit doppelt geschickt. Der Server wendet nur den Rest an
   (*resume*) und meldet Erfolg.
4. **Abweichend** → gleiche Sequenznummern, andere Aktionen → echter Fork, Ablehnung.

Deshalb ist Idempotenz keine Kür: Sie ist genau das, was den Tunnel harmlos macht.

### Nur ein Gerät schreibt (R3)

Zwei Geräte, die vom selben Snapshot aus offline weiterspielen, erzeugen zwangsläufig einen
Fork. Erkennen lässt er sich erst beim Sync — dann ist die Arbeit des zweiten Geräts längst
getan und geht verloren. **Die Warnung kommt bei diesem Weg grundsätzlich zu spät.**

Deshalb hält genau ein Gerät die Offline-Schreibrechte:

- Jedes Gerät hat eine lokale Kennung und schickt sie beim Sync mit.
- Ein zweites Gerät erfährt **beim Verbinden**, dass es nicht dran ist, und sperrt seine
  Aktionen. Es entsteht also gar keine Arbeit, die später verworfen werden müsste.
- Wechseln geht jederzeit per ausdrücklicher **Übernahme** — mit Hinweis darauf, dass nicht
  synchronisierte Arbeit auf dem anderen Gerät verfällt.
- Das abgelöste Gerät erfährt es beim nächsten Sync. Weil ein Gerät mit leerer Warteschlange
  aber gar nichts sendet, fragt der Client den Status zusätzlich regelmäßig nach — sonst
  spielte es fröhlich weiter und liefe erneut in den Verlust.

`FORK_DETECTED` bleibt als letzte Verteidigungslinie bestehen: für Geräte, die nicht am
Verfahren teilnehmen, und für Fälle, die durch die Lücke rutschen.

### Thundering Herd

Wenn ein ICE aus dem Tunnel fährt, kommen mehrere hundert Clients **gleichzeitig** zurück.
Ein festes Retry-Intervall lässt sie alle im selben Millisekundenfenster anklopfen — sie
bauen sich ihre eigene Lastspitze.

Darum: exponentielles Backoff **mit Jitter**. Der Zufallsanteil ist kein Detail, sondern der
eigentliche Zweck — er verteilt die Rückkehr über das Fenster.

### Lastverhalten (R4)

Gemessen mit `npm run bench`, nicht behauptet:

| Messung | Ergebnis |
| --- | --- |
| Kosten vs. Offline-**Dauer** (Log konstant) | **flach** — 1 Stunde und 1 Jahr kosten dasselbe |
| Kosten vs. Command-**Anzahl** | linear, ~0,14 µs pro Command |
| Gegenüber Tick-für-Tick bei 30 Tagen Abwesenheit | ~900× schneller, Abstand wächst mit der Dauer |
| Typischer Sync (60 Commands) | ~8 µs |

Das bestätigt die Aussage aus §7: Ein Sync kostet **O(Commands), nicht O(Offline-Dauer)**. Ein
Spieler, der drei Wochen weg war, ist genauso billig wie einer, der drei Minuten weg war.

Zwei Folgerungen für den Maßstab:

- **Die Re-Simulation ist nicht der Engpass.** Netzwerk, Auth und Persistenz dominieren um
  Größenordnungen. Der Farm-Sim-Teil ist zudem pro Spieler unabhängig, also trivial horizontal
  skalierbar (nach Spieler-ID shardbar, keine spielerübergreifenden Sperren).
- **Der geteilte Markt ist ein anderes System** mit einer anderen Skalierungsgeschichte — dort
  gibt es echten Wettbewerb um denselben Zustand. Das ist genau die Trennlinie aus §8.

Trotzdem nötig, weil ein Angreifer Logs frei wählen kann: Obergrenzen für Log-Länge und
Sync-Frequenz pro Account (R4).

---

## 11. Grober Tech-Zuschnitt

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

## 12. Monetarisierung ist eine Architekturfrage

Normalerweise steht Monetarisierung nicht im Architekturdokument. Hier schon, weil die
Produktentscheidung direkt an den Determinismus stößt.

> ### Verbindliche Produktregel
>
> **Kein Pay2Win. Echtgeld kauft nie einen Vorteil für einen selbst — wenn Vorteil, dann
> für alle.**

### Was daraus folgt — drei Ebenen, drei Kosten

| Was verkauft wird | Wo es liegt | Technische Kosten |
| --- | --- | --- |
| **Kosmetik** | außerhalb der Sim, undurchsichtiger Datenblock | **null** — kein Determinismus, keine Migration, keine Vektoren |
| **Globaler Boost** | Regelwerk (Ruleset) | R2-Maschinerie, steht bereits |
| **Persönlicher Zeitraffer** | — | verboten (siehe unten) |

Der Glücksfall: Die einzige Fläche, auf der Geld fließt, die keine Sim-Wirkung hat, ist
genau die, die wir ohnehin aus dem deterministischen Zustand heraushalten wollen
(siehe Konzept-Map, „Was NICHT in die Sim gehört"). Der Kosmetik-Shop kostet technisch
nichts.

### Ein globaler Boost ist ein Ruleset-Wechsel

„Weltweit doppelte Wachstumsgeschwindigkeit für 24 Stunden" ist bei uns kein Sonderfall,
sondern exakt das, was wir mit V1→V2 schon durch ein Offline-Fenster migriert haben (R2):
eine neue Regelversion, die jeder Client beim Sync übernimmt.

Damit erbt der Boost aber auch die scharfe Kante der Regelversionierung:

> **Ein Boost wirkt ab dem Sync, nie rückwirkend.**

Anders geht es nicht. Die Offline-Phase wurde vom Client unter der alten Regelversion
gerechnet; sie unter einer neuen nachzurechnen, ist per Definition Divergenz — der Server
würde etwas anderes herausbekommen als das, was der Spieler gesehen hat. Genau der Fall,
gegen den die ganze Architektur gebaut ist.

Das erzeugt eine echte Unfairness: Wer während des 24-Stunden-Fensters im Funkloch sitzt,
bekommt weniger davon ab. Zwei Auswege, und der zweite ist der bessere:

- **Fenster lang genug machen** (≥ 24 h), dann fällt es kaum ins Gewicht. Billig, aber
  ungenau.
- **Boost als Guthaben statt als Zeitfenster.** Der Server schreibt beim Sync ein Kontingent
  gut („20.000 Boost-Ticks"), das im Zustand liegt und sich beim Spielen verbraucht —
  deterministisch, offline nutzbar, und niemand verliert etwas, weil er offline war. Passt
  sauber zum Zeitbudget-Modell aus §4.

  Ehrlich dazu: Das ist eine **neue Mechanik**, keine Datenzeile. Verbrauchendes Guthaben,
  das Timer beeinflusst, muss auf Client und Server bit-für-bit gleich abgerechnet werden —
  also Referenzimplementierung, Fuzz und Golden Vectors wie bei jeder anderen Mechanik.

### Warum der Zeitraffer sowieso nicht zu uns passt

Wartezeit-Abkürzer sind im Genre der Hauptumsatz. Sie fallen hier aus zwei unabhängigen
Gründen weg, und der zweite gilt auch ohne die Produktregel:

1. Sie sind per Definition ein Vorteil für einen selbst.
2. **Ein Kauf ist online-only.** Zahlungsprüfung braucht den Server. Der Zeitraffer wäre
   also ausgerechnet das Feature, das im Funkloch nicht funktioniert — entweder man lässt
   ihn offline zu (unverifizierter Kauf, direkte Cheat-Fläche) oder man graut ihn aus (ein
   bezahltes Feature, das genau dann fehlt, wenn Wartezeit am meisten stört).

Die Produktregel löst hier einen Konflikt auf, den wir sonst hätten designen müssen. Sie
ist trotzdem nicht gratis: Sie streicht den größten Umsatzhebel des Genres. Das ist eine
bewusste Wette auf Reichweite statt auf Wale — kein technisches Detail.

### Folgen fürs Balancing

Ohne Zeitraffer fehlt der übliche Druckablass am Lagerlimit (§7). Die Senke selbst ist
intakt — Münzen fließen über Ausbauten ab —, aber der Dringlichkeitsaufschlag fällt weg.
Heißt: Lagerausbau muss über den Spielfluss begehrenswert sein, nicht über Frust.
Balancing-Arbeit, kein Blocker.

---

## 13. Offene Fragen / nächste Schritte

- [ ] Tick-Auflösung festlegen (1s? 1min?) — Trade-off Präzision vs. Log-Größe.
- [ ] Command-Set definieren (die vollständige Liste erlaubter Aktionen ist die eigentliche
      „Regel" des Spiels).
- [ ] Konkrete Sim-Sprache/Portabilität wählen (§11).
- [ ] Verhalten am Lagerlimit festlegen (hard block / waste / soft-cap, §7).
- [ ] Postfach: Kapazität, Ablauffrist, UI fürs Abholen (§7).
- [ ] Auftrags-Slots: Anzahl, Freischaltung, Stapelgröße pro Slot (§8).
- [ ] Preisbänder + Gebührenmodell (Einstell- vs. Haltegebühr) festlegen (§8).
- [ ] Snapshot-Format + Signaturschema.
- [ ] Offline-Deckel (§4) und Balancing-Regeln.
- [ ] Konfliktdarstellung im UI (Sync-Animation statt hartem Rollback).
- [x] ~~Prototyp: „Feld pflanzen → wachsen → ernten" end-to-end mit vollem Sync-Zyklus~~ →
      erledigt, siehe [prototype.md](prototype.md). Determinismus, Zeitautorität und
      Lagerlimit sind am laufenden Code geprüft.
- [ ] Denselben Sim-Kern auf einer Mobile-Runtime fuzzen (Plattform-Determinismus).

> ⚠️ Vor dem Bauen: die Schwachstellen-Analyse in **[risks.md](risks.md)** lesen. Besonders
> R1 (Determinismus-Bugs treffen ehrliche Spieler) und R2 (Sim-Versionierung vs. Live-Service)
> sind der Grund, warum der erste Meilenstein ein *Determinismus-Beweis* sein muss, kein Feature.

---

*Dieses Konzept kombiniert bekannte Muster (deterministische Lockstep-Simulation aus RTS-
Games + Server-Reconciliation aus Multiplayer-Netcode) zu etwas, das so als nahtloses
Offline-Live-Service-Farmgame selten bis nie gebaut wurde. Der Aufwand steckt in
Determinismus-Disziplin und Zeit-Autorität — beides lösbar, wenn man es von Anfang an
mitdenkt.*

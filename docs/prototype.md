# Determinismus-Prototyp

Lauffähiger Mini-Sim-Kern, der die riskanteste Annahme des Konzepts prüft:
**Rechnen Client und Server wirklich bit-für-bit dasselbe?** (Risiko R1)

```bash
npm test        # 96 Tests, keine Dependencies, kein Build-Step
npm run bench   # Lastmessung der Server-Re-Simulation (R4)
npm run golden  # Golden Vectors neu erzeugen (bewusste Handlung, siehe unten)
npm run conformance  # Prüfstand- und Feldtest-Seite bauen
npm start       # Feldtest-Server (siehe docs/deploy.md)
```

Läuft direkt mit Node ≥ 22.6 über natives Type-Stripping.

---

## Was drin ist

```
src/sim/          Der Sim-Kern — läuft IDENTISCH auf Client und Server
  rules.ts        Regelwerk UND Inhalt als versionierte Daten (R2)
  state.ts        Zustand, ausschließlich Integer, Inventar als Zahlenarray
  produce.ts      Gedeckelte passive Produktion, geschlossene Form (§7)
  commands.ts     Das Command-Set = das Regelwerk des Spiels (§2.1)
  migrate.ts      Ruleset-Migration + Invariantenprüfung (R2)
  canonical.ts    Kanonische Form — ohne Krypto, läuft in jeder Runtime
  sim.ts          simulate(state, command) — die eine reine Funktion
  hash.ts         Zustands- und Batch-Hashes (Kanarienvogel, R1)

src/client/
  client.ts       Optimistisches Offline-Spiel + Command-Queue
  sync-engine.ts  Verbindungsmodell: Backoff, Jitter, Wiederaufsetzen (§10)
src/server/
  server.ts       Zeitautorität, Re-Simulation, Präfix-Commit, Snapshot
  http.ts         Feldtest-Server: HTTP-API + Handy-Client, ohne Abhängigkeiten
  store.ts        Persistenz — atomar geschriebene JSON-Datei

scripts/          Golden-Vector-Generator, Lastmessung, Seiten-Build
web/              Vorlagen für Prüfstand, Feldtest und Werkbank
test/vectors/     Der Golden-Vector-Korpus (generiert, nicht von Hand pflegen)
```

Modelliert ist das Nötigste, um die Mechanik echt zu belasten: Produktionsplätze
mit Rezept und Wartezeit, passive Produzenten mit *gedeckelter Produktion*, ein
Lagerlimit über alle Waren, NPC-Verkauf sowie Verkaufsaufträge mit Escrow,
Preisband und Ablauffrist — plus ein Postfach für verfallene Aufträge und
externe Zustellungen.

### Inhalt ist eine Tabelle

Der Sim-Kern kennt **keinen Weizen und keine Eier**. Er kennt Katalogindizes,
Rezepte und Plätze — alles aus dem Regelwerk. Der Zustand hält ein Inventar als
Zahlenarray in Katalogreihenfolge, ein Platz merkt sich eine Rezeptnummer.

Der Gewinn zeigt sich an Mühle und Bäckerei: Die Kette Weizen → Mehl → Brot
hat **keine Zeile Sim-Code gekostet**. Eine Werkstatt ist ein Platz mit
Eingaben; die Kette entsteht daraus, dass die Ausgabe des einen die Eingabe
des anderen ist. Dieselbe Mechanik trägt Feld, Tier und Maschine
(Konzept-Map, M1).

Der Preis dafür steht in `rules.ts` und wird von `rules.test.ts` erzwungen:
**Kataloge sind append-only.** Zustände speichern Indizes; wer einen Eintrag
einschiebt, macht aus gespeichertem Weizen stillschweigend Mehl.

---

## Was der Prototyp beweist

Die fünf Verteidigungsschichten gegen R1 aus §9 — Schicht 1 bis 4 sind hier real,
Schicht 5 ist im Server angelegt:

| Schicht | Test | Aussage |
| --- | --- | --- |
| **1 Verhindern** | `sim-purity.test.ts` | Ein CI-Wächter liest den Sim-Quelltext und blockiert Floats, Systemzeit, Locale, `for…in` und ungeschützte Division. Ein zweiter Test prüft, dass der Wächter selbst noch beißt. |
| **2 Beweisen (Einheit)** | `produce.test.ts` | Die geschlossene Produktionsformel stimmt für **40.000 Zufallsfälle** exakt mit einer Tick-für-Tick-Grundwahrheit überein — die Hälfte davon mit *mehreren* Produzenten am selben Lagerdeckel. |
| **3 Beweisen (Sitzung)** | `session-fuzz.test.ts` | **350 zufällige Offline-Sitzungen** in zwei Profilen (viele Aktionen / lange Sprünge) über **alle vier Kataloge**, jede über drei unabhängige Rechenwege — inklusive Aufträgen, Verfall und Postfach. Fängt Segmentierungsfehler, die Einzelfunktionen nie zeigen. |
| **4 Beweisen (Plattform)** | `golden.test.ts` | **119 Golden Vectors, 1436 Commands** über **alle vier Regelversionen** mit festgeschriebenen Endzuständen — der Korpus, den der Mobile-Port an Tag eins abspielt. |
| **5 Erkennen** | `sync.test.ts` | Der Kanarienvogel-Hash schlägt bei Divergenz an — und blockiert den Sync **nicht**. |
| — | `determinism.test.ts` | Eine handgeschriebene Sitzung über drei Wege, als lesbares Beispiel des Gesamtflusses. |
| — | `time-authority.test.ts` | Vorgestellte Geräteuhr → Rollback. Ehrliches Warten → übernommen. Idle und Offline-Spiel sind nachweislich gleichwertig. |
| — | `capacity.test.ts` | Das Lagerlimit ist offline nicht überschreitbar; der Stall stallt und bunkert keine Zeit. |
| — | `sync.test.ts` | Präfix-Commit, Idempotenz, Fork-Erkennung, veraltete Regelversion. |
| — | `migration.test.ts` | Zwei Sorten Patch quer durch eine Offline-Phase: ein Zahlen-Patch (v1→v2) und ein **Inhalts-Patch (v2→v3), bei dem der Zustand wächst** — Log unter alter Version validiert, Zustand danach gehoben, laufende Produktion fair umgerechnet, Version nicht frei wählbar. |
| — | `rules.test.ts` | Jeder Katalog ist widerspruchsfrei, und **Kataloge wachsen nur hinten** — die Invariante, ohne die gespeicherte Indizes ihre Bedeutung verlieren. |
| — | `trading.test.ts` | Escrow, Auftrags-Slots, Preisbänder, Verfall ins Postfach, externe Zustellungen — und der Stash-Exploit als Sättigungstest. |
| — | `connectivity.test.ts` | Der Tunnel-Test: Verbindungsverlust, **verlorene Antwort mit Weiterspielen**, Fork über die Engine, und 500 Clients, die gleichzeitig den Tunnel verlassen. |

Die Fuzz-Tests zählen mit, ob sie die kritischen Zustände überhaupt erreichen (volles Lager,
abgelehnte Aktionen) und schlagen fehl, wenn nicht. Ein Fuzz, der nur Sonnenschein testet,
beweist sonst nichts — und genau das war beim ersten Lauf der Fall.

### Der Prüfstand für fremde Engines

`npm run conformance` erzeugt `dist/conformance.html`: eine vollständig eigenständige Seite
(kein einziger Netzwerkzugriff), die den Korpus in der JS-Engine des jeweiligen Geräts
abspielt. Öffnet man sie in Safari auf iPhone oder iPad, läuft der Sim-Kern in
**JavaScriptCore** statt V8 — anderer Compiler, andere Optimierungen. Genau dieser
Engine-Wechsel ist der Test, der in Node prinzipiell nicht möglich ist.

Der Bundle wird aus denselben Quelldateien gebaut, die Client und Server benutzen — ein
nachgebauter Sim-Kern würde exakt das Risiko einführen, das geprüft werden soll.
`conformance-bundle.test.ts` baut ihn deshalb bei jedem Testlauf neu, führt ihn isoliert aus
und verlangt dieselben Ergebnisse. Ein grünes iPad ist nur dann etwas wert.

Verglichen wird die **kanonische Form**, nicht ein Hash: Sie ist die eigentliche
deterministische Größe und braucht keine Krypto-API der Plattform.

### Ergebnis: zwei Engine-Familien stimmen überein

| Engine | Runtime | Plattform | Vektoren | Zeit |
| --- | --- | --- | --- | --- |
| **V8** | Node 22 / Chromium | Linux | 30 / 30 | ~9 ms |
| **JavaScriptCore** | WKWebView | iPadOS | 30 / 30 | ~1 ms |

Zwei unabhängig entwickelte Engines mit unterschiedlichen Compilern und
Optimierungsstrategien liefern für denselben Command-Log **bit-für-bit dieselben
Endzustände**. Das ist der Beleg, den Node allein prinzipiell nicht liefern kann.

Nicht abgedeckt bleibt **SpiderMonkey** (Firefox) als dritte große Familie — auf iOS und
iPadOS läuft auch Firefox auf WebKit, dafür braucht es also einen Desktop. Und der
Integer-only-Ansatz macht Abweichungen ohnehin unwahrscheinlich: Die klassischen
Engine-Unterschiede liegen bei Fließkomma, Locale und Iterationsreihenfolge — alles Dinge,
die der CI-Wächter im Sim-Kern gar nicht erst zulässt.

### Golden Vectors

`test/vectors/golden.json` enthält **explizite Command-Logs**, keine Seeds. Das ist Absicht:
Ein Seed setzte voraus, dass fremde Plattformen denselben PRNG bitgenau reproduzieren — also
exakt die Annahme, die der Korpus prüfen soll.

Neu erzeugen (`npm run golden`) ist eine **bewusste Handlung**. Verschieben sich Hashes, ohne
dass jemand die Regeln absichtlich geändert hat, ist das der gesuchte Determinismus-Bug. Eine
echte Regeländerung gehört in eine neue Ruleset-Version (R2) — nicht in überschriebene Vektoren.

---

## Gemessenes Lastverhalten (R4)

`npm run bench`, auf einem Kern:

| Messung | Ergebnis |
| --- | --- |
| Kosten vs. Offline-**Dauer**, Log konstant | **flach** — 1 Stunde ≈ 1 Jahr ≈ ~15 µs |
| Kosten vs. Command-**Anzahl** | linear, ~0,1 µs pro Command |
| Kosten vs. **Spielgröße** | 600 Objekte ≈ 42 µs, 3000 ≈ 182 µs |
| Gegenüber Tick-für-Tick bei 30 Tagen offline | ~22.000× schneller |
| Typischer Sync (60 Commands) | ~6 µs, also ~160.000 Syncs/s pro Kern |

> **Ehrlich zur Vorher-Messung:** Vor dem Umbau auf datengetriebenen Inhalt lag
> der typische Sync bei ~4 µs (~220.000/s). Der Katalog kostet also rund die
> Hälfte obendrauf: Ein Inventar-Array muss durchlaufen werden, wo vorher zwei
> Zahlen addiert wurden, und jedes Command legt kleine Arrays an. Ein
> Zwischenspeicher für die abgeleiteten Katalogtabellen holte einen Teil zurück
> (7,1 → 6,1 µs). Die *Form* der Kurven ist unverändert — flach in der Dauer,
> linear in den Commands —, und 160.000 Syncs pro Sekunde und Kern sind für
> jede realistische Spielerzahl weit jenseits des Bedarfs.

Damit ist die Behauptung aus §7 belegt: **O(Commands), nicht O(Offline-Dauer).** Die
Re-Simulation ist nicht der Engpass — Netzwerk und Persistenz dominieren um Größenordnungen.

### Skaliert das auch für ein großes Spiel?

Die Frage ist nicht „wie viele Features", sondern **wie viel Zustand ein einzelnes Command
anfasst**. Ein Feld reift nicht „mit": Ob es fertig ist, ergibt sich beim Lesen aus
`(startedAt, jetzt)`. Nur echte Fließproduktion wird fortgeschrieben, und die in
geschlossener Form.

Die Messung deckte dabei einen Engpass auf, den die Theorie nicht hatte: Der Sync war
**linear in der Spielgröße**, weil jedes Command den ganzen Zustand tiefkopierte — bei sechs
Feldern unsichtbar, bei 3000 Objekten 2 ms. Zustände teilen sich ihre Arrays jetzt und
ersetzen nur das geänderte Element; das brachte Faktor 11.

Ehrlich bleibt: Ganz flach ist es nicht. Ein Array-Ersetzen kopiert weiterhin Referenzen,
also `O(Commands × Objekte)` mit sehr kleinem Faktor. Für Größenordnungen, die ein Farmgame
je erreicht, sind das zweistellige Mikrosekunden. Wirklich flach würde es erst mit
persistenten Datenstrukturen — lohnt sich, sobald ein Spielstand Zehntausende Objekte trägt.

**Was mit der Komplexität wirklich wächst, ist nicht die Rechenzeit, sondern die
Determinismus-Fläche.** Jedes Feature ist eine neue Gelegenheit, dass Client und Server
auseinanderlaufen. Das ist die eigentliche Steuer auf diesem Ansatz — und sie fällt pro
Feature an, dauerhaft.

---

## Vier echte Bugs, die die Tests gefunden haben

Alle vier wären in Produktion genau das Szenario aus R1 gewesen — **ehrliche Spieler
verlieren Fortschritt** —, und keiner war beim Lesen des Codes sichtbar.

### 1. Off-by-one am Lagerlimit

Die geschlossene Form prüfte `wanted <= space` als „passt locker". Im Gleichstand
`wanted === space` füllt aber das letzte Ei das Lager exakt auf — die restliche
Zeit muss verfallen, nicht angespart werden.

Der Fuzz fand den Fall `elapsed=7604, progress=313, space=8, interval=932`:
461 Ticks Fortschritt aus dem Nichts. Ein Client mit dieser Version und ein
Server ohne sie hätten sich lautlos auseinanderentwickelt.

Nachtrag aus Phase 1: Beim Verallgemeinern auf **mehrere** passive Produzenten
stand exakt dieselbe Grenze noch einmal zur Wahl — und war im ersten Wurf wieder
falsch gesetzt. Der Regressionstest mit denselben Zahlen hat sie sofort gemeldet.

### 2. `seq` allein unterscheidet Replay nicht von Fork

Die Idempotenz-Prüfung hing an der Sequenznummer: „schon angewandt → No-op".
Zwei Geräte, die vom **selben Snapshot** aus offline gehen, vergeben aber
zwangsläufig dieselben Nummern für völlig verschiedene Aktionen (R3).

Ergebnis: Das zweite Gerät bekam ein fröhliches „alles gut" — und seine gesamte
Offline-Arbeit verschwand kommentarlos. Die Prüfung hängt jetzt am **Inhalt**
des Batches, nicht an der Nummer.

### 4. Der Server lief der Zeitachse des Clients davon

Gefunden vom **echten** Feldtest über HTTP — kein Unit-Test hatte es gezeigt.

Der Server schrieb seinen Zustand beim Sync bis „jetzt" fort. Nach einer verlorenen Antwort
datierte der ahnungslos weiterspielende Client seine nächsten Commands auf Ticks, die der
Server längst hinter sich hatte — und bekam `TIME_WENT_BACKWARDS`. Der ehrliche Spieler
verlor seine Sitzung.

Die bestehenden Tests trafen das nicht, weil sie zwischen den Aktionen großzügig die Uhr
vorstellten. Im echten Betrieb tippt man einfach zweimal hintereinander.

Ursache war ein Modellfehler: Passive Produktion ist eine *abgeleitete* Größe. Sie eifrig
festzuschreiben bringt den Server der Zeitachse des Clients voraus. Der Zustand bleibt jetzt
beim letzten Command stehen, und `serverTs` wird nur um die tatsächlich verbrauchten Ticks
weitergestellt — die ungenutzte Realzeit bleibt dem Spieler erhalten.

### 3. Verlorene Antwort war von einem Fork ununterscheidbar

Gefunden beim Durchdenken des Tunnel-Szenarios, bevor eine Zeile Code dazu existierte.

Der Server wendet einen Batch an, die Antwort geht unterwegs verloren, der Spieler spielt
weiter. Der Client schickt nun ab seinem alten `baseSeq` — inklusive der Commands, die längst
drin sind, plus neue. Die damalige Prüfung sah nur „`baseSeq` passt nicht zum Snapshot" und
lehnte **den kompletten Log** ab. Ein ehrlicher Spieler mit schlechtem Empfang hätte damit
zuverlässig seine Offline-Sitzung verloren.

Der Server vergleicht jetzt das überlappende Präfix Command für Command: identisch ⇒ dieselbe
Arbeit doppelt geschickt, nur den Rest anwenden (*resume*). Abweichend ⇒ echter Fork.

> **Die Lehre:** R1 ist keine theoretische Sorge. In sehr bewusst geschriebenem Code steckten
> vier Fehler, die alle **ehrliche Spieler** getroffen hätten — und keiner war beim Lesen
> sichtbar. Zwei fand der Fuzz, einen das Durchdenken eines realen Szenarios, und einen erst
> der Betrieb über echtes HTTP. Jede Methode fand etwas, das die anderen übersahen — deshalb
> gehören alle drei von Tag eins in die Routine, nicht ans Ende.
>
> Der Umbau auf datengetriebenen Inhalt (Phase 1) hat das bestätigt: Er berührte
> jede Datei des Sim-Kerns, und die einzige Stelle, an der dabei wirklich etwas
> kaputtging, war genau der Off-by-one von oben — sofort gemeldet vom
> Regressionstest mit denselben vier Zahlen. Deshalb sind alte Bugs als Test
> mehr wert als in einem Changelog.

---

## Feldtest auf echter Hardware

Server auf einem 1-GB-VPS, Client auf iPhone und iPad über Mobilfunk. Alle Fälle aus
[deploy.md](deploy.md) von Hand durchgespielt:

| Fall | Ergebnis |
| --- | --- |
| **Tunnel** | Postfach geleert, zwei Aufträge eingestellt, alles im Funkloch — danach `Sync ok, bestätigt bis seq 50`. Nichts verloren, nichts doppelt. |
| **Backoff** | 2 s → 4 s → 15 s → 28 s statt Dauerfeuer. |
| **Regeln offline** | `SILO_FULL` beim Postfach-Leeren kam **vom Client ohne Server** — das Lagerlimit greift ohne Verbindung (§7). |
| **Escrow** | Zwei Aufträge nahmen 77 Waren aus dem Lager; Postfach behielt, was nicht passte. |
| **Zwei Geräte** | `FORK_DETECTED` korrekt ausgelöst — und war der Anlass für das Aktiv-Gerät-Token. |
| **Neustart** | Spielstand unverändert. |
| **Balance-Patch live** | v1 → v3 an einem laufenden Spielstand, laufende Felder fair umgerechnet. |

> Zu den Versionsnummern: Der Feldtest lief mit dem damaligen v3 (schnelle Uhren).
> Seit Phase 1 ist das v4 — v3 ist jetzt der Inhalts-Patch. Der Feldtest-Ruleset
> trägt den vollen Inhalt inklusive Mühle und Bäckerei.

Der wichtigste Eindruck lässt sich nicht als Zahl festhalten: **Während des Funklochs fühlt
sich nichts anders an.** Kein Dialog, kein Reload, kein Hänger — nur ein Statuspunkt, der die
Farbe wechselt.

---

## Was der Prototyp NICHT beweist

Ehrlichkeitshalber, damit niemand mehr hineinliest, als drinsteht:

- **Der geteilte Markt selbst.** Aufträge, Escrow und Postfach existieren, aber
  das *Füllen* eines Auftrags ist online-only und hier nur als serverseitige
  Zustellung modelliert. Kein Orderbuch, keine Nachbarn, kein Zufall (§5).
- **Dass Inhalt jetzt wirklich billig ist**, gilt für die *Mechaniken, die es
  gibt*. Eine neue Feldfrucht, ein neues Rezept, eine neue Werkstatt, ein
  weiteres Feld: Tabellenzeile. Aufträge erfüllen, Ausbauten, Level und Zufall
  (M6–M9 der Konzept-Map) sind dagegen neue **Mechaniken** — die kosten weiter
  Regel, Referenzimplementierung und Golden Vectors.
- **Die App-Hülle offline.** Der Feldtest lädt die Seite vom Server, ein Reload
  im Funkloch schlägt deshalb fehl. Ein Artefakt des Testaufbaus, kein
  Architekturproblem — eine installierte App trägt ihre Hülle lokal. Im Browser
  bräuchte es dafür einen Service Worker, und der verlangt HTTPS.
- **Betrieb im Maßstab.** Der Feldtest-Server speichert in eine JSON-Datei und kennt
  einen einzigen Spielstand. Die reinen Re-Sim-Kosten sind gemessen, Datenbank,
  Accounts und Last unter vielen Spielern nicht.
- **Snapshot-Signatur.** In §9 vorgesehen, hier nicht implementiert — der Server
  hält ohnehin seine eigene Kopie.

---

## Nächste sinnvolle Schritte

1. Aktiv-Gerät-Token gegen den Multi-Device-Fork (R3) — der letzte offene Punkt,
   an dem ehrliche Spieler noch Arbeit verlieren können.

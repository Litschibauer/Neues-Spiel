# Determinismus-Prototyp

Lauffähiger Mini-Sim-Kern, der die riskanteste Annahme des Konzepts prüft:
**Rechnen Client und Server wirklich bit-für-bit dasselbe?** (Risiko R1)

```bash
npm test        # 37 Tests, keine Dependencies, kein Build-Step
npm run bench   # Lastmessung der Server-Re-Simulation (R4)
npm run golden  # Golden Vectors neu erzeugen (bewusste Handlung, siehe unten)
```

Läuft direkt mit Node ≥ 22.6 über natives Type-Stripping.

---

## Was drin ist

```
src/sim/          Der Sim-Kern — läuft IDENTISCH auf Client und Server
  rules.ts        Regelwerk als versionierte Daten (R2)
  state.ts        Zustand, ausschließlich Integer
  produce.ts      Gedeckelte passive Produktion, geschlossene Form (§7)
  commands.ts     Das Command-Set = das Regelwerk des Spiels (§2.1)
  sim.ts          simulate(state, command) — die eine reine Funktion
  hash.ts         Zustands- und Batch-Hashes (Kanarienvogel, R1)

src/client/
  client.ts       Optimistisches Offline-Spiel + Command-Queue
  sync-engine.ts  Verbindungsmodell: Backoff, Jitter, Wiederaufsetzen (§10)
src/server/       Zeitautorität, Re-Simulation, Präfix-Commit, Snapshot

scripts/          Golden-Vector-Generator + Lastmessung
test/vectors/     Der Golden-Vector-Korpus (generiert, nicht von Hand pflegen)
```

Modelliert ist das Nötigste, um die Mechanik echt zu belasten: Felder mit
Wachstumszeit, ein Hühnerstall mit *gedeckelter passiver Produktion*, ein
Lagerlimit über alle Waren und NPC-Verkauf.

---

## Was der Prototyp beweist

Die fünf Verteidigungsschichten gegen R1 aus §9 — Schicht 1 bis 4 sind hier real,
Schicht 5 ist im Server angelegt:

| Schicht | Test | Aussage |
| --- | --- | --- |
| **1 Verhindern** | `sim-purity.test.ts` | Ein CI-Wächter liest den Sim-Quelltext und blockiert Floats, Systemzeit, Locale, `for…in` und ungeschützte Division. Ein zweiter Test prüft, dass der Wächter selbst noch beißt. |
| **2 Beweisen (Einheit)** | `produce.test.ts` | Die geschlossene Produktionsformel stimmt für **20.000 Zufallsfälle** exakt mit einer Tick-für-Tick-Grundwahrheit überein. |
| **3 Beweisen (Sitzung)** | `session-fuzz.test.ts` | **350 zufällige Offline-Sitzungen** in zwei Profilen (viele Aktionen / lange Sprünge), jede über drei unabhängige Rechenwege. Fängt Segmentierungsfehler, die Einzelfunktionen nie zeigen. |
| **4 Beweisen (Plattform)** | `golden.test.ts` | **20 Golden Vectors, 166 Commands** mit festgeschriebenen Endzuständen — der Korpus, den der Mobile-Port an Tag eins abspielt. |
| **5 Erkennen** | `sync.test.ts` | Der Kanarienvogel-Hash schlägt bei Divergenz an — und blockiert den Sync **nicht**. |
| — | `determinism.test.ts` | Eine handgeschriebene Sitzung über drei Wege, als lesbares Beispiel des Gesamtflusses. |
| — | `time-authority.test.ts` | Vorgestellte Geräteuhr → Rollback. Ehrliches Warten → übernommen. Idle und Offline-Spiel sind nachweislich gleichwertig. |
| — | `capacity.test.ts` | Das Lagerlimit ist offline nicht überschreitbar; der Stall stallt und bunkert keine Zeit. |
| — | `sync.test.ts` | Präfix-Commit, Idempotenz, Fork-Erkennung, veraltete Regelversion. |
| — | `connectivity.test.ts` | Der Tunnel-Test: Verbindungsverlust, **verlorene Antwort mit Weiterspielen**, Fork über die Engine, und 500 Clients, die gleichzeitig den Tunnel verlassen. |

Die Fuzz-Tests zählen mit, ob sie die kritischen Zustände überhaupt erreichen (volles Lager,
abgelehnte Aktionen) und schlagen fehl, wenn nicht. Ein Fuzz, der nur Sonnenschein testet,
beweist sonst nichts — und genau das war beim ersten Lauf der Fall.

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
| Kosten vs. Command-**Anzahl** | linear, ~0,14 µs pro Command |
| Gegenüber Tick-für-Tick bei 30 Tagen offline | ~900× schneller |
| Typischer Sync (60 Commands) | ~8 µs, also ~120.000 Syncs/s pro Kern |

Damit ist die Behauptung aus §7 belegt: **O(Commands), nicht O(Offline-Dauer).** Die
Re-Simulation ist nicht der Engpass — Netzwerk und Persistenz dominieren um Größenordnungen.

---

## Drei echte Bugs, die die Tests gefunden haben

Beide wären in Produktion genau das Szenario aus R1 gewesen — **ehrliche Spieler
verlieren Fortschritt** —, und beide waren beim Lesen des Codes unsichtbar.

### 1. Off-by-one am Lagerlimit

Die geschlossene Form prüfte `wanted <= space` als „passt locker". Im Gleichstand
`wanted === space` füllt aber das letzte Ei das Lager exakt auf — die restliche
Zeit muss verfallen, nicht angespart werden.

Der Fuzz fand den Fall `elapsed=7604, progress=313, space=8, ticksPerEgg=932`:
461 Ticks Fortschritt aus dem Nichts. Ein Client mit dieser Version und ein
Server ohne sie hätten sich lautlos auseinanderentwickelt.

### 2. `seq` allein unterscheidet Replay nicht von Fork

Die Idempotenz-Prüfung hing an der Sequenznummer: „schon angewandt → No-op".
Zwei Geräte, die vom **selben Snapshot** aus offline gehen, vergeben aber
zwangsläufig dieselben Nummern für völlig verschiedene Aktionen (R3).

Ergebnis: Das zweite Gerät bekam ein fröhliches „alles gut" — und seine gesamte
Offline-Arbeit verschwand kommentarlos. Die Prüfung hängt jetzt am **Inhalt**
des Batches, nicht an der Nummer.

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
> drei Fehler, die alle **ehrliche Spieler** getroffen hätten — und keiner war beim Lesen
> sichtbar. Zwei fand der Fuzz, einen das Durchspielen eines realen Szenarios (Zug, Tunnel,
> kein Empfang). Beide Methoden gehören von Tag eins in die Routine, nicht ans Ende.

---

## Was der Prototyp NICHT beweist

Ehrlichkeitshalber, damit niemand mehr hineinliest, als drinsteht:

- **Plattform-Determinismus.** Alles läuft hier in einer Node-Runtime. Der echte
  Test ist derselbe Kern auf iOS, Android und Server. Integer-only macht das
  wahrscheinlich, aber bewiesen ist es damit nicht. Die Golden Vectors machen
  diesen Beweis *führbar* — sie ersetzen ihn nicht.
- **Ruleset-Migration (R2).** Versionierung ist vorgesehen und wird geprüft, aber
  es existiert nur eine Version — echte Balance-Patches sind ungetestet.
- **Alles Geteilte.** Kein Markt, keine Nachbarn, kein Zufall, kein Escrow, kein
  Postfach. Also nichts aus §5 und §8.
- **Persistenz.** Der Server hält Zustand und Command-Log im Speicher. Die reinen
  Re-Sim-Kosten sind gemessen (siehe oben), Datenbank und Netzwerk nicht.
- **Snapshot-Signatur.** In §9 vorgesehen, hier nicht implementiert — der Server
  hält ohnehin seine eigene Kopie.

---

## Nächste sinnvolle Schritte

1. Denselben Kern nach WASM oder in eine Mobile-Runtime bringen und dort
   `test/vectors/golden.json` abspielen — der echte Plattform-Beweis, und dank
   der Vektoren nur noch ein Nachmittag Arbeit statt eines Projekts.
2. Ein zweites Ruleset einziehen und eine Migration durchspielen (R2).
3. Escrow, Auftrags-Slots und Postfach ergänzen, dann die Behälter-Invariante
   aus §7 als Test formulieren: *Summe aller Behälter ist beschränkt.*

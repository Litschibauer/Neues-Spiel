# Determinismus-Prototyp

Lauffähiger Mini-Sim-Kern, der die riskanteste Annahme des Konzepts prüft:
**Rechnen Client und Server wirklich bit-für-bit dasselbe?** (Risiko R1)

```bash
npm test        # 29 Tests, keine Dependencies, kein Build-Step
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

src/client/       Optimistisches Offline-Spiel + Command-Queue
src/server/       Zeitautorität, Re-Simulation, Snapshot, Rollback

scripts/          Generator für die Golden Vectors
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
| — | `sync.test.ts` | Sync ist atomar und idempotent; Fork und veraltete Regelversion werden erkannt. |

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

## Zwei echte Bugs, die die Tests gefunden haben

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
des Batches (`hashCommands`), nicht an der Nummer.

> **Die Lehre:** R1 ist keine theoretische Sorge. In ~400 Zeilen sehr bewusst
> geschriebenem Code steckten zwei Divergenzen. Die Fuzz- und
> Referenz-Tests sind deshalb kein Extra, sondern Teil der Architektur —
> sie gehören von Tag eins in die CI.

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
- **Persistenz und Maßstab.** Der Server hält den Zustand im Speicher. Re-Sim-
  Kosten unter Last (R4) sind nicht gemessen.
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

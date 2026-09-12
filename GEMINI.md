# Für alle, die hier arbeiten

Lies zuerst **docs/vorgehen.md**. Dort stehen die Regeln, die nicht brechen
dürfen (reine Simulation, eingefrorene Regelwerke, Golden Vectors), der Ablauf
einer Änderung und alle Prüfungen.

Das Wichtigste in Kürze:

- Branch: `claude/live-service-game-concept-m4ymol`. Ein grüner Push ist ein
  Deploy: Der Server lässt vor dem Wechsel `npm test` laufen.
- `src/sim/` ist rein, ganzzahlig, deterministisch. Regelwerke nur anhängen,
  nie ändern. Neues Regelwerk → Dev-Regelwerk 1001 neu aufsetzen → Migration
  → `npm run golden` und alte Vektoren vergleichen.
- Prüfen vor dem Push: `npm test`, `npm run build`, `npm run offlinetest`
  (Ausgabe in eine Datei), Screenshots anschauen.
- Oberfläche: Deutsch, Pixel-Retro, keine Systemfenster (`alert`/`confirm`/
  `prompt`), alles in einer IIFE — auf doppelte Bezeichner achten.
- Keine Zugangsdaten in Chats oder Dateien; keine Modell-/KI-Kennungen in
  Commits oder Code. Kein Bezahlinhalt.
- Der Kern bleibt ohne Abhängigkeiten; `ios-app/` ist getrennt.

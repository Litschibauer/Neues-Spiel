# Wie an diesem Spiel gearbeitet wird

Für alle, die hier weitermachen — Mensch oder KI, mit oder ohne Vorwissen.
Dieses Dokument beschreibt nicht *was* das Spiel ist (das steht in
[architecture.md](architecture.md) und [konzept-map.md](konzept-map.md)),
sondern *wie* daran gearbeitet wird: welche Regeln nicht brechen dürfen, wie
eine Änderung von der Idee bis zum Push läuft, und womit alles geprüft wird.

Wenn du nur eine Sache liest, lies **Abschnitt 2**. Wer die Regeln dort
verletzt, macht ehrliche Spieler kaputt — leise und rückwirkend.

---

## 1. Das Projekt in drei Sätzen

Ein Farmspiel wie Hay Day, mobile-first, auf Deutsch, als Webseite (PWA) und
als iOS-Hülle (Capacitor). Der Server ist die Wahrheit, aber man spielt auch
ohne Netz: Der Client rechnet dieselbe deterministische Simulation wie der
Server und schickt beim nächsten Netz sein Befehlsprotokoll nach; der Server
rechnet es nach und verwirft, was nicht stimmt. Es gibt keinen Ordner voller
Abhängigkeiten: Der Kern läuft mit Node ≥ 22.6 und sonst nichts.

Es gibt **einen** Branch, auf dem gearbeitet wird:
`claude/live-service-game-concept-m4ymol`. Der Server zieht ihn alle zwei
Minuten selbst (`scripts/auto-deploy.sh`), **prüft aber vorher** (die leichte
Suite ohne die drei Golden-Vektor-Schwergewichte) — ein roter Stand kommt
nicht auf den Server; `/health` zeigt unter `deploy`, was der Riegel zuletzt
getan hat. Dieselbe Prüfung zeigt
GitHub als Ampel am Commit (`.github/workflows/pruefung.yml`). Ein grüner
Push ist also ein Deploy; ein roter bleibt liegen, bis der nächste kommt.

---

## 2. Die Regeln, die nicht brechen dürfen

### 2.1 Die Simulation ist rein, ganzzahlig und deterministisch

Alles unter `src/sim/` rechnet auf jedem Gerät bit-für-bit gleich. Deshalb:

- **Kein `Math.random`, kein `Date`, keine Gleitkommazahlen** in `src/sim/`.
  Division nur als `Math.floor(a / b)` auf derselben Zeile. Ein Test
  (`test/sim-purity.test.ts`) liest den Quelltext und schlägt sonst fehl.
- Zufall kommt vom Server als Zahl im Snapshot (Kisten, Fundstücke) — nie aus
  der Simulation selbst.
- Ein Tick ist eine Sekunde. Zeit ist eine Zahl im Zustand, nie die Uhr.

### 2.2 Regelwerke sind eingefroren und nur anhängbar

`src/sim/rules.ts` enthält **alle** Regelwerke, `V1` bis `V<n>`. Jedes ist
`Object.freeze`-Daten. Ein altes Regelwerk wird **nie** geändert — ein
Spielstand auf Version 37 muss in zehn Jahren noch genau so nachrechenbar sein.

Für eine Änderung am Inhalt (neue Ware, neues Gebäude, anderer Preis):

1. Neues Regelwerk `V<n+1> = { ...V<n>, version: n+1, ... }` anhängen.
2. **Indizes sind tragend.** Waren, Rezepte und Plätze werden über ihre
   Position im Array angesprochen. Neues kommt **hinten** dran, nie dazwischen.
3. `LATEST_RULESET_VERSION` und `PRODUCTION_VERSIONS` hochziehen.
4. Das **Dev-Regelwerk `1001`** neu aufsetzen: Es ist das neueste Regelwerk mit
   Sekundenuhren (`zehntel`). Jeder Verweis darin (`...V<n+1>`, `feste`,
   `meisterschaft`, `recipes`, `fishing`, `plots`) muss auf die neue Version
   zeigen. Vergisst man das, testet die Entwicklung gegen das alte Spiel.
5. Einen **Migrationsschritt** in `src/sim/migrate.ts` eintragen
   (`'<n>-><n+1>'`). Meist reicht `AUFS_RASTER`; wenn sich Zustand ändert, eine
   eigene Funktion. `test/migration.test.ts` prüft, dass jede Kette durchläuft.
6. Der **Validator** (`validateRuleset`) läuft in den Tests über jedes
   Regelwerk. Er kennt die Fallen (Startstufe mit Preis, Platz außerhalb des
   Rasters, Rezept ohne Ausgang …). Neue Fallen dort eintragen.

### 2.3 Golden Vectors sind die Abnahme

`test/vectors/golden.json` enthält tausende aufgezeichnete Spielverläufe mit
erwartetem Endzustand, je Regelwerk. `test/golden.test.ts` spielt sie nach.

Nach jeder Änderung an Simulation oder Regelwerk:

```bash
cp test/vectors/golden.json /tmp/golden.alt.json
npm run golden
```

Dann prüfen, dass **nur** das Dev-Regelwerk (1001) und das **neue** Regelwerk
Vektoren geändert oder hinzubekommen haben. Alle Vektoren bestehender
Produktionsversionen müssen byte-identisch sein. Ein kleines Skript dafür:

```ts
const alt = JSON.parse(readFileSync('/tmp/golden.alt.json', 'utf8'));
const neu = JSON.parse(readFileSync('test/vectors/golden.json', 'utf8'));
const key = (v) => `${v.rulesetVersion}|${v.name}`;
const n = new Map(neu.vectors.map((v) => [key(v), v]));
for (const v of alt.vectors) {
  const w = n.get(key(v));
  if (!w || JSON.stringify(v) !== JSON.stringify(w)) console.log('ANDERS', key(v));
}
```

Ändert sich ein alter Vektor, hat man ein altes Regelwerk oder die Simulation
für alte Versionen verändert — das ist ein Fehler, kein „Update". Einzige
Ausnahme: ein neues, **ungehashtes** Zustandsfeld, das im Vektor mit
gespeichert wird; dann vor dem Vergleich beide Seiten um dieses Feld bereinigen
und begründen, warum es nicht in den Hash gehört.

### 2.4 Was gehasht wird, steht in `canonical.ts`

`src/sim/canonical.ts` listet die Felder von Hand, die in die Prüfsumme
eingehen, mit der Client und Server ihre Zustände vergleichen. Ein neues
Zustandsfeld, das das Spiel beeinflusst, **muss** dort hinein — sonst merkt der
Server eine Abweichung nicht. Reine Zähler für Anzeige (Tage, Wochen, Feste)
bleiben draußen. Optionale Felder bedingt anhängen
(`(p.meister ? \`*${p.meister}\` : '')`), damit alte Vektoren gleich bleiben.

### 2.5 Der Server ist die Wahrheit, der Client rechnet vor

- Der Client führt Befehle sofort aus (`src/client/client.ts`), hängt sie an
  eine Warteschlange und schickt sie per `/api/sync`. Der Server
  (`src/server/server.ts`) rechnet nach, vergleicht Hashes und antwortet mit
  seinem Snapshot, den der Client **immer** übernimmt.
- Alles, was von außen in einen Hof kommt (Post, Geschenke, XP für Hilfe,
  Werkbank-Eingriffe, Kisten), geht über `applyExternal` — **nie** direkt in
  den Zustand, sonst divergieren Client und Server.
- Es gibt genau **einen Serverprozess** je Umgebung, der die SQLite-Datei
  schreibt.

### 2.6 Die Oberfläche

- Eine Seite, ein `<script>`: `web/farm/page.html` bindet die Module aus
  `web/farm/*.js` per `<!--INCLUDE:…-->` in **eine** strikte IIFE ein.
  Alles teilt sich einen Namensraum — **doppelte Bezeichner sind der häufigste
  Fehler** beim Hinzufügen einer Datei. `node --check` auf der gebauten Seite
  findet sie (siehe 5.4).
- **Keine Systemfenster.** Kein `alert`, `confirm`, `prompt`. Nachfragen sind
  Knöpfe, die sich selbst erklären und nach ein paar Sekunden zurückfallen
  (`data-sicher`, siehe `abreissen` in `tippen.js`). Der Browsertest
  überschreibt die drei Funktionen und zählt Aufrufe.
- **Deutsch**, in der Sprache des Spiels: Hof, Wagen, Zettel, Brett, Stand,
  Lager. Fachwörter aus der Simulation bleiben Englisch (`plot`, `recipe`).
- **Holz und Papier.** Jedes Blatt ist ein Ort, kein Menü: Holzrahmen mit
  Balken als Titel, darauf angepinntes Papier mit Tinte, Messingknöpfe für
  alles, was etwas bringt. Der Trick steht am Ende von `style.css`: Auf dem
  Holz sind die Farbmarken (`--muted`, `--ink`, `--surface` …) cremefarben,
  auf dem Papier (`.card`, `.note`, `.opt` …) Tinte — ein Baustein muss nichts
  wissen, er liest die Marken. Neue Blätter bekommen die Haut umsonst; ein
  neuer Baustein mit hellem Hintergrund gehört in die Papier-Liste, sonst
  steht Creme auf Creme. Die Kopfzeile ist derselbe Balken, der Hof ein
  gerahmtes Bild, die HUD-Knöpfe tragen Pixelkunst aus dem Spiel (Schlegel,
  Truhe, Zahnrad).
- **Pixel-Retro**: Pixelschrift (`--pixel`), harte Kante (`--tinte`), versetzter
  Schatten, kleine Radien, Knöpfe sinken beim Drücken. Keine Pillen, keine
  weichen Schatten, nichts, das nach Standard-UI aussieht. Neue Sprites sind
  eigene Pixelkunst (`web/farm/sprites/LIZENZ.txt`).
- **Wenig Text.** Ein Satz, wo ein Satz reicht; Zahlen als Zahl, nicht als
  Prosa. Listen werden Dinge: Erfolge sind Abzeichen, die Ehrentafel ein
  Podest, das Baumenü zeigt das Gebäude. Erklärungen je Blatt sind ein
  angepinnter Zettel mit einem Satz (`FEATURE_TIPP` in `start.js`), keine
  Kartenfolge.
- **Klänge sind Aufnahmen, keine Oszillatoren — und leise.** Gemeinfreie
  Geräusche (Kenney: Holz, Stoff, Gras, Glas, Münzen) werden mit
  `scripts/klaenge-mischen.py` zu `web/farm/klaenge/*.wav` gemischt (mono,
  22 kHz, Spitze -5 dB) und beim Bauen eingebettet. Ein neuer Klang: Rezept im
  Skript, Zeile in `klaenge/LIZENZ.txt`, Name in `KLAENGE` in `klang.js`.
  Nichts Synthetisches, keine 8-Bit-Töne, keine Fanfaren: Das Spiel ist ruhig,
  was feiert, tut es mit Glöckchen.
- **Musik ist frei.** Nur CC0-Stücke in `web/musik/`, jedes mit Autor und
  Quelle in `LIZENZ.txt`; ein Test prüft das. Neue Stücke gehen durch
  `scripts/musik-umwandeln.py` (Lautheit angeglichen, 128 kBit/s). Nichts, was
  jemandem gehört — auch nicht „nur zum Testen".
- Keine Monetarisierung, kein Pay-to-win, keine Werbung.
- Desktop-Seite und App bleiben getrennt: Der Kern hat keine Abhängigkeiten,
  `ios-app/` hat sein eigenes `package.json`.

### 2.7 Rund ums Arbeiten

- **Zugangsdaten nie in einen Chat, nie in ein Dokument.** Sagen, *wo* sie
  liegen (`data/prod/token`), nicht *was* drinsteht.
- Keine Modellnamen oder KI-Kennungen in Commits, Kommentaren oder Dateien.
- Committen und pushen, sobald ein Schritt fertig und geprüft ist. Nichts
  Ungeprüftes pushen: Der Server zieht den Branch von selbst.
- Eine Sache je Commit, deutscher Betreff, im Rumpf das *Warum*.

---

## 3. Wo was liegt

```
src/sim/         Die Simulation. rein, deterministisch, ganzzahlig.
  rules.ts         alle Regelwerke V1..Vn + DEV 1001, Validator, Helfer
  state.ts         Zustand, initialState, Zähler (ZAEHLER), Konstanten
  sim.ts           simulate(state, command, rules) — jeder Befehl
  commands.ts      die Befehlstypen
  migrate.ts       Wanderung eines Zustands von Version a nach b
  canonical.ts     was in den Hash eingeht
  hash.ts/sha256   Prüfsumme
src/client/      client.ts (Befehle, Warteschlange, preview), sync-engine.ts
                 (Abgleich, Backoff, Verbindungszustand), view.ts (farmView:
                 die Sicht, aus der die Oberfläche zeichnet), persist.ts
src/server/      http.ts (alle Routen), server.ts (ein Hof: sync,
                 applyExternal, Eingriffe), accounts.ts (Schlüssel, Wort,
                 Bremse), storage.ts + db.ts (SQLite, Migrationen), market.ts,
                 sozial.ts (Hofcode, Freunde), tagesbonus.ts, events.ts (SSE),
                 push.ts/apns.ts, config.ts (Umgebungen, Stand-Erkennung)
web/farm/        Die Oberfläche: page.html (Markup), style.css, *.js Module
  verbindung.js    token, api(), toast, SSE, save/load
  start.js         show(), Tor, Tutorial, Start
  anzeige.js       render(): Hof, Plätze, Lager, Ziele, Einstellungen
  tippen.js        Antippen: Auswahlblätter, Bauen, Abreißen
  raster.js        Raster, Kamera, Sperrzonen, Platzieren
  bilder.js        Pixelkunst als SVG (ART-Tabelle), Boden, Sprites
  nachbarn.js      Freunde, Besuch, fremder Stand
  konto.js         Hof sichern, Wiederherstellung, Löschen, Rückmeldung, Fehler
  fuehrung.js      die geführte Einführung für neue Höfe (Schritte, Spot, Sperre)
  momente.js       Meldungen mit Warteschlange
  texte.js         alle Namen und Texte (auch von der Werkbank benutzt)
  klang.js         Klänge abspielen (Aufnahmen, Tonhöhe je Erntekette)
  icons/ sprites/  Bilder, beim Bauen als Data-URI eingebettet
  klaenge/         die Klänge als WAV (CC0-Quellen, LIZENZ.txt), ebenso eingebettet;
                   gemischt von scripts/klaenge-mischen.py
web/musik/       Hintergrundmusik als MP3, alle CC0 (LIZENZ.txt mit Autor und
                 Quelle), umgewandelt von scripts/musik-umwandeln.py; der Server
                 streamt sie, der Client spielt eine zufällige Playlist
web/admin.template.html   die Werkbank (/admin)
web/impressum.template.html   Impressum & Datenschutz (/impressum)
web/sw.template.js        Service Worker (Hülle offline, /api nie)
scripts/         build-conformance.ts (npm run build), generate-golden.ts,
                 offline-test.ts (Browsertest), backup.ts, auto-deploy.sh,
                 bench-*.ts
test/            node:test, eine Datei je Thema; vectors/golden.json
deploy/          systemd-Units, Caddyfile
docs/            dieses Verzeichnis
ios-app/         Capacitor-Hülle, eigenes package.json
```

---

## 4. Der Ablauf einer Änderung

So läuft **jede** Änderung, egal ob Feature, Fehler oder Umbau. Die Reihenfolge
ist bewusst: Erst verstehen, dann Regelwerk, dann Simulation, dann Oberfläche,
dann alle Prüfungen, dann Push.

### 4.1 Verstehen

- Die betroffenen Stellen lesen, nicht raten: `rules.ts` (welche Daten gibt
  es), `state.ts` (welche Felder), `sim.ts` (welche Befehle), `view.ts` (was
  die Oberfläche sieht), dann das Modul der Oberfläche.
- Nach dem Muster suchen, das es schon gibt. Fast alles im Spiel ist eine
  Variante von etwas Vorhandenem (Schafe waren Kühe, die Saftpresse war die
  Mühle, Feste waren Wochenziele). Kopieren und anpassen schlägt Neuerfinden.

### 4.2 Regelwerk und Simulation

- Neues Regelwerk nach 2.2. Neue Waren/Rezepte/Plätze hinten anhängen.
- Neue Befehle in `commands.ts` + `sim.ts`; jeder Befehl prüft **alles** und
  wirft `SimError` mit sprechendem Code (`CELL_TAKEN`, `FEST_ONLY`). Die
  Oberfläche übersetzt Codes in Sätze (`CODES` in `anzeige.js`).
- Neue Zustandsfelder: `state.ts`, `normalizeState`, `canonical.ts` (2.4),
  Migration (2.2/5).
- Alles, was der Server verteilt (Kisten, Zettel, Post), bleibt beim Server.

### 4.3 Sicht und Oberfläche

- `view.ts` liefert, was gezeichnet wird. Die Oberfläche rechnet **nichts**
  selbst nach — sie zeigt die Sicht. Neue Anzeigen also erst in `farmView`.
- Texte in `texte.js` (Namen, Einzahl, Beschreibungen), nicht verstreut.
- Kunst in `bilder.js`: Ein Platz hat einen `KOERPER` (wie hoch ragt er über
  seine Zellen) und eine `art…`-Funktion, die SVG-Rechtecke zeichnet. Über den
  Rand ragen ist erlaubt (`overflow: visible`), aber der Körper muss stimmen,
  sonst überlappt es die Reihe darüber.
- Neue Blätter (Sheets): Markup in `page.html` (`<div class="sheet-bg"
  id="x-bg">`), Name in **beide** Listen in `show()` (`start.js`) eintragen,
  Schließknopf `x-close`.

### 4.4 Prüfen — in dieser Reihenfolge

1. **Unit-Tests**: `npm test` (alles) oder eine Datei:
   `node --experimental-strip-types --test test/schafe.test.ts`.
   Zu jedem Feature gehört eine eigene Testdatei mit dem Namen des Features.
   Tests beschreiben Verhalten in ganzen Sätzen (`test('Schafe fressen
   Schaffutter, sonst nichts', …)`).
2. **Golden Vectors** neu erzeugen und vergleichen (2.3).
3. **Bauen**: `npm run build`. Danach die gebaute Seite auf Syntax prüfen
   (5.4).
4. **Browsertest**: `npm run offlinetest` (5.2). Dauert etwa zwölf Minuten,
   braucht den Build. Fehlschläge stehen mit `✗` in der Ausgabe — die
   **ganze** Ausgabe in eine Datei umleiten, sonst geht die Begründung verloren.
5. **Anschauen**: Screenshots vom Handy- und PC-Format (5.3). Was man nicht
   gesehen hat, ist nicht fertig. Abgeschnittene Kunst, überlappende Reihen,
   Knöpfe, die nicht nach Spiel aussehen — das findet kein Test.
6. **Balance nachrechnen**, wenn sich Zeiten, Preise oder Erträge ändern: ein
   kleines Skript gegen das echte Regelwerk (Ertrag je Stunde und Feld,
   Verbrauch je Abnehmer). Zahlen in die Commit-Nachricht.

### 4.5 Committen und pushen

```bash
git add -A
git commit -F - <<'EOF'
Kurzer deutscher Betreff, was sich geändert hat

Warum, in ein paar Sätzen. Was geprüft wurde. Zahlen, wenn es welche gibt.
EOF
git push -u origin claude/live-service-game-concept-m4ymol
```

Nach dem Push zieht der Server von selbst. Prüfen:
`curl -s https://<server>/health` — `version` muss der neue Commit sein,
`rulesetVersion` die neue Nummer. Danach in der Werkbank das Protokoll und
die Alarme eine Weile beobachten: Divergenz-Alarme nach einem Deploy heißen,
dass alte Geräte anders rechnen als der neue Server.

---

## 5. Die Prüfwerkzeuge im Detail

### 5.1 `npm test`

`node --test` über `test/*.test.ts`, ohne Build. Einige Tests, die man kennen
sollte:

| Datei | Prüft |
| --- | --- |
| `sim-purity.test.ts` | keine Zufalls-/Zeit-/Gleitkommaquellen in `src/sim` |
| `rules.test.ts` | jedes Regelwerk besteht den Validator, Versionen lückenlos |
| `golden.test.ts` | alle aufgezeichneten Verläufe reproduzieren ihren Endzustand |
| `migration.test.ts` | jede Wanderungskette 1→n läuft durch |
| `determinism.test.ts`, `session-fuzz.test.ts` | Client und Server rechnen gleich, auch unter Zufall |
| `conformance-bundle.test.ts` | die gebaute Seite besteht alle Golden Vectors im Browser-Bundle |
| `storage-contract.test.ts` | SQLite und Speicher-Backend verhalten sich gleich |
| `konto-http.test.ts` | echter HTTP-Server als Kindprozess: Wort, Wiederherstellung, Bremsen, Löschen |

Ein neues Feature bekommt eine eigene Datei. Ein gefundener Fehler bekommt
erst einen Test, der ihn zeigt, dann die Korrektur.

### 5.2 `npm run offlinetest` — der Browsertest

`scripts/offline-test.ts` startet den Dev-Server (Port 8799, Dev-Regelwerk mit
Sekundenuhren) und ein headless Chromium (Debug-Port 9333) und spielt das
Spiel durch: anlegen, säen, ernten, Funkloch, neu laden, Markt zu zweit,
Nachbarn, Besuch, Werkbank-Eingriffe, Feste, Meisterschaft, Rückmeldung,
Wiederherstellung, Löschen, Versionswechsel. Jede Prüfung ist ein `check(name,
bedingung, detail)`; am Ende steht `N/M Prüfungen bestanden`.

- Braucht vorher `npm run build`. Über Umgebungsvariablen: `CHROMIUM_PATH`,
  `NS_FOTOS=<ordner>` speichert Screenshots.
- Helfer: `evaluate(cdp, js)`, `waitFor(cdp, js, was, ms)`, `sleep`,
  `plantAll`/`harvestAll`, `warteAufFreiesFeld`, `setzeGezielt` (findet eine
  freie Zelle und tippt sie über das `#welt`-Rechteck an), `api(pfad, methode)`
  (Werkbank mit `ADMIN_TOKEN`), `status.accountId`.
- Meldungen des Spiels werden mitgeschnitten (`localStorage['ns-test-meldungen']`).
- Neue Abschnitte kommen ans Ende vor „10. Eine neue Version"; der Abschnitt
  10 baut die Seite um und lädt neu, danach nur noch Dinge, die einen frischen
  Hof vertragen. „11. Der Hof geht" ist absichtlich der letzte.
- Zeiten sind knapp: Ein Moment dauert ~5 s, die Warteschlange kann lang sein.
  Auf Text mit `waitFor` warten, nicht mit festem `sleep` raten.
- Die Oberfläche steckt in einer IIFE: Interna sind aus dem Test nicht
  erreichbar. Was der Test braucht, hängt an `globalThis.NeuesSpiel`
  (`farmView`, `getRuleset`, `restoreClient`, `storageKeyFor`) oder ist im DOM.

### 5.3 Screenshots

Kein fertiges Skript im Repo, aber ein festes Rezept (siehe die Skripte im
Browsertest): Dev-Server auf einem freien Port starten, Chromium headless mit
`--remote-debugging-port` und `--window-size=430,900` (Handy) bzw. `1400,760`
(PC), per CDP `Page.navigate`, dann `Runtime.evaluate` für Klicks und
`Page.captureScreenshot`. Über die Werkbank-API (`/api/admin/xp`,
`/api/admin/grant`) lässt sich ein Hof in Sekunden auf eine hohe Stufe heben.
Anschauen, was man gebaut hat — jedes Mal.

### 5.4 Die gebaute Seite auf Syntax prüfen

```bash
(echo "(function(){"; cat web/farm/konto.js; echo "})()") > /tmp/k.js && node --check /tmp/k.js
```

Findet fehlende Klammern, aber keine doppelten Bezeichner über Dateigrenzen —
dafür die gebaute `dist/farm.html` im Browser öffnen oder den Browsertest
laufen lassen; ein `SyntaxError: Identifier … has already been declared`
kommt dann sofort.

### 5.5 Lastmessung

`npm run bench:scale -- 4000 30` misst Syncs je Sekunde mit echtem Kern und
echter Datenbank. Zahlen in `deploy.md`.

---

## 6. Server und Betrieb — das Nötigste

- Zwei Umgebungen, die sich nichts teilen: `npm run dev` (Port 8788, Regelwerk
  1001, Werkbank an) und `npm run prod` (Port 8787, neuestes Regelwerk,
  Werkbank nur mit `NEUES_SPIEL_ADMIN=1`, lauscht nur lokal — davor Caddy/TLS).
- Daten: `data/<umgebung>/spiel.db` (SQLite, WAL), `data/<umgebung>/token`
  (Werkbank-Token, einmal beim Start ausgegeben), `vapid.json` (Push).
- `/health` sagt Umgebung, Commit, Regelwerk, Höfe, Alarme.
- Die **Werkbank** `/admin` zeigt jeden Hof (Sicht, Lager, Brett, Sozial,
  Technik), greift ein (Kisten, Waren, Zeit, Stufe, Bauten, Gerät freigeben),
  liest das Server-Protokoll und den **Briefkasten** (Rückmeldungen,
  Fehlerberichte). Ganz unten die **Gefahrenzone**: alles löschen für ein
  neues Universum — nur mit abgetipptem Satz und mit Sicherung davor. Eingriffe werden beim nächsten Abgleich des Hofs angewandt,
  auch wenn er gerade offline ist.
- **Bremsen** (`accounts.ts`, `Bremse`): Höfe anlegen 20/h je Herkunft, Sync
  240/min je Konto, Wiederherstellung 5/h je Hofcode + 20/h je Herkunft,
  Rückmeldungen 10/h je Konto, Fehlerberichte 30/h je Herkunft.
- Sicherung: `deploy/neues-spiel-backup.timer` → `npm run backup` täglich, 14
  Stände. Auto-Deploy: `deploy/neues-spiel-deploy.timer`.
- Alle Details, TLS, Units, Umgebungsvariablen: [deploy.md](deploy.md).

### Die öffentliche API in einer Tabelle

| Route | Wer | Was |
| --- | --- | --- |
| `POST /api/account` | niemand | neuer Hof → Schlüssel + Snapshot |
| `POST /api/wiederherstellen` | niemand | Hofcode + Wort → neuer Schlüssel |
| `POST /api/fehler` | optional Schlüssel | Fehlerberichte des Geräts |
| `GET /api/state` | Schlüssel | Snapshot, aktives Gerät |
| `POST /api/sync` | Schlüssel | Befehle nachreichen → Ergebnis + Snapshot |
| `GET /api/events` | Schlüssel | SSE-Anstöße (farm, market, sozial, geschenk) |
| `GET/POST /api/wiederherstellung` | Schlüssel | Wort gesetzt? / Wort setzen |
| `DELETE /api/konto` | Schlüssel + Hofcode | Hof endgültig löschen |
| `POST /api/rueckmeldung` | Schlüssel | Rückmeldung an den Betreiber |
| `/api/hof`, `/api/freunde`, `/api/besuch`, `/api/geschenk`, `/api/helfen` | Schlüssel | Sozialer Kram |
| `/api/tagesbonus`, `/api/bestenliste`, `/api/push/*` | Schlüssel | Bonus, Liste, Benachrichtigungen |
| `/api/admin/*` | Werkbank-Token | siehe `handleAdmin` in `http.ts` |

---

## 7. Der Client von innen

- **Speicher im Gerät** (`localStorage`): `ns-token` (Schlüssel), `ns-device`
  (Gerätekennung), der Spielstand unter `NS.storageKeyFor(origin)`,
  `ns-tut-<konto>` (Einführung gesehen), `ns-lager-gesehen`, `ns-rueck-warte`
  und `ns-fehler-warte` (wartet auf Netz). „Von diesem Gerät abmelden" löscht
  Schlüssel und Spielstand.
- **Abgleich**: `sync-engine.ts` hält die Warteschlange, schickt sie mit
  Backoff, setzt `view` auf `live`, `catching-up` oder `offline`. Nach jeder
  Antwort übernimmt der Client den Server-Snapshot (`adopt`).
- **Zeit**: `tickNow()` rechnet die Serverzeit aus `clockOffsetMs` und dem
  Snapshot — nie aus der Gerätezeit allein.
- **Zeichnen**: `render()` in `anzeige.js` baut aus `farmView(preview)` das
  DOM neu; Plätze sind Kacheln mit SVG-Kunst, Positionen kommen aus dem Raster
  (`raster.js`). Zu Besuch zeigt dieselbe Funktion den fremden Hof
  (`besuchAktiv()`).
- **Blätter** (`show(name)`): genau eines offen, `x-bg` sichtbar, Rest
  versteckt; `netzWache()` wirft aus Blättern, die Netz brauchen.
- **Meldungen**: `toast()` für sofort, `momente.js` für eine Warteschlange
  wichtiger Nachrichten (gleiche Art wird zusammengelegt, `eilig` springt vor).
  Ein Zettel kommt nur für das, was der Hof nicht selbst zeigt: Säen und
  Ernten bleiben stumm (Name und Ausbeute steigen über dem Platz auf,
  `zahlAuf`), gemeldet werden Fund, volles Lager, leere Saat und Fehler.
  `act(null, …)` ist der stumme Weg. Der Zettel ist Papier mit Tinte, keine
  Pille.
- **Klang und Musik**: `klang('bestaetigt' | 'fehler' | …)`, Musik aus
  `web/musik/`; Lautstärken in den Einstellungen.
- **Einführung**: geführt in `fuehrung.js` — der Hof ist abgedunkelt, ein
  Element leuchtet (Loch per `clip-path`), es geht erst weiter, wenn der
  Spieler es getan hat (`fertig()` je Schritt), überspringbar; einmal je Hof
  (`ns-tut-<hof>`), nur für frische Höfe ohne XP. Dazu `FEATURE_TIPP` in
  `start.js`: ein Satz je Blatt beim ersten Öffnen als Zettel (`#tipp`); die
  Einführung markiert Lager, Brett und Bauen gleich als gesehen.

---

## 8. Schreibweise

- Deutsch in Oberfläche, Kommentaren, Commits, Tests. Bezeichner in der
  Oberfläche deutsch (`hofLaden`, `besuchAktiv`), in Simulation und Server
  eher englisch, wo es schon so ist (`simulate`, `applyExternal`).
- Kommentare erklären das **Warum** und die Entscheidung, nicht das Was.
  Gute Beispiele stehen überall im Code — der Stil ist erzählend, in ganzen
  Sätzen, oft mit dem Fall, der sonst schiefginge.
- TypeScript ohne Build: `node --experimental-strip-types`. Deshalb keine
  Enums, keine Dekoratoren, keine Parameter-Properties — nur Typen, die sich
  wegstreichen lassen. `import type` für reine Typen.
- Zwei Leerzeichen, einfache Anführungszeichen, Semikolons, `const` vor `let`.
- In der Oberfläche altes JavaScript (`var`, `function`), damit alte iPhones
  mitkommen; keine Klassen, kein `async/await` dort.

---

## 9. Fallen, in die schon jemand getreten ist

- **Doppelte Bezeichner** in der IIFE (`const feld` gab es schon) oder in
  `offline-test.ts` (`nachSetzen`, `abgeholt`). Erst suchen, dann benennen.
- **Regex-Umbenennungen** treffen auch Zeichenketten (`'abgelehnt'` wurde
  einmal mit umbenannt). Nach jeder Massenänderung `git diff` lesen.
- **Feld ohne Platz**: Ein 2×2-Bau braucht eine freie 2×2-Zelle außerhalb der
  Sperrzonen (Wegrand oben, Ufer am Boot). `passtHin` in `raster.js` und
  `blockiert` in `rules.ts` sind die Wahrheit, nicht das Auge.
- **Sperrzonen und Hindernisse**: Hindernisse in Sperrzonen bleiben liegen und
  werden nicht gezeichnet; Tests, die „irgendein Hindernis räumen", müssen ein
  räumbares wählen (`inSperre`).
- **Moment-Warteschlange**: Meldungen kommen mit ~5 s Abstand. Ein Test, der
  auf die dritte Meldung wartet, braucht 20 s Geduld, nicht 3.
- **Neuzeichnen frisst Zustand**: Klassen, die man einer Kachel gibt
  (`zeigt`), sind nach dem nächsten `render()` weg. Zustand gehört in eine
  Variable, die `render()` liest.
- **Kunst außerhalb des Kastens** wird beschnitten, wenn `overflow` nicht
  `visible` ist; Körperhöhe (`KOERPER`) und Kachelhöhe müssen zusammenpassen.
- **Startstufen** (`startLevel > 0`) dürfen weder Preis noch Stufensperre
  haben — der Validator sagt es, aber erst im Test.
- **Dev-Regelwerk vergessen**: Nach jedem neuen Regelwerk `1001` neu aufsetzen,
  sonst prüft der Browsertest das Spiel von gestern.
- **Ausgabe abschneiden**: `npm run offlinetest | tail` verliert die
  Fehlerbegründungen. Immer in eine Datei, dann `grep ✗`.
- **`zsh` und `#`**: Im Terminal des Betreibers ist `#` kein Kommentar. Keine
  Kommentare hinter Befehle in Anleitungen.

---

## 10. Was offen ist

Steht in [roadmap.md](roadmap.md) und am Ende von [deploy.md](deploy.md)
(„Drei Lücken"). Kurz: Sicherungen außer Haus, mehr Ketten (Bienen, Tomaten,
Kartoffeln, Ziegen), Besucher, Haustiere, eine Geschichte.

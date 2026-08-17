# Server deployen — Entwicklung und Produktion

Ziel: das Verbindungsmodell aus §10 über ein **echtes Netzwerk** prüfen statt über
Testattrappen. Echte Latenz, echte Abbrüche, echtes Verhalten im Aufzug.

Es gibt **zwei Umgebungen**, und sie teilen sich nichts:

| | Entwicklung | Produktion |
| --- | --- | --- |
| Start | `npm run dev` | `npm run prod` |
| Port | 8788 | 8787 |
| Spielstand | `data/dev/save.json` | `data/prod/save.json` |
| Token | `data/dev/token` | `data/prod/token` |
| Regelwerk | v1001 — Sekundenuhren | v2 — echte Zeiten |
| Werkbank `/admin` | an | **aus** |

Beide können gleichzeitig laufen. Genau dafür sind sie da: An einer neuen Version
herumprobieren, während die echten Spielstände nebenan unangetastet weiterlaufen.

Drei Riegel sind eingebaut, und alle drei brechen den Start ab statt zu warnen
(siehe `src/server/config.ts`):

1. **Die Umgebung muss man nennen.** `npm start` ohne `--env` startet nicht.
2. **Kein Dev-Regelwerk in Produktion.** Sekundenuhren auf echten Spielständen
   wären nicht rückgängig zu machen — die Migration hätte die Zeiten schon
   umgerechnet.
3. **Keine Werkbank in Produktion**, außer mit `NEUES_SPIEL_ADMIN=1`. Sie kann
   Gegenstände verschenken und Zeit gutschreiben.

Der Server braucht **keine Abhängigkeiten** — nur Node ≥ 22.6. Auf 1 GB RAM ist er
gelangweilt: ein Sync kostet ~8 µs, der Spielstand ist ein paar Kilobyte.

> **Keine Zugangsdaten verschicken.** Alles, was in einem Chat landet, bleibt im
> Transkript. Die Schritte unten führst du selbst aus; nichts davon muss jemand
> anders sehen.

---

## 1. Node prüfen

```bash
node --version    # muss v22.6 oder neuer sein
```

⚠️ **Debian 11 und viele VPS-Images liefern Node 12** — das ist zu alt und bringt oft
gar kein `npm` mit. Ein untrügliches Zeichen: `Unknown encoding: base64url`.

Neu installieren (als root; mit eigenem Benutzer jeweils `sudo` davor):

```bash
apt-get update
apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

node --version    # jetzt v22.x
npm --version
```

## 2. Code holen und Seiten bauen

```bash
cd /home
git clone https://github.com/Litschibauer/Neues-Spiel.git
cd Neues-Spiel
git checkout claude/live-service-game-concept-m4ymol

npm run build   # baut dist/field-test.html, dist/conformance.html, dist/admin.html
npm test        # 140 Tests, sollte grün sein
```

## 3. Starten

```bash
npm run dev     # Entwicklung, Port 8788
npm run prod    # Produktion,  Port 8787
```

Beim ersten Start erzeugt der Server selbst ein Token, legt es unter
`data/<umgebung>/token` ab (nur für den Besitzer lesbar) und gibt es einmal aus.
Danach findet er es dort von allein wieder. **Jede Umgebung hat ihr eigenes.**

**Token jederzeit nachschlagen:**

```bash
cat data/prod/token
cat data/dev/token
```

Ein eigenes vorgeben (überschreibt die Datei nicht, hat aber Vorrang):

```bash
NEUES_SPIEL_TOKEN='dein-token' npm run prod
```

Neues Token erzwingen: `rm data/prod/token`, dann neu starten. Am Token hängt
nichts — der Spielstand kennt es nicht.

### Welcher Stand läuft gerade?

`/health` braucht kein Token und sagt es:

```bash
curl -s localhost:8787/health
# {"ok":true,"env":"prod","version":"a1b2c3d","rulesetVersion":2,"seq":0,"tick":0}
```

`version` kommt aus `NEUES_SPIEL_VERSION`. Beim Start mitgeben, dann steht der
Commit drin, statt raten zu müssen:

```bash
NEUES_SPIEL_VERSION=$(git rev-parse --short HEAD) npm run prod
```

### Warum Dev schnelle Uhren hat

In Produktion wächst Weizen zwei Minuten, Futter braucht fünf, Eier fünfzehn.
Von Hand lässt sich damit kaum etwas testen: Ohne fertigen Platz und ohne Ware
im Lager wird jede Aktion **lokal abgelehnt**, die Warteschlange bleibt leer —
und ein Verbindungstest ohne Warteschlange prüft nichts.

Das Dev-Regelwerk (v1001) hat denselben Inhalt bei zehnfachem Tempo: Weizen
12 s, Futter 30 s, Eier 90 s. Ein kompletter Durchlauf vom leeren Hof bis zum
ersten Ei dauert damit ein paar Minuten statt einen Nachmittag.

Es steht **außerhalb der Produktionsreihe** und ist bewusst kein Migrationsziel
— es gäbe keinen Weg zurück. Ein Dev-Spielstand ist Wegwerfware: `rm -rf data/dev`.

### Balance-Patch live beobachten

In Produktion migriert der Server einen Spielstand beim nächsten Sync auf die
Zielversion und rechnet laufende Plätze fair um (R2):

```bash
NEUES_SPIEL_RULESET=1 npm run prod    # ein Stand auf v1
NEUES_SPIEL_RULESET=2 npm run prod    # dasselbe Spiel, gepatcht
```

Zurück geht es nicht — Downgrades sind bewusst nicht vorgesehen; für den alten
Stand `rm data/prod/save.json`.

### HTTPS — sonst startet die App nicht ohne Netz

Der Service Worker, der die App-Hülle im Funkloch bereitstellt, läuft nur in
einem **sicheren Kontext**: `https://` oder `localhost`. Über `http://` im LAN
registriert er sich schlicht nicht. Das Spiel funktioniert dann trotzdem — nur
ein Neuladen ohne Netz scheitert weiterhin.

Der einfachste Weg zu echtem HTTPS ohne Domain und ohne Portfreigabe ist
**Tailscale Serve**: Es besorgt ein gültiges Zertifikat für den
`*.ts.net`-Namen der Maschine.

```bash
tailscale serve --bg --https 443 http://127.0.0.1:8787
tailscale serve status          # zeigt die https://…ts.net-Adresse
```

Danach die Seite über diese Adresse öffnen, nicht über die IP. Im Protokoll
der Seite steht sonst „App-Hülle nicht offline-fähig".

Zum Ausprobieren ohne all das genügt `http://localhost:8788` direkt auf dem
Rechner — localhost gilt als sicherer Kontext.

## 4. Erreichbarkeit prüfen

Zuerst lokal auf dem Server:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"env":"prod","version":"a1b2c3d","rulesetVersion":2,"seq":0,"tick":0}
```

Dann im Browser `http://<server-ip>:8787/` öffnen, Token eintragen, fertig.

Lädt die Seite von außen nicht, blockiert eine Firewall den Port:

```bash
ss -ltn | grep 8787          # lauscht der Server überhaupt?
ufw status                   # falls ufw läuft: ufw allow 8787/tcp
```

Viele Anbieter haben zusätzlich eine Firewall in ihrer Weboberfläche, die davon
nichts weiß — dort ebenfalls freigeben.

---

## Als Dienst laufen lassen

Damit er Neustarts überlebt. Zuerst den Node-Pfad ermitteln, er landet gleich in
der Unit:

```bash
which node          # meist /usr/bin/node
pwd                 # das Repo-Verzeichnis, hier als /home/Neues-Spiel angenommen
```

Läuft noch eine Instanz von Hand, zuerst beenden — sonst ist der Port belegt:

```bash
pkill -f 'server/http'
```

**Eine Unit je Umgebung.** Sie stören sich nicht: eigener Port, eigener
Spielstand, eigenes Token.

`/etc/systemd/system/neues-spiel-prod.service`:

```ini
[Unit]
Description=Neues Spiel — Produktion
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/Neues-Spiel
# Kein Token nötig — der Dienst nimmt es aus data/prod/token.
ExecStart=/usr/bin/node --experimental-strip-types src/server/http.ts --env=prod
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/neues-spiel-dev.service` — dieselbe Datei mit
`--env=dev` und `Description=Neues Spiel — Entwicklung`.

```bash
systemctl daemon-reload
systemctl enable --now neues-spiel-prod
systemctl enable --now neues-spiel-dev     # optional
systemctl status neues-spiel-prod --no-pager
journalctl -u neues-spiel-prod -f
```

### Eine neue Version ausrollen

```bash
cd /home/Neues-Spiel
git pull
npm test                                    # erst prüfen, dann ausrollen
npm run build                               # Seiten neu bauen
systemctl restart neues-spiel-dev           # zuerst Dev
curl -s localhost:8788/health               # Stand kontrollieren, kurz spielen
systemctl restart neues-spiel-prod          # dann Produktion
curl -s localhost:8787/health
```

Damit `version` in `/health` etwas Nützliches sagt, den Commit in die Unit
schreiben — oder beim Deployen setzen:

```ini
Environment=NEUES_SPIEL_VERSION=a1b2c3d
```

### Absicherung (optional, nachträglich)

Läuft der Dienst, kann man ihn einschnüren. Unter `[Service]` ergänzen:

```ini
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
# MUSS gesetzt sein, wenn das Repo unter /home liegt — sonst kann der Dienst
# seinen eigenen Spielstand nicht mehr schreiben.
ReadWritePaths=/home/Neues-Spiel/data
```

Danach `systemctl daemon-reload && systemctl restart neues-spiel`. Startet er nicht
mehr, ist fast immer `ReadWritePaths` schuld — der Pfad muss exakt auf das
`data/`-Verzeichnis zeigen.

### Als eigener Benutzer statt root

Sauberer, aber mehr Schritte. Mit `User=spiel` in der Unit muss das Repo dem
Benutzer gehören:

```bash
useradd -r -s /usr/sbin/nologin spiel
chown -R spiel:spiel /home/Neues-Spiel
```

---

## Von unterwegs erreichbar machen

Für den Tunnel-Test brauchst du das Handy **im Mobilfunknetz**, nicht im WLAN —
sonst testest du nichts. Drei Wege, vom bequemsten zum saubersten:

| Weg | Aufwand | Anmerkung |
| --- | --- | --- |
| **Tailscale** | gering | Server und Handy im selben privaten Netz, nichts öffentlich. Für einen Feldtest die beste Wahl. |
| **Cloudflare Tunnel** | gering | Öffentliche HTTPS-Adresse ohne offenen Port am Router. |
| **Portweiterleitung + Reverse Proxy** | höher | Nur mit TLS davor — sonst geht das Token im Klartext durchs Netz. |

⚠️ **Nie ohne TLS über das offene Internet.** Das Token wandert in jedem Request
mit; über einfaches HTTP liest es jedes Netz zwischen Handy und Server mit.
Tailscale löst das, weil gar nichts öffentlich wird.

---

## Was du damit testen kannst

Die interessanten Fälle — alle bereits automatisiert geprüft, aber echtes Netz
verhält sich anders als eine Attrappe:

1. **Tunnel.** Flugmodus an, weiterspielen, Flugmodus aus. Die Warteschlange
   muss sich leeren, der Hof unverändert weiterlaufen. Kein Reload, kein Dialog.
2. **Verlorene Antwort.** Flugmodus genau in dem Moment, in dem der Sync läuft.
   Danach weiterspielen. Es darf nichts doppelt ankommen und nichts fehlen —
   das Protokoll zeigt dann „Antwort war verloren".
3. **Zwei Geräte.** iPad und Handy vom selben Stand, beide offline etwas tun.
   Das zweite bekommt `FORK_DETECTED` und übernimmt den Serverstand. Genau der
   UX-Bruch, den R3 beschreibt — und der Grund für ein Aktiv-Gerät-Token.
4. **Postfach.** Ein Geschenk zustellen, während niemand verbunden ist:

   ```bash
   curl -X POST -H "authorization: Bearer dein-token" \
     "http://127.0.0.1:8787/api/deliver?item=eggs&amount=7"
   ```

   Es muss im **Postfach** landen, nie direkt im Lager — und darf keinen
   Divergenz-Alarm auslösen (§7).
5. **Neustart.** `sudo systemctl restart neues-spiel` — der Spielstand muss
   exakt so weiterlaufen.

---

## Werkbank: `/admin`

Ein kleines Panel zum Herbeiführen von Situationen, auf die man sonst warten
müsste. Erreichbar unter `http://<server-ip>:8787/admin`, gleiches Token.

Der entscheidende Punkt: **Alle Eingriffe laufen über Mechanismen, die es
ohnehin gibt.** Ein direkter Griff in Felder oder Bestände würde beim nächsten
Sync den Kanarienvogel auslösen — der Client hätte ja anders gerechnet, und das
Monitoring meldete einen Determinismus-Bug, den es gar nicht gibt.

| Werkzeug | Was wirklich passiert |
| --- | --- |
| **Zeit vorspulen** | Nur `serverTs` wird zurückgestellt — die Uhr, gegen die das Zeitbudget aus §4 gemessen wird. Der Zustand bleibt unangetastet, Client und Server rechnen weiterhin dasselbe. |
| **Ware schenken** | Geht als Zustellung ins **Postfach** (§7), nie direkt ins Lager. Derselbe Pfad wie ein Geschenk vom Nachbarn — und der wird bewusst erst nach dem Kanarienvogel-Vergleich angewandt. |
| **Regelwerk umschalten** | Setzt nur die Zielversion. Der Wechsel passiert beim nächsten Sync als echter Balance-Patch mit fairer Umrechnung (R2). Downgrades werden abgelehnt. |
| **Zurücksetzen** | Neuer Hof, `seq` zurück auf 0. Danach im Spiel neu laden. |

Abschalten:

```bash
NEUES_SPIEL_ADMIN=0 npm run dev
```

## Endpunkte

| Route | Auth | Zweck |
| --- | --- | --- |
| `GET /` | — | Feldtest-Seite |
| `GET /admin` | — | Werkbank (Aktionen brauchen das Token) |
| `GET /health` | — | Lebenszeichen, aktuelle `seq` |
| `GET /api/state` | Bearer | Snapshot + Serverzeit |
| `POST /api/sync` | Bearer | Command-Log einreichen |
| `GET /api/admin/status` | Bearer | Vollständiger Serverzustand |
| `POST /api/admin/time?seconds=N` | Bearer | Zeit gutschreiben |
| `POST /api/admin/grant?item=…&amount=N` | Bearer | Ware ins Postfach |
| `POST /api/admin/ruleset?version=N` | Bearer | Zielversion setzen |
| `POST /api/admin/reset` | Bearer | Spielstand löschen |

Grenzen: 512 kB pro Request, höchstens 5000 Commands — ein Angreifer wählt die
Log-Länge sonst frei (R4).

---

## Grenzen dieses Servers

Er ist ein **Feldtest-Werkzeug**, kein Produktionsserver:

- Ein Spielstand je Umgebung, ein Token in `data/<umgebung>/token`. Keine Accounts, keine Registrierung.
- JSON-Datei statt Datenbank. Atomar geschrieben, aber ohne Backups.
- Kein TLS, kein Rate-Limit pro IP, keine Metriken.
- Snapshot-Signatur (§9) fehlt — der Server hält ohnehin seine eigene Kopie.

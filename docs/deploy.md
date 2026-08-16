# Feldtest-Server deployen

Ziel: das Verbindungsmodell aus §10 über ein **echtes Netzwerk** prüfen statt über
Testattrappen. Echte Latenz, echte Abbrüche, echtes Verhalten im Aufzug.

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

npm run conformance   # baut dist/field-test.html und dist/conformance.html
npm test              # 72 Tests, sollte grün sein
```

## 3. Starten

```bash
npm start
```

Beim ersten Start erzeugt der Server selbst ein Token, legt es unter
`data/token` ab (nur für den Besitzer lesbar) und gibt es einmal aus. Danach
findet er es dort von allein wieder.

**Token jederzeit nachschlagen:**

```bash
cat data/token
```

Ein eigenes vorgeben (überschreibt die Datei nicht, hat aber Vorrang):

```bash
NEUES_SPIEL_TOKEN='dein-token' PORT=8787 npm start
```

Neues Token erzwingen: `rm data/token`, dann neu starten. Am Token hängt nichts —
der Spielstand kennt es nicht.

## 4. Erreichbarkeit prüfen

Zuerst lokal auf dem Server:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"seq":0,"tick":0}
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

Dann `/etc/systemd/system/neues-spiel.service` anlegen:

```ini
[Unit]
Description=Neues Spiel — Feldtest-Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/Neues-Spiel
Environment=PORT=8787
# Kein Token nötig — der Dienst nimmt es aus data/token.
ExecStart=/usr/bin/node --experimental-strip-types src/server/http.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now neues-spiel
systemctl status neues-spiel --no-pager
journalctl -u neues-spiel -f
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

## Endpunkte

| Route | Auth | Zweck |
| --- | --- | --- |
| `GET /` | — | Feldtest-Seite |
| `GET /health` | — | Lebenszeichen, aktuelle `seq` |
| `GET /api/state` | Bearer | Snapshot + Serverzeit |
| `POST /api/sync` | Bearer | Command-Log einreichen |
| `POST /api/deliver` | Bearer | Zustellung ins Postfach (Test) |

Grenzen: 512 kB pro Request, höchstens 5000 Commands — ein Angreifer wählt die
Log-Länge sonst frei (R4).

---

## Grenzen dieses Servers

Er ist ein **Feldtest-Werkzeug**, kein Produktionsserver:

- Ein Spielstand, ein Token in `data/token`. Keine Accounts, keine Registrierung.
- JSON-Datei statt Datenbank. Atomar geschrieben, aber ohne Backups.
- Kein TLS, kein Rate-Limit pro IP, keine Metriken.
- Snapshot-Signatur (§9) fehlt — der Server hält ohnehin seine eigene Kopie.

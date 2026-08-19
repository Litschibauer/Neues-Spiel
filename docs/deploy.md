# Server deployen — Entwicklung und Produktion

Ziel: das Verbindungsmodell aus §10 über ein **echtes Netzwerk** prüfen statt über
Testattrappen. Echte Latenz, echte Abbrüche, echtes Verhalten im Aufzug.

Es gibt **zwei Umgebungen**, und sie teilen sich nichts:

| | Entwicklung | Produktion |
| --- | --- | --- |
| Start | `npm run dev` | `npm run prod` |
| Port | 8788 | 8787 |
| Lauscht auf | `0.0.0.0` — im LAN erreichbar | `127.0.0.1` — **nur lokal** |
| Spielstand | `data/dev/save.json` | `data/prod/save.json` |
| Token | `data/dev/token` | `data/prod/token` |
| Regelwerk | v1001 — Sekundenuhren | v12 — echte Zeiten |
| Werkbank `/admin` | an | **aus** |

Beide können gleichzeitig laufen. Genau dafür sind sie da: An einer neuen Version
herumprobieren, während die echten Spielstände nebenan unangetastet weiterlaufen.

Vier Riegel sind eingebaut, und alle vier brechen den Start ab statt zu warnen
(siehe `src/server/config.ts`):

1. **Die Umgebung muss man nennen.** `npm start` ohne `--env` startet nicht.
2. **Kein Dev-Regelwerk in Produktion.** Sekundenuhren auf echten Spielständen
   wären nicht rückgängig zu machen — die Migration hätte die Zeiten schon
   umgerechnet.
3. **Keine Werkbank in Produktion**, außer mit `NEUES_SPIEL_ADMIN=1`. Sie kann
   Gegenstände verschenken und Zeit gutschreiben.
4. **Produktion nicht im Klartext ins Netz.** Der Hof-Schlüssel reist in jedem
   Aufruf mit, und daneben steht kein Passwort: Wer ihn unterwegs mitliest, hat
   den Hof. Deshalb lauscht Produktion standardmäßig nur auf `127.0.0.1` —
   nach außen kommt sie über einen TLS-Endpunkt davor. Siehe den Abschnitt
   **HTTPS** weiter unten.

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

npm run build   # baut dist/farm.html (das Spiel), dist/field-test.html, dist/conformance.html, dist/admin.html
npm test        # muss grün sein — sonst nicht ausrollen
```

## 3. Starten

```bash
npm run dev     # Entwicklung, Port 8788
npm run prod    # Produktion,  Port 8787
```

### Zwei Oberflächen auf einem Kern

`/` ist das Spiel: Plätze als Kacheln, Levelring, Markt, Lager. `/feldtest` ist
dasselbe Spiel mit Messinstrumenten — Warteschlangenlänge, `seq`, Tick,
Divergenz-Protokoll.

Das ist kein Doppelaufwand, sondern ein Prüfmittel: Beide sind echte Clients auf
demselben Sim-Kern. Zeigen sie denselben Hof unterschiedlich, liegt es an einer
Anzeige und nicht an der Simulation — und genau das will man unterscheiden
können, wenn etwas nicht stimmt.

Eigene Gestaltung einsetzen: [`oberflaeche.md`](oberflaeche.md).

### Spieler brauchen kein Token — sie legen einen Hof an

Auf der Seite gibt es zwei Wege: **Neuen Hof anlegen** oder einen vorhandenen
**Schlüssel** eingeben. Der Schlüssel sieht so aus:

```
hof_YNP7T9-4K21C1-SC9WZY-9GKGBC
```

Er wird **genau einmal** angezeigt, direkt nach dem Anlegen. Danach kennt der
Server nur noch seinen Hash — auch der Betreiber kann ihn nicht nachschlagen.

> ⚠️ **Schlüssel weg heißt Hof weg.** Es gibt kein Passwort und keine E-Mail,
> über die sich etwas wiederherstellen ließe. Das ist die bewusste Vereinfachung
> für den Anfang; vor einer echten Spielerschaft braucht es einen zweiten Weg
> zurück in den Account.

Höfe liegen als je eine Datei unter `data/<umgebung>/accounts/`. Ein Backup ist
damit ein `cp -r` — und weil dort nur Hashes stehen, öffnet ein kopiertes
Verzeichnis keine fremden Höfe.

### Das Admin-Token

Es öffnet nur noch die Werkbank unter `/api/admin/*`, nicht mehr das Spiel.
Beim ersten Start erzeugt der Server es selbst, legt es unter
`data/<umgebung>/token` ab (nur für den Besitzer lesbar) und gibt es einmal aus.

```bash
cat data/prod/token
cat data/dev/token
```

Ein eigenes vorgeben:

```bash
NEUES_SPIEL_TOKEN='dein-admin-token' npm run prod
```

Neues erzwingen: `rm data/prod/token`, dann neu starten.

Die Werkbank arbeitet immer auf **einem** Hof. Ohne Angabe nimmt sie den zuletzt
angelegten; mit `?account=<id>` einen bestimmten. Welche es gibt:

```bash
curl -s -H "Authorization: Bearer $(cat data/dev/token)" \
     http://127.0.0.1:8788/api/admin/accounts
```

### Wo die Spielstände liegen

In **einer SQLite-Datei**: `data/<umgebung>/spiel.db`. Höfe und Markt teilen
sie sich. Ein Backup ist damit weiterhin ein `cp` — aber bei laufendem Server
bitte über `sqlite3 spiel.db ".backup sicherung.db"`, sonst erwischt man
womöglich einen halben Schreibvorgang.

Ein altes `accounts/`-Verzeichnis aus der Zeit davor wird beim ersten Start
automatisch übernommen und danach in `accounts.uebernommen/` umbenannt. Nichts
geht verloren; wegräumen darfst du selbst.

> `node:sqlite` gehört seit Node 22 zum Lieferumfang — der Wechsel kostet
> **keine Abhängigkeit**, und die Behauptung „läuft ohne npm install" bleibt
> wahr.

> Die ausführliche Antwort auf „trägt das, und sind wir eingesperrt?" steht in
> [`skalierung.md`](skalierung.md) — samt dem, was ein zweiter Server kosten
> würde und warum die Datenbank dabei der *letzte* Schritt wäre.

### Trägt das 1000–4000 gleichzeitige Spieler?

Ja, auf einem Server, ohne Loadbalancer und ohne Regionen. Nachgemessen mit
`npm run bench:scale -- 4000 30` — echter Sim-Kern, echter Speicher, keine
Attrappe:

| | 2000 Höfe | 4000 Höfe |
| --- | --- | --- |
| Durchsatz | ~9.100 Syncs/s | ~7.300 Syncs/s |
| je Sync (inkl. Speichern) | 110 µs | 136 µs |
| Datenbank | 16 MB | 32 MB |
| Arbeitsspeicher | 40 MB | 73 MB |
| Schreibvorgänge | 8.000 statt 60.000 | 16.000 statt 120.000 |

Dazu der Fall, der am meisten Sorge macht — **alle kommen gleichzeitig aus dem
Funkloch zurück und müssen validiert werden**:

| Spieler | Aktionen je | zu prüfen | Server blockiert |
| --- | --- | --- | --- |
| 2000 | 200 | 402.000 | 0,1 s |
| 4000 | 200 | 804.000 | 0,2 s |

Ein einzelner Rückkehrer mit den maximal erlaubten 5000 Aktionen kostet 4,6 ms.
Der Sim-Kern ist reine Integer-Arithmetik und schreibt Zeit in geschlossener
Form fort (§7) — acht Stunden Abwesenheit kosten nicht mehr als die Aktionen
darin.

> Speicher bitte mit `--expose-gc` messen. Ohne erzwungene Bereinigung misst
> `heapUsed` überwiegend Müll, der noch nicht abgeholt wurde — zwei Läufe
> desselben Codes unterschieden sich damit um den Faktor zweieinhalb.

Zur Einordnung: 4000 gleichzeitig **aktive** Spieler erzeugen etwa 1000 Syncs/s
— rund ein Siebtel dessen, was die Maschine hergibt. Der Engpass ist damit die
Bandbreite, nicht der Server.

⚠️ Gemessen auf einer Entwicklungsmaschine. Ein 1-GB-Mini-VPS ist langsamer,
und der ehrliche Weg ist, `npm run bench:scale` **dort** laufen zu lassen. Die
Größenordnung stimmt aber: Es geht um Tausende Syncs pro Sekunde, nicht um
Dutzende.

### Drei Dinge, die das möglich machen

Sie stehen hier, weil sie leicht wieder kaputtgehen:

1. **Der Command-Log ist ein Fenster** (200 Einträge), keine Geschichte. Vorher
   wuchs er unbegrenzt und wurde bei jedem Sync komplett neu geschrieben — der
   Aufwand einer Sitzung stieg damit *quadratisch*: gemessene 344 MB
   Schreiblast für einen einzigen Spieler über 6000 Aktionen. Mit Fenster sind
   es 27 MB, und die Datei wächst nicht mehr mit.
2. **Geschrieben wird gesammelt**, alle 2 s in einer Transaktion
   (`NEUES_SPIEL_FLUSH_MS`). Zweitausend geänderte Spielstände kosten damit
   einen Schreibvorgang statt zweitausend. Der Preis ist ein Fenster von zwei
   Sekunden, in dem eine Änderung nur im Speicher steht.
3. **Ruhende Höfe fliegen aus dem Speicher** (nach 15 min,
   `NEUES_SPIEL_IDLE_MS`). Ohne das wächst der Arbeitsspeicher monoton: Wer
   einmal gespielt hat, bliebe bis zum Neustart drin.

Ausnahme von Punkt 2: **Verkaufsabrechnungen werden sofort geschrieben.** Ein
Verkauf, der bei einem Absturz verschwindet, hieße, dass der Käufer bezahlt hat
und der Verkäufer nichts bekommt.

### Bremsen gegen Missbrauch

| Variable | Standard | Wogegen |
| --- | --- | --- |
| `NEUES_SPIEL_NEW_PER_HOUR` | 20 | Jemand legt im Skript tausend Höfe an |
| `NEUES_SPIEL_MAX_ACCOUNTS` | 5000 | Die Platte läuft voll |

### Wo es dann doch nicht mehr trägt

Ehrlich, damit es nicht überrascht:

- **Ein Prozess schreibt.** Genau das serialisiert auch die Käufe am Markt
  (siehe unten). Ein zweiter Serverprozess auf derselben Datei trägt das nicht
  — dann wird aus der Datei ein Dienst.
- **`synchronous = NORMAL`.** Bei einem *Stromausfall* können die letzten
  Sekundenbruchteile fehlen. Bei einem Absturz oder `kill` nicht.
- **Kein Rate-Limit auf `/api/sync`.** Ein entschlossener Angreifer kann fluten.
- **Backups macht niemand automatisch.** Ein `cron` mit `.backup` ist zehn
  Minuten Arbeit und fehlt.

### Welcher Stand läuft gerade?

`/health` braucht kein Token und sagt es:

```bash
curl -s localhost:8787/health
# {"ok":true,"env":"prod","version":"a1b2c3d","rulesetVersion":2,"accounts":3,"secure":true}
```

Nichts über einzelne Höfe — die Route braucht bewusst keine Zugangsdaten, also
darf sie auch nichts verraten, was einem Hof gehört. `secure` sagt, ob bei den
Spielern verschlüsselt ankommt (siehe HTTPS unten).

`version` kommt aus `NEUES_SPIEL_VERSION`. Beim Start mitgeben, dann steht der
Commit drin, statt raten zu müssen:

```bash
NEUES_SPIEL_VERSION=$(git rev-parse --short HEAD) npm run prod
```

### Warum Dev schnelle Uhren hat

In Produktion wächst Weizen 30 Sekunden, Hühnerfutter braucht eine Minute, Eier vier.
Von Hand lässt sich damit kaum etwas testen: Ohne fertigen Platz und ohne Ware
im Lager wird jede Aktion **lokal abgelehnt**, die Warteschlange bleibt leer —
und ein Verbindungstest ohne Warteschlange prüft nichts.

Das Dev-Regelwerk (v1001) hat denselben Inhalt bei zehnfachem Tempo: Weizen
3 s, Hühnerfutter 6 s, Eier 24 s. Ein kompletter Durchlauf vom leeren Hof bis zum
ersten Ei dauert damit ein paar Minuten statt einen Nachmittag.

Es steht **außerhalb der Produktionsreihe** und ist bewusst kein Migrationsziel
— es gäbe keinen Weg zurück. Ein Dev-Spielstand ist Wegwerfware: `rm -rf data/dev`.

### Läuft mein Hof schon auf der neuen Version?

`/health` sagt es ohne Werkbank:

```bash
curl -s http://127.0.0.1:8787/health
```

| Feld | Bedeutung |
| --- | --- |
| `rulesetVersion` | worauf der **Server** zielt — das ist die neue Version |
| `rulesets` | worauf die **geladenen Höfe** gerade stehen, gezählt je Version |
| `migrationFailures` | wie oft eine Migration abgebrochen ist |

Steht bei `rulesets` noch eine alte Nummer, hat der Hof seit dem Neustart nicht
gesynct — er wandert beim nächsten Sync. Steht dort eine alte Nummer **und**
`migrationFailures` ist größer als 0, ist die Migration gescheitert; der Grund
steht im Serverprotokoll, und der Hof spielt sicherheitshalber auf der alten
Version weiter, statt kaputtzugehen.

### Balance-Patch live beobachten

In Produktion migriert der Server einen Spielstand beim nächsten Sync auf die
Zielversion und rechnet laufende Plätze fair um (R2):

```bash
NEUES_SPIEL_RULESET=1 npm run prod    # ein Stand auf v1
NEUES_SPIEL_RULESET=2 npm run prod    # dasselbe Spiel, gepatcht
```

Zurück geht es nicht — Downgrades sind bewusst nicht vorgesehen; für den alten
Stand `rm data/prod/save.json`.

### HTTPS

Zwei unabhängige Gründe, und der zweite wird meist übersehen:

1. **Der Hof-Schlüssel reist in jedem Aufruf mit.** Daneben steht kein Passwort
   und keine zweite Hürde — wer ihn unterwegs mitliest, hat den Hof. Im selben
   WLAN genügt dafür ein Laptop.
2. **Ohne sicheren Kontext kein Service Worker.** Der, der die App-Hülle im
   Funkloch bereitstellt, registriert sich nur unter `https://` oder auf
   `localhost`. Über `http://` im LAN startet die App also doch nicht ohne
   Netz — im Protokoll der Seite steht dann „App-Hülle nicht offline-fähig".

Zwei Wege dorthin.

**a) Ein TLS-Endpunkt davor** — der bequeme Weg, und der einzige, der ohne
eigene Domain auskommt. **Tailscale Serve** besorgt ein gültiges Zertifikat für
den `*.ts.net`-Namen der Maschine:

```bash
tailscale serve --bg --https 443 http://127.0.0.1:8787
tailscale serve status          # zeigt die https://…ts.net-Adresse
```

Der Spielserver bleibt dabei auf `127.0.0.1` — sein Standard in Produktion,
also nichts zu tun. Danach die Seite über die `ts.net`-Adresse öffnen, nicht
über die IP.

Steht der Endpunkt auf einer **anderen** Maschine, muss der Spielserver nach
außen lauschen. Dann beides setzen:

```bash
NEUES_SPIEL_HOST=0.0.0.0 NEUES_SPIEL_BEHIND_PROXY=1 npm run prod
```

`NEUES_SPIEL_BEHIND_PROXY=1` sagt zweierlei: Riegel 4 ist erfüllt, *und*
`x-forwarded-for` darf geglaubt werden. Ohne Proxy davor wird dieser Kopf
bewusst ignoriert — sonst umginge man die Anlege-Bremse mit einer Zeile.

**b) Eigenes Zertifikat** — dann verschlüsselt der Spielserver selbst:

```bash
NEUES_SPIEL_TLS_CERT=/etc/letsencrypt/live/hof.example/fullchain.pem \
NEUES_SPIEL_TLS_KEY=/etc/letsencrypt/live/hof.example/privkey.pem \
NEUES_SPIEL_HOST=0.0.0.0 \
npm run prod
```

Beide Pfade gehören zusammen: Nur einer von beiden bricht den Start ab. Halb
konfiguriertes TLS ist der schlimmste Fall — man glaubt, es läuft
verschlüsselt, und es läuft im Klartext. Zwischenzertifikate über
`NEUES_SPIEL_TLS_CA`. Der Dienst muss den Schlüssel lesen dürfen; liegt er
unter `/etc/letsencrypt`, heißt das meist `User=root` oder eine Kopie mit
passenden Rechten. Ein erneuertes Zertifikat greift erst nach
`systemctl restart` — Node liest die Datei beim Start.

Ob es angekommen ist, sagt `/health`:

```bash
curl -s https://…/health      # "secure":true
```

`secure` ist `true`, wenn der Server selbst TLS beendet, wenn
`NEUES_SPIEL_BEHIND_PROXY=1` gesetzt ist oder wenn er nur auf `localhost`
lauscht. Steht dort `false`, reist der Schlüssel im Klartext.

Zum Ausprobieren ohne all das genügt `http://localhost:8788` direkt auf dem
Rechner — localhost gilt als sicherer Kontext. **Dev** darf deshalb weiter
unverschlüsselt ins LAN; das Startprotokoll sagt dann deutlich, was fehlt.

## 4. Erreichbarkeit prüfen

Zuerst lokal auf dem Server:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"env":"prod","version":"a1b2c3d","rulesetVersion":2,"accounts":3,"secure":true}
```

Dann von außen über die HTTPS-Adresse des Endpunkts davor (bei Tailscale Serve
die `…ts.net`-Adresse), und dort einen Hof anlegen.

Lädt die Seite von außen nicht, liegt es an einer von zwei Stellen. Erst prüfen,
**wo** der Server lauscht:

```bash
ss -ltn | grep 8787          # 127.0.0.1:8787 → nur lokal, das ist der Standard
```

Steht dort `127.0.0.1`, ist das kein Fehler: Produktion lauscht absichtlich nur
lokal (Riegel 4), und nach außen kommt der Endpunkt davor. Dann dort suchen:

```bash
tailscale serve status       # zeigt er die Weiterleitung auf 127.0.0.1:8787?
```

Soll der Server wirklich selbst nach außen lauschen, siehe HTTPS oben — und dann
kann eine Firewall den Port blockieren:

```bash
ufw status                   # falls ufw läuft: ufw allow 8787/tcp
```

Viele Anbieter haben zusätzlich eine Firewall in ihrer Weboberfläche, die davon
nichts weiß — dort ebenfalls freigeben.

---

## Als Dienst laufen lassen

Fertige Unit-Dateien liegen im Repo unter **`deploy/`** — kopieren, Pfade
anpassen, starten. Sie sind mit `systemd-analyze verify` geprüft.

```bash
which node          # meist /usr/bin/node — muss zur Unit passen
pwd                 # das Repo-Verzeichnis; die Units nehmen /opt/neues-spiel an

sudo cp deploy/neues-spiel-prod.service /etc/systemd/system/
sudo cp deploy/neues-spiel-backup.{service,timer} /etc/systemd/system/
sudoedit /etc/systemd/system/neues-spiel-prod.service    # WorkingDirectory + ReadWritePaths

sudo systemctl daemon-reload
sudo systemctl enable --now neues-spiel-prod
sudo systemctl enable --now neues-spiel-backup.timer

systemctl status neues-spiel-prod --no-pager
journalctl -u neues-spiel-prod -f
```

`deploy/neues-spiel-dev.service` daneben, falls die Entwicklungsumgebung
dauerhaft laufen soll. Beide stören sich nicht: eigener Port, eigene Datenbank,
eigenes Token, eigenes Regelwerk.

### ⚠️ Wenn schon eine Unit von früher läuft

Zwei Dinge haben sich geändert und brechen eine alte Unit still:

1. **Produktion lauscht jetzt nur auf `127.0.0.1`.** Wer den Server bisher
   direkt über die Server-IP erreicht hat, kommt nicht mehr durch — und im
   Journal steht kein Fehler, weil das Absicht ist (Riegel 4). Nach außen führt
   der Weg über einen TLS-Endpunkt davor; wer wirklich direkt lauschen will,
   setzt `NEUES_SPIEL_HOST=0.0.0.0` **und** TLS oder
   `NEUES_SPIEL_BEHIND_PROXY=1`, sonst bricht der Start ab.
2. **Die Spielstände liegen in `data/<umgebung>/spiel.db`**, nicht mehr in
   Einzeldateien. Der Umzug passiert beim ersten Start von allein; das alte
   `accounts/`-Verzeichnis wird danach in `accounts.uebernommen/` umbenannt.
   Steht in der Unit ein `ReadWritePaths`, muss es auf `data/` zeigen (nicht auf
   eine einzelne Datei) — sonst schlägt der Umzug fehl.

Nachsehen, ob es geklappt hat:

```bash
journalctl -u neues-spiel-prod -n 30 | grep -i übernommen
curl -s localhost:8787/health      # "accounts" muss die alte Zahl zeigen
```

### Neustart heißt kurz, nicht sanft

Beim Ausrollen ist der Neustart der heikle Moment. Gemessen:

| | |
| --- | --- |
| `systemctl restart` (SIGTERM) | ~0,1 s bis beendet, **nichts geht verloren** |
| harter Abbruch (OOM-Killer, Strom weg) | bis zu `NEUES_SPIEL_FLUSH_MS` (2 s) bestätigter Aktionen verloren |

Der SIGTERM-Weg schreibt alles Gemerkte, bevor er beendet — auch dann, wenn der
Schreibtakt gerade erst angefangen hat. Nachgeprüft mit einem Schreibfenster von
60 Sekunden: Die Aktion war nach dem Neustart da.

Der harte Abbruch nicht. Wer das nicht will, setzt `NEUES_SPIEL_FLUSH_MS`
kleiner — der Preis ist mehr Schreiblast, und genau die war der Grund für das
Sammeln.

**Die Reihenfolge beim Beenden ist der Grund, warum nichts verlorengeht:** erst
alle Live-Leitungen zu, dann jeden geladenen Hof schreiben, dann das Orderbuch,
dann die Datenbank schließen — und **erst danach** der Server-Socket. Wäre es
andersherum, wartete `server.close()` auf Verbindungen, die per Konstruktion nie
von selbst enden. Kommt der Socket trotzdem nicht zu (eine halb gesendete
Anfrage, ein Client, der nicht loslässt), beendet sich der Prozess nach zwei
Sekunden selbst; geschrieben ist da längst alles.

Gemessen, mit offenen Live-Leitungen:

| offene Leitungen | SIGTERM → Prozess weg |
| --- | --- |
| 1 | 13 ms |
| 50 | 24 ms |
| 300 | 55 ms |

### Was ein Spieler vom Neustart merkt

Im Idealfall: nichts außer einem kurzen „ohne Netz". Das ist kein Versprechen,
sondern in `npm run offlinetest` als Abschnitt 9 nachgestellt — echter Browser,
echter SIGTERM mitten im Spiel:

| Was passiert | Was der Spieler erlebt |
| --- | --- |
| Server weg | Anzeige springt auf „ohne Netz — läuft weiter" |
| Er tippt weiter | Aktionen landen in der Warteschlange, das Spiel läuft normal |
| Server wieder da | Seite verbindet sich **von selbst** — gemessen nach 2,6 s |
| Danach | Die Warteschlange ist bestätigt, `seq` ist gewachsen, die Live-Leitung steht wieder |

Kein Klick nötig, kein Neuladen, kein Dialog. Wer während des Neustarts gar
nicht hinschaut, merkt überhaupt nichts.

**Wichtig für den Ansturm danach:** Bei einem Neustart reißen *alle* Leitungen in
derselben Millisekunde ab. Der Wiederverbindungsversuch ist deshalb gestreut
(Faktor 0,5–1,5 auf ein wachsendes Backoff) — ohne das kämen tausend Geräte
exakt eine Sekunde später gleichzeitig zurück, und zwar bei jedem Fehlschlag
erneut im Gleichtakt.


### Eine neue Version ausrollen

```bash
cd /opt/neues-spiel
git pull
npm test                                    # erst prüfen, dann ausrollen
npm run build                               # Seiten neu bauen
sudo systemctl restart neues-spiel-dev      # zuerst Dev
curl -s localhost:8788/health               # Stand kontrollieren, kurz spielen
sudo systemctl restart neues-spiel-prod     # dann Produktion
curl -s localhost:8787/health
```

Damit `version` in `/health` etwas Nützliches sagt, den Commit in die Unit
schreiben:

```bash
sudo sed -i "s|^Environment=NEUES_SPIEL_VERSION=.*|Environment=NEUES_SPIEL_VERSION=$(git rev-parse --short HEAD)|" \
  /etc/systemd/system/neues-spiel-prod.service
sudo systemctl daemon-reload && sudo systemctl restart neues-spiel-prod
```

Zwei Stolperstellen dabei:

- **`git pull` ohne `npm run build`.** Dann liegt neuer Server-Code neben einer
  alten `dist/farm.html`, und die Spieler bekommen weiter die alte Oberfläche.
  Der Server sagt nichts dazu — er liefert einfach aus, was da ist.
- **Neues Regelwerk** (`NEUES_SPIEL_RULESET`) braucht trotzdem **kein**
  Wartungsfenster. Migriert wird pro Hof beim ersten Sync danach, nicht für
  alle beim Start. Wer gerade offline war, rechnet seinen Log noch unter der
  alten Version nach und wechselt erst danach (R2) — genau dafür ist die
  Versionierung da.

### Sicherungen

Der Zeitgeber oben ruft `scripts/backup.ts` auf. Der schreibt eine in sich
stimmige Kopie **bei laufendem Server** (`VACUUM INTO`), prüft sie anschließend
(`integrity_check`) und räumt alte auf.

```bash
sudo systemctl start neues-spiel-backup     # von Hand auslösen
systemctl list-timers neues-spiel-backup.timer
ls -lh backups/prod/
```

> **`cp` der `.db`-Datei ist KEINE Sicherung.** Die Datenbank läuft im
> WAL-Modus: Ein `cp` erwischt einen Stand ohne die Änderungen im `-wal`, und
> wer beide kopiert, erwischt sie zu verschiedenen Zeitpunkten. Das Ergebnis
> sieht heil aus und ist es nicht — auffallen würde es erst beim Zurückspielen.

Zurückspielen:

```bash
sudo systemctl stop neues-spiel-prod
cp backups/prod/spiel-prod-2026-01-31T03-00-00.db data/prod/spiel.db
rm -f data/prod/spiel.db-wal data/prod/spiel.db-shm
sudo systemctl start neues-spiel-prod
```

Ehrlich zur Grenze: Diese Sicherungen liegen auf **derselben Platte**. Das hilft
gegen einen Bedienfehler, nicht gegen einen kaputten Server. Der Weg nach außen
— `rsync` auf eine andere Maschine, ein Objektspeicher — fehlt und ist die
nächste zehn Minuten wert.

### Absicherung

Die Units in `deploy/` sind bereits eingeschnürt: `ProtectSystem=strict`,
`ProtectHome`, `NoNewPrivileges`, `PrivateTmp` und die üblichen `Protect*`.

Startet der Dienst danach nicht mehr, ist es **fast immer `ReadWritePaths`**.
Es muss auf das `data/`-Verzeichnis zeigen — SQLite legt neben der `.db` noch
`-wal` und `-shm` an, braucht also Schreibrecht im Verzeichnis und nicht nur an
der Datei.

```bash
systemd-analyze verify /etc/systemd/system/neues-spiel-prod.service
journalctl -u neues-spiel-prod -n 50 --no-pager
```

### Als eigener Benutzer statt root

Sauberer, aber mehr Schritte. Mit `User=spiel` in der Unit muss das Repo dem
Benutzer gehören:

```bash
sudo useradd -r -s /usr/sbin/nologin spiel
sudo chown -R spiel:spiel /opt/neues-spiel
```

---

## Von unterwegs erreichbar machen

Für den Tunnel-Test brauchst du das Handy **im Mobilfunknetz**, nicht im WLAN —
sonst testest du nichts. Drei Wege, vom bequemsten zum saubersten:

| Weg | Aufwand | Anmerkung |
| --- | --- | --- |
| **Tailscale** | gering | Server und Handy im selben privaten Netz, nichts öffentlich. Für einen Feldtest die beste Wahl. |
| **Cloudflare Tunnel** | gering | Öffentliche HTTPS-Adresse ohne offenen Port am Router. |
| **Portweiterleitung + Reverse Proxy** | höher | Nur mit TLS davor — Riegel 4 lässt es sonst gar nicht erst starten. |

⚠️ **Nie ohne TLS über das offene Internet.** Der Hof-Schlüssel wandert in jedem
Request mit; über einfaches HTTP liest ihn jedes Netz zwischen Handy und Server
mit. Tailscale löst das, weil gar nichts öffentlich wird. In Produktion setzt
Riegel 4 das durch — dort ist es keine Empfehlung mehr, sondern eine
Startbedingung.

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
| `GET /` | — | **Das Spiel** |
| `GET /feldtest` | — | Messgerät: dieselbe Sim mit `seq`, Tick, Warteschlange und Protokoll |
| `GET /admin` | — | Werkbank (Aktionen brauchen das Admin-Token) |
| `GET /health` | — | Umgebung, Stand, Regelwerk, `secure`, `shell`, `streams`, `rejections` |
| `GET /sw.js`, `GET /manifest.webmanifest` | — | App-Hülle für den Funkloch-Start |
| `POST /api/account` | — | Neuen Hof anlegen (mit Bremse, R4) |
| `GET /api/state` | Hof-Schlüssel | Snapshot + Serverzeit |
| `POST /api/sync` | Hof-Schlüssel | Command-Log einreichen |
| `GET /api/events` | Hof-Schlüssel | Offene Live-Leitung; trägt nur Anstöße, keine Spieldaten |
| `POST /api/deliver?item=…&amount=N` | Hof-Schlüssel | Ware in den eigenen Briefkasten |

Der Markt braucht **keine eigene Route**: Fremde Angebote reisen im Snapshot mit
(`state.offers`), gekauft wird mit einem normalen Command über `/api/sync`. Das
Buch liegt in `data/<umgebung>/market.json` — Dev und Produktion haben also
getrennte Märkte, ein Testverkauf taucht nie in einer echten Auslage auf.
| `GET /api/admin/status` | Bearer | Vollständiger Serverzustand |
| `POST /api/admin/time?seconds=N` | Bearer | Zeit gutschreiben |
| `POST /api/admin/grant?item=…&amount=N` | Bearer | Ware ins Postfach |
| `POST /api/admin/ruleset?version=N` | Bearer | Zielversion setzen |
| `POST /api/admin/reset` | Bearer | Spielstand löschen |

Grenzen: 512 kB pro Request, höchstens 5000 Commands — ein Angreifer wählt die
Log-Länge sonst frei (R4).

---

## Änderungen, die Offline-Spieler treffen können

Der Neustart selbst ist harmlos (oben gemessen). Gefährlich ist etwas anderes:
**Was passiert mit jemandem, der offline war, während sich die Regeln geändert
haben?** Sein Gerät hat unter den alten Regeln gerechnet, der Server rechnet
unter den neuen nach — und wenn beide zu verschiedenen Ergebnissen kommen, wird
sein Abend abgeschnitten.

### Was schon sicher ist

| Änderung | Warum sie niemanden trifft |
| --- | --- |
| Balance, Preise, Zeiten, neue Gegenstände | Regelwerk-Versionierung (R2): Der Log wird unter der Version validiert, unter der er entstanden ist, und **erst danach** migriert |
| Ein neues Command (z. B. `SKIP_REQUEST`) | Rein additiv. Eine alte App schickt es nie |
| Ein neues Zustandsfeld | `normalizeState()` füllt es beim Laden auf |
| Markt, Speicher, Live-Leitungen, Oberfläche | Steht nicht im Command-Log — für die Nachrechnung unsichtbar |

Das deckt fast alles ab, was man im Alltag tut.

### Der eine gefährliche Fall

**Die Bedeutung eines bestehenden Commands ändert sich im CODE.** Nicht in den
Daten — im Code. Beispiel: Eine Prüfung wird strenger, eine Reihenfolge dreht
sich um, eine Rundung wird korrigiert.

Warum genau das die Lücke ist: `rulesetVersion` versioniert die **Daten**, nicht
den Code. Einen alten Log rechnet der Server immer mit dem Code nach, der gerade
läuft.

Nachgestellt — ein Spieler mit vier Offline-Aktionen, von denen die dritte unter
dem neuen Code nicht mehr gilt:

```
Offline gespielt: 4 Commands
Ergebnis: partial · übernommen bis seq 2
Grund: ILLEGAL_COMMAND:UNKNOWN_COMMAND ab seq 3
VERLOREN: 2 Commands
```

Die gute Nachricht zuerst: **Es zerschießt sich nicht.** Der Präfix-Commit hält
den Zustand konsistent — der Hof bleibt heil, nichts wird doppelt oder
widersprüchlich. Die schlechte: Zwei Aktionen sind weg, und der Spieler bekommt
dafür ein „Teil verworfen" zu sehen, für einen Fehler, den er nicht gemacht hat.

### Die Regel, die das verhindert

**Verhaltensänderungen gehören ins Regelwerk als Daten, nicht in den Code als
`if`.** Das ist keine neue Erfindung, sondern das Prinzip, auf dem das Projekt
ohnehin steht — man muss es nur auch dann einhalten, wenn eine Codezeile
schneller wäre.

Braucht es eine Preisuntergrenze, ist die richtige Umsetzung ein Feld im
Regelwerk und eine **neue Regelversion**, nicht ein `Math.max(1, …)` im Kern.
Dann rechnet der alte Log unter v1 weiter richtig, und der Spieler wechselt beim
Sync sauber auf v2.

**Die Golden Vectors sind dabei der Alarm.** Ändert sich Sim-Verhalten, werden
sie rot — jedes Mal. Ein rotes `npm test` nach einer Kernänderung heißt deshalb
nicht „Vektoren neu erzeugen", sondern: *Du hast gerade geändert, was die
Offline-Logs von tausend Leuten bedeuten.* Erst wenn diese Frage beantwortet
ist, wird regeneriert.

### Wenn es sich wirklich nicht vermeiden lässt

Für den seltenen Fall, dass eine Änderung weder als Daten noch additiv geht,
wird aus **einem brechenden Deploy zwei nicht brechende:**

1. **Deploy A — beides annehmen.** Der neue Server versteht die alte *und* die
   neue Form. Niemand verliert etwas, egal wie alt seine App ist.
2. **Warten.** Länger als die längste realistische Offline-Strecke; eine Woche
   ist großzügig. In dieser Zeit `rejections` in `/health` beobachten.
3. **Deploy B — alte Form entfernen.** Erst wenn der Zähler bei null steht.

Zwei Ausrollungen statt einer, und dafür kein einziger abgeschnittener Abend.

### Woran man es merkt

`/health` zählt mit, warum Offline-Arbeit abgeschnitten wurde:

```bash
curl -s localhost:8787/health | grep -o '"rejections":{[^}]*}'
```

| Grund | Lesart |
| --- | --- |
| `OFFER_GONE` | **Normal.** Jemand war beim Kauf schneller — das ist die geteilte Welt |
| `UNKNOWN_COMMAND` | **Alarm.** Client und Server haben nicht denselben Befehlssatz. Steht auch als `[version]`-Warnung im Journal |
| alles andere | Eine Regel galt beim Nachrechnen nicht mehr. Kurz nach einem Ausrollen ist das ein Versionsverdacht |

Steigt nach einem Deploy irgendetwas außer `OFFER_GONE` an, frisst das Ausrollen
gerade Offline-Arbeit. Dann zurückrollen, nicht weiterschauen.

## „Ich sehe immer noch die alte Version"

Der häufigste Fall, und er hat fast nie mit dem Server zu tun: **Die alte Seite
liegt im Browser, nicht im Repo.** Neu klonen hilft deshalb nicht.

Die App ist eine PWA. Ihre Hülle kommt aus dem Cache des Service Workers, damit
sie im Funkloch startet — dieselbe Eigenschaft, die sie hartnäckig macht.

Erst nachsehen, was der Server überhaupt ausliefert:

```bash
curl -s localhost:8787/health     # "shell" ist der Fingerabdruck der Seite
```

Dann im Browser vergleichen (DevTools → Konsole):

```js
caches.keys()                     // "neues-spiel-<version>-<fingerabdruck>"
```

| Befund | Bedeutung |
| --- | --- |
| beide Fingerabdrücke gleich | Du siehst die aktuelle Seite. Was fehlt, fehlt wirklich. |
| Browser hat einen älteren | Einmal neu laden — die Seite lädt sich danach selbst nach |
| `"Seite fehlt"` statt Spiel | `npm run build` vergessen. `dist/` ist nicht eingecheckt, ein frischer Clone hat sie nicht. |
| Server zeigt alten Fingerabdruck | `npm run build` lief nicht oder der Dienst wurde nicht neu gestartet |

Ab Werk erneuert sich die Hülle von allein: Der Cachename trägt einen Hash über
die ausgelieferte Seite, ändert sich also mit jedem Bau, und die Seite lädt sich
einmal neu, sobald der neue Worker übernimmt (nur wenn nichts in der
Warteschlange steht — mitten in eine ungesicherte Aktion hinein wird nicht neu
geladen).

Bis das eingebaut war, konnte man in dieser Falle ewig festsitzen: Der Cachename
hing an `NEUES_SPIEL_VERSION`, die auf `unbekannt` steht, wenn niemand sie setzt.
`sw.js` war nach jedem Deploy byteweise identisch, der Browser sah keinen Grund
für eine Erneuerung — und lieferte für immer die alte Seite. `npm run offlinetest`
prüft das jetzt als Abschnitt 10.

**Mit Gewalt zurücksetzen**, falls doch mal nötig — hilft nur dem einen Gerät:

```
DevTools → Application → Service Workers → Unregister
DevTools → Application → Storage → Clear site data
```

Achtung: „Clear site data" löscht auch `localStorage` — und damit den
**Hof-Schlüssel** auf diesem Gerät. Ohne notierten Schlüssel ist der Hof weg.
Vorher `localStorage.getItem('ns-token')` in der Konsole abfragen und aufheben.

## Grenzen dieses Servers

Er ist ein **Feldtest-Werkzeug**, kein Produktionsserver:

- **Keine Wiederherstellung.** Schlüssel weg heißt Hof weg — es gibt kein
  Passwort und keine E-Mail, über die etwas zurückzuholen wäre.
- **Keine automatischen Backups.** Die Datenbank trägt ein paar tausend
  Spieler, aber niemand sichert sie.
- TLS gibt es (siehe oben), aber **kein Rate-Limit außer beim Anlegen** und keine
  Metriken. Ein entschlossener Angreifer kann `/api/sync` fluten.
- Snapshot-Signatur (§9) fehlt — der Server hält ohnehin seine eigene Kopie.

## Umgebungsvariablen

| Variable | Standard | Wofür |
| --- | --- | --- |
| `NEUES_SPIEL_ENV` / `--env` | — | `dev` oder `prod`. **Pflicht** (Riegel 1). |
| `NEUES_SPIEL_HOST` | dev `0.0.0.0`, prod `127.0.0.1` | Woran der Server lauscht |
| `PORT` | dev 8788, prod 8787 | |
| `NEUES_SPIEL_TLS_CERT` / `_KEY` | — | Eigenes Zertifikat; beide oder keins |
| `NEUES_SPIEL_TLS_CA` | — | Zwischenzertifikate, falls nötig |
| `NEUES_SPIEL_BEHIND_PROXY` | `0` | Ein TLS-Endpunkt steht davor; erlaubt `x-forwarded-for` |
| `NEUES_SPIEL_RULESET` | dev 1001, prod 4 | Zielversion des Regelwerks |
| `NEUES_SPIEL_ADMIN` | dev `1`, prod `0` | Werkbank an/aus (Riegel 3) |
| `NEUES_SPIEL_VERSION` | `unbekannt` | Steht in `/health` |
| `NEUES_SPIEL_DB` | `data/<umgebung>/spiel.db` | Pfad zur Datenbank |
| `NEUES_SPIEL_FLUSH_MS` | 2000 | Takt des gesammelten Schreibens |
| `NEUES_SPIEL_IDLE_MS` | 900000 | Nach dieser Ruhe fliegt ein Hof aus dem Speicher |
| `NEUES_SPIEL_SAVE` / `_TOKEN_FILE` | `data/<umgebung>/…` | Andere Pfade |
| `NEUES_SPIEL_TOKEN` | Datei | Admin-Token vorgeben (landet in der Shell-History) |
| `NEUES_SPIEL_NEW_PER_HOUR` | 20 | Anlege-Bremse je Herkunft |
| `NEUES_SPIEL_MAX_ACCOUNTS` | 5000 | Obergrenze für Höfe |
| `NEUES_SPIEL_MAX_EVENT_STREAMS` | 2000 | Gleichzeitig offene Live-Leitungen (`/api/events`) |
| `NEUES_SPIEL_NUDGE_MS` | 1000 | Mindestabstand zwischen zwei Anstößen an denselben Hof |

**Zu den Live-Leitungen:** Jede offene Verbindung kostet Speicher, auch wenn
stundenlang nichts passiert — auf einer Kiste mit 1 GB ist das die Zahl, an der
sie kippt. `/health` gibt sie als `streams` aus; steht sie dauerhaft an der
Grenze, ist entweder die Grenze zu niedrig oder der Server zu klein. Wer keinen
Platz mehr bekommt, spielt weiter und sieht Marktänderungen ein paar Sekunden
später — die Leitung ist eine Beschleunigung, keine Voraussetzung.

Steht ein **nginx** davor, braucht die Route `proxy_buffering off;` und
`proxy_read_timeout` deutlich über dem Herzschlag von 25 Sekunden. Ohne das
sammelt der Proxy die Anstöße, bis genug beisammen ist — und hält damit genau
die Nachricht zurück, deren einziger Zweck es ist, sofort anzukommen.

## Was der Markt braucht — und was nicht

Nichts einzustellen. Das Buch entsteht von allein: Wer einen Verkaufsauftrag
einstellt, landet beim nächsten Sync darin, und wer zurückzieht, fliegt heraus.
Zum Ausprobieren zwei Höfe anlegen, mit dem einen etwas einstellen, mit dem
anderen kaufen.

Wie viele Angebote gerade offen sind, sagt `/health` (`offers`). Die Auslage ist
auf `offerSlots` (12) begrenzt und nach Stückpreis sortiert — den ganzen Markt in
jeden Snapshot zu legen wäre bei tausend Höfen ein Megabyte pro Anfrage.

Ehrlich zur Grenze: Der Markt läuft **in einem Prozess**. Genau das serialisiert
die Käufe — zwischen „ist das Angebot noch da" und „es ist jetzt meins" liegt
keine Lücke, weil Node einfädig ist. Bei mehreren Serverprozessen müsste diese
Reihenfolge woanders erzwungen werden.

Das Buch liegt im Speicher und wird in dieselbe Datenbank geschrieben wie die
Höfe. Abrechnungen gehen sofort raus, Angebote gesammelt — die Begründung steht
oben bei „Drei Dinge, die das möglich machen".

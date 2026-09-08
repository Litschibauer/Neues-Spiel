# Neues Spiel — native iOS-Hülle

Eine native App (Capacitor), die die Spieloberfläche vom Live-Server zeigt.
Bewusst **getrennt** vom Kern: eigenes `package.json`, eigene `node_modules`.
Der Kern in `../` bleibt abhängigkeitsfrei.

Die App zeigt immer den **aktuellen Stand vom Server** — du musst für ein
Spiel-Update also nichts neu bauen oder einreichen.

> Alles hier braucht **macOS + Xcode**.

## Server

Eingetragen in `capacitor.config.json`:

```json
"server": { "url": "https://5-252-103-214.sslip.io" }
```

Weil das **HTTPS** ist, brauchst du **keine ATS-Ausnahme** in der `Info.plist`,
und Mac und iPhone müssen **nicht** im selben WLAN sein — die App läuft auch
über Mobilfunk.

## Einmalig einrichten

```bash
# Xcode aus dem App Store installieren, dann einmal öffnen (Lizenz bestätigen)
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -runFirstLaunch

brew install cocoapods

cd ios-app
npm install
npx cap add ios          # erzeugt ios/ mit dem Xcode-Projekt — nur einmal nötig
```

## Auf dem iPhone starten

```bash
cd ios-app
npm run ios
```

Das synchronisiert die Oberfläche, setzt den nativen Rahmen (Symbol,
Querformat) und öffnet Xcode.

In Xcode:

1. iPhone per Kabel anstecken, oben als Ziel auswählen.
2. Links `App` anklicken → Reiter **Signing & Capabilities**.
3. **Team**: deine Apple-ID auswählen (kostenlos genügt). Falls der Bundle
   Identifier abgelehnt wird, eindeutig machen: `com.deinname.neuesspiel`.
4. ▶︎ **Run**.
5. Am iPhone einmalig: *Einstellungen → Allgemein → VPN & Geräteverwaltung →
   Entwickler-App vertrauen*.

Mit einer kostenlosen Apple-ID läuft die Signatur nach **7 Tagen** ab; dann
einfach in Xcode neu starten. Das Developer Program (99 €/Jahr) hebt das auf
und schaltet TestFlight und den App Store frei.

## Der native Rahmen

Zwei Dinge muessen anders sein als in Capacitors Vorgabe: das **App-Symbol**
und die **Querformat-Sperre**. Beides setzt `scripts/nativ-einrichten.sh`, und
das laeuft bei jedem `npm run sync` automatisch mit — man kann es also weder
vergessen noch doppelt kaputtmachen.

- **Querformat**: schreibt `UISupportedInterfaceOrientations` in die
  `Info.plist` (iPhone und iPad). Nur dort sperrt iOS die Ausrichtung
  verbindlich; das Manifest allein reicht der nativen App nicht.
- **Symbol**: erzeugt alle iOS-Groessen aus `web/icon.png` — aber nur, wenn die
  Quelle neuer ist als das bereits Erzeugte.

Weitere native Einstellungen gehoeren **in dieses Skript**, nicht in ein neues
npm-Skript.

Die Quelldatei passt bereits ohne Nacharbeit: 1254x1254, quadratisch und ohne
Alphakanal — Transparenz lehnt Apple bei App-Symbolen ab.

**Wenn das alte Symbol kleben bleibt:** iOS merkt sich Symbole hartnaeckig.
Dann die App am iPhone loeschen und aus Xcode neu installieren.

## Querformat im Spiel

Die Oberflaeche erkennt Querformat selbst (`istQuer()` in `web/farm/raster.js`)
und das Manifest fordert es an. Die Browser-Tests messen das Layout bei
844 x 390 mit (Abschnitt „9y. Querformat").

## Optional: gegen den lokalen Server testen

Nur nötig, wenn du Änderungen testen willst, die noch nicht auf dem Server sind.

```bash
cd .. && npm run dev            # lauscht auf 0.0.0.0:8788
ipconfig getifaddr en0          # IP des Macs, z. B. 192.168.1.42
```

`server.url` auf `http://192.168.1.42:8788` setzen und `"cleartext": true`
danebenschreiben. Weil das unverschlüsselt ist, blockiert iOS die Verbindung —
dafür einmalig in `ios/App/App/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

Dann `npm run sync` und neu starten. Für den Release wieder auf die
HTTPS-Adresse zurückstellen.

## Danach: echte App-Store-Fassung

Der jetzige Aufbau lädt die Oberfläche **vom Server**. Für den App Store gehört
sie mit ins Paket, damit die App auch ohne Netz sofort startet. Dafür fehlen
noch zwei Dinge:

1. **Konfigurierbare Server-Adresse im Client.** Alle Aufrufe sind heute relativ
   (`/api/…`) und laufen über den `api()`-Helfer in `web/farm/verbindung.js`
   plus vier direkte `fetch` (`/api/account`, `/api/events`, `/musik/` 2×).
   Die brauchen eine Basis-Adresse, weil die App dann unter
   `capacitor://localhost` läuft.
2. **CORS im Server.** Der Server sendet heute keine
   `Access-Control-Allow-Origin`-Kopfzeilen; aus dem App-Paket heraus wären die
   Aufrufe sonst blockiert. Die Anmeldung ist unkritisch, sie läuft über
   Bearer-Token statt Cookies.

Bis dahin ist der `server.url`-Weg der richtige — er funktioniert vollständig,
inklusive Offline-Weiterspielen über den Service Worker (der Server liefert
HTTPS, also registriert er sich).

## Benachrichtigungen (Push)

Die App bekommt ihre Meldungen über **Apple (APNs)**, nicht über Web-Push:
Apple erlaubt Web-Push nur für PWAs auf dem Startbildschirm, nicht in der
WKWebView einer App. Das Plugin `@capacitor/push-notifications` ist bereits
eingetragen, `npm run sync` installiert es mit.

### In Xcode (einmalig, geht nur dort)

1. Projekt öffnen: `npm run ios`
2. Ziel **App** auswählen → Reiter **Signing & Capabilities**
3. **+ Capability** → **Push Notifications** hinzufügen
4. **+ Capability** → **Background Modes** → Häkchen bei **Remote notifications**

Dafür brauchst du ein **kostenpflichtiges Apple-Entwicklerkonto**; mit einem
kostenlosen Konto lässt sich die Push-Berechtigung nicht vergeben.

### Im Apple-Developer-Portal (einmalig)

1. **Certificates, Identifiers & Profiles → Keys → +**
2. Häkchen bei **Apple Push Notifications service (APNs)**, Schlüssel erzeugen
3. Die Datei `AuthKey_XXXXXXXXXX.p8` **einmal** herunterladen (geht nur einmal!)
4. Notiere **Key ID** (im Dateinamen) und **Team ID** (oben rechts im Portal)

### Auf dem Server

Die `.p8`-Datei auf den Server legen, dann diese Variablen setzen:

```
NEUES_SPIEL_APNS_KEY_FILE=/pfad/zu/AuthKey_XXXXXXXXXX.p8
NEUES_SPIEL_APNS_KEY_ID=XXXXXXXXXX
NEUES_SPIEL_APNS_TEAM_ID=YYYYYYYYYY
NEUES_SPIEL_APNS_BUNDLE_ID=com.litschibauer.neuesspiel
NEUES_SPIEL_APNS_SANDBOX=1
```

`SANDBOX=1` gilt für Builds, die direkt aus Xcode aufs Gerät kommen. Für
TestFlight und den App Store muss es **weg** (oder auf `0`), sonst weist Apple
die Zustellung ab. Fehlen die Variablen, bleibt APNs einfach aus und der Rest
des Servers läuft normal weiter.

Ob alles sitzt, steht im Dashboard unter **Benachrichtigung senden**: Dort
zählt „Erreichbar" die Geräte getrennt nach Browser und App und warnt, wenn
App-Geräte da sind, aber der Apple-Schlüssel fehlt.

## Für den App Store bündeln

Im Alltag lädt die App die Oberfläche vom Server (`server.url`) — jede Änderung
ist sofort auf dem Gerät, ohne neue Einreichung. Für den App Store ist das
riskant: Apple prüft eine App, die ohne Netz nur eine leere Seite zeigt, gern
negativ. Darum lässt sich die Oberfläche ins Paket legen:

```bash
npm run buendeln -- https://5-252-103-214.sslip.io
```

Das baut die Seite, schreibt die Serveradresse als `window.NEUES_SPIEL_SERVER`
davor und legt beides in `www/`. Danach in `capacitor.config.json` den Block
`server` entfernen und `npm run sync` laufen lassen.

Die Spieldaten kommen weiter vom Server. Weil die Oberfläche dann von
`capacitor://localhost` stammt, muss der Server diese Herkunft erlauben — das
tut er von sich aus, einstellbar über `NEUES_SPIEL_APP_ORIGINS`.

### Was Apple sonst noch will

Das kann dir niemand abnehmen, es gehört aber zur Liste:

* Entwicklerkonto (99 USD im Jahr) und eine App-ID im Portal
* Datenschutzerklärung unter einer öffentlich erreichbaren Adresse
* App-Symbol in allen Größen (macht `npm run sync` bereits) und Screenshots
  für jede geforderte Gerätegröße
* Altersfreigabe ausfüllen; das Spiel hat keine Käufe und keine Werbung,
  das vereinfacht die Angaben zum Datenschutz erheblich
* Ein Testkonto ist nicht nötig, weil das Spiel ohne Anmeldung startet

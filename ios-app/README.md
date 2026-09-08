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
npx cap sync ios
npx cap open ios          # öffnet Xcode
```

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

## App-Symbol

Ein Befehl im Ordner `ios-app`:

```bash
npm run icon
```

Der holt `web/icon.png`, erzeugt daraus alle iOS-Größen und synchronisiert.
Danach in Xcode neu starten (▶︎).

Das vorhandene Symbol passt bereits: 1254x1254, quadratisch und **ohne
Alphakanal** — Apple lehnt Transparenz in App-Symbolen ab.

**Wenn das alte Symbol kleben bleibt:** iOS merkt sich Symbole hartnäckig.
Dann die App am iPhone löschen und aus Xcode neu installieren.

## Querformat

Die Oberfläche erkennt Querformat selbst (`istQuer()` in `web/farm/raster.js`).
Capacitor erlaubt standardmäßig alle Ausrichtungen — in Xcode unter
*General → Deployment Info* bei Bedarf einschränken.

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

Dann `npx cap sync ios` und neu starten. Für den Release wieder auf die
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

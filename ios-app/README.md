# Neues Spiel — native iOS-Hülle

Eine dünne native App (Capacitor), die die Spieloberfläche in einer WebView zeigt.
Bewusst **getrennt** vom Kern: eigenes `package.json`, eigene `node_modules`. Der
Kern in `../` bleibt abhängigkeitsfrei.

> Alles hier braucht **macOS + Xcode**. Auf Linux lässt sich das iOS-Projekt nicht erzeugen.

## Einmalig einrichten

```bash
# 1. Xcode aus dem App Store installieren, dann einmal öffnen (Lizenz bestätigen)
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -runFirstLaunch

# 2. CocoaPods (verwaltet die nativen Abhängigkeiten)
brew install cocoapods

# 3. Hülle vorbereiten
cd ios-app
npm install
npx cap add ios          # erzeugt den Ordner ios/ mit dem Xcode-Projekt
```

`npx cap add ios` läuft **nur einmal**. Der erzeugte `ios/`-Ordner gehört ins Repo.

## Server-Adresse eintragen

Die App lädt die Oberfläche vom laufenden Server — deshalb muss in
`capacitor.config.json` unter `server.url` eine Adresse stehen, die **das iPhone
erreichen kann**. `localhost` funktioniert dort nicht.

```bash
# Im Projekt-Hauptordner: Server starten (lauscht bereits auf 0.0.0.0:8788)
cd .. && npm run dev

# IP des Macs herausfinden
ipconfig getifaddr en0        # z. B. 192.168.1.42
```

Dann in `ios-app/capacitor.config.json` eintragen:

```json
"server": { "url": "http://192.168.1.42:8788", "cleartext": true }
```

Mac und iPhone müssen im **selben WLAN** sein.

### ⚠️ App Transport Security (ATS)

iOS blockiert unverschlüsseltes `http://` aus nativen Apps. Für den lokalen
Testbetrieb einmalig in `ios/App/App/Info.plist` ergänzen:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

`NSAllowsLocalNetworking` erlaubt nur das lokale Netz — für den späteren
Release mit HTTPS-Server kann der Eintrag wieder raus.

## Auf dem iPhone starten

```bash
cd ios-app
npx cap sync ios
npx cap open ios          # öffnet Xcode
```

In Xcode:

1. iPhone per Kabel anstecken, oben als Ziel auswählen.
2. Links `App` anklicken → Reiter **Signing & Capabilities**.
3. **Team**: deine Apple-ID auswählen (kostenlos genügt). Bei Bedarf die
   **Bundle Identifier** eindeutig machen, z. B. `com.deinname.neuesspiel`.
4. ▶︎ **Run**.
5. Am iPhone einmalig: *Einstellungen → Allgemein → VPN & Geräteverwaltung →
   Entwickler-App vertrauen*.

Mit einer kostenlosen Apple-ID läuft die Signatur nach **7 Tagen** ab; dann
einfach neu starten. Das Developer Program (99 €/Jahr) hebt das auf und
schaltet TestFlight und den App Store frei.

## App-Symbol

Das vorhandene Symbol lässt sich direkt übernehmen:

```bash
cd ios-app
npm i -D @capacitor/assets
mkdir -p assets && cp ../web/icon.png assets/icon.png
npx @capacitor/assets generate --ios
```

## Querformat

Die Oberfläche erkennt Querformat selbst (`istQuer()` in `web/farm/raster.js`).
Capacitor erlaubt standardmäßig alle Ausrichtungen — in Xcode unter
*General → Deployment Info* bei Bedarf einschränken.

## Danach: echte App-Store-Fassung

Der jetzige Aufbau lädt die Oberfläche **vom Server**. Für den App Store gehört
sie mit ins Paket, damit die App auch ohne Netz sofort startet. Dafür fehlen
noch zwei Dinge:

1. **Konfigurierbare Server-Adresse im Client.** Alle Aufrufe sind heute relativ
   (`/api/…`) und laufen über den `api()`-Helfer in `web/farm/verbindung.js`
   plus vier direkte `fetch` (`/api/account`, `/api/events`, `/musik/` 2×).
   Die brauchen eine Basis-Adresse, weil die App unter `capacitor://localhost`
   läuft.
2. **CORS im Server.** Der Server sendet heute keine
   `Access-Control-Allow-Origin`-Kopfzeilen; aus dem App-Paket heraus wären die
   Aufrufe sonst blockiert. Die Anmeldung selbst ist unkritisch, sie läuft über
   Bearer-Token statt Cookies.

Solange beides nicht da ist, ist die `server.url`-Variante der richtige Weg —
sie funktioniert vollständig, inklusive Offline-Weiterspielen über den
Service Worker (sobald der Server per HTTPS läuft).

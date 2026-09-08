#!/usr/bin/env bash
# Alles, was am nativen Rahmen anders sein muss als Capacitors Vorgabe:
# App-Symbol und Querformat-Sperre.
#
# Laeuft bei jedem "npm run sync" mit und ist idempotent — man kann es nicht
# vergessen und nicht doppelt kaputtmachen. Neue native Einstellungen kommen
# hier dazu, nicht als weiteres npm-Skript.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d ios ]; then
  echo "  nativer Rahmen: noch kein ios/ — erst 'npx cap add ios'"
  exit 0
fi

# --- Querformat sperren -----------------------------------------------------
# Das Spiel ist fuer einen breiten, waagerecht geschwenkten Hof gebaut.
# Nur die Info.plist sperrt die Ausrichtung fuer iOS verbindlich.
PLIST="ios/App/App/Info.plist"
PB="/usr/libexec/PlistBuddy"

setze_ausrichtung() {
  local key="$1"
  "$PB" -c "Delete :$key" "$PLIST" >/dev/null 2>&1 || true
  "$PB" -c "Add :$key array" "$PLIST"
  "$PB" -c "Add :$key: string UIInterfaceOrientationLandscapeLeft" "$PLIST"
  "$PB" -c "Add :$key: string UIInterfaceOrientationLandscapeRight" "$PLIST"
}

setze_ausrichtung "UISupportedInterfaceOrientations"
setze_ausrichtung "UISupportedInterfaceOrientations~ipad"
echo "  nativer Rahmen: Querformat gesetzt"

# --- App-Symbol -------------------------------------------------------------
# Nur neu erzeugen, wenn die Quelle neuer ist als das Erzeugte. Sonst kostet
# jeder sync unnoetig Zeit.
QUELLE="../web/icon.png"
ZIEL="ios/App/App/Assets.xcassets/AppIcon.appiconset"

if [ ! -f "$QUELLE" ]; then
  echo "  nativer Rahmen: $QUELLE fehlt — Symbol uebersprungen"
elif [ -d "$ZIEL" ] && [ ! "$QUELLE" -nt "$ZIEL" ]; then
  echo "  nativer Rahmen: Symbol ist aktuell"
else
  mkdir -p assets
  cp "$QUELLE" assets/icon.png
  npx capacitor-assets generate --ios >/dev/null
  echo "  nativer Rahmen: Symbol erzeugt"
fi

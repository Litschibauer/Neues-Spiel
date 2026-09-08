#!/usr/bin/env bash
# Sperrt die App aufs Querformat. Das Spiel ist für einen breiten, waagerecht
# geschwenkten Hof gebaut — Hochformat zeigt zu wenig davon.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PLIST="ios/App/App/Info.plist"
PB="/usr/libexec/PlistBuddy"

if [ ! -f "$PLIST" ]; then
  echo "FEHLER: $PLIST fehlt. Erst 'npx cap add ios' ausfuehren." >&2
  exit 1
fi

setze() {
  local key="$1"
  "$PB" -c "Delete :$key" "$PLIST" >/dev/null 2>&1 || true
  "$PB" -c "Add :$key array" "$PLIST"
  "$PB" -c "Add :$key: string UIInterfaceOrientationLandscapeLeft" "$PLIST"
  "$PB" -c "Add :$key: string UIInterfaceOrientationLandscapeRight" "$PLIST"
}

setze "UISupportedInterfaceOrientations"
setze "UISupportedInterfaceOrientations~ipad"

echo "Querformat gesetzt (iPhone):"
"$PB" -c "Print :UISupportedInterfaceOrientations" "$PLIST"

#!/usr/bin/env bash
# Baut die Oberfläche in die App hinein, statt sie vom Server zu laden.
#
# Zwei Betriebsarten hat die App:
#   Server-Modus (Standard)   — capacitor.config.json hat server.url, die App
#                               zeigt immer den aktuellen Stand, ohne neue
#                               Einreichung. Gut zum Entwickeln.
#   Gebündelt (App Store)     — die Oberfläche liegt im App-Paket, nur die
#                               Spieldaten kommen vom Server. Apple verlangt
#                               das für Apps, die ohne Netz starten sollen.
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KERN="$(cd "$HIER/.." && pwd)"
SERVER="${1:-}"

if [ -z "$SERVER" ]; then
  echo "Aufruf: npm run buendeln -- https://dein-server"
  echo "Die Adresse landet als window.NEUES_SPIEL_SERVER in der App."
  exit 1
fi

echo "→ Oberfläche bauen"
( cd "$KERN" && npm run build >/dev/null )

SEITE="$KERN/dist/farm.html"
[ -f "$SEITE" ] || { echo "dist/farm.html fehlt — npm run build im Kern schlug fehl."; exit 1; }

echo "→ Server eintragen: $SERVER"
mkdir -p "$HIER/www"
{
  printf '<script>window.NEUES_SPIEL_SERVER=%s;</script>\n' "\"${SERVER%/}\""
  cat "$SEITE"
} > "$HIER/www/index.html"

echo "→ Service Worker mitnehmen (offline starten)"
curl -fsS "${SERVER%/}/sw.js" -o "$HIER/www/sw.js" 2>/dev/null || \
  echo "  (sw.js nicht geholt — die App läuft auch ohne, nur ohne Offline-Hülle)"

cat <<INFO

Fertig. Jetzt noch:
  1. In capacitor.config.json den Block "server" ENTFERNEN oder auskommentieren,
     sonst lädt die App weiter vom Netz statt aus dem Paket.
  2. Auf dem Server die Herkunft der App erlauben:
       NEUES_SPIEL_APP_ORIGINS=capacitor://localhost,ionic://localhost
     (das ist auch der Standard — nur nötig, wenn du ihn überschrieben hast)
  3. npm run sync && npm run ios

INFO

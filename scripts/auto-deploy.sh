#!/usr/bin/env bash
# Auto-Deploy: zieht den Branch, wenn origin neuer ist — aber der neue Stand
# kommt erst auf den Server, wenn er seine eigenen Tests besteht. Ein roter
# Stand wird gemerkt und nicht bei jedem Timer-Lauf neu geprüft; der nächste
# Commit bekommt wieder seine Chance.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$branch"

local_rev="$(git rev-parse HEAD)"
remote_rev="$(git rev-parse "origin/$branch")"

if [ "$local_rev" = "$remote_rev" ]; then
  exit 0
fi

mkdir -p data
abgelehnt="data/deploy-abgelehnt"
if [ -f "$abgelehnt" ] && [ "$(cat "$abgelehnt")" = "$remote_rev" ]; then
  # Schon geprüft, schon durchgefallen. Kein Grund, es alle zwei Minuten zu wiederholen.
  exit 0
fi

echo "[auto-deploy] $branch: ${local_rev:0:8} -> ${remote_rev:0:8}"
git reset --hard "origin/$branch"

# Der Riegel: erst prüfen, dann bauen, dann neu starten. Fällt die Prüfung
# durch, bleibt der alte Stand ausgecheckt und der Dienst läuft unberührt weiter.
pruefung="data/deploy-pruefung.log"
if ! npm test > "$pruefung" 2>&1; then
  echo "[auto-deploy] Tests rot bei ${remote_rev:0:8} — Dienst bleibt auf ${local_rev:0:8}. Auszug:"
  grep -E "^not ok|^# (tests|pass|fail)" "$pruefung" | head -20 || tail -20 "$pruefung"
  echo "$remote_rev" > "$abgelehnt"
  git reset --hard "$local_rev"
  exit 1
fi
rm -f "$abgelehnt"

npm run build

systemctl restart neues-spiel-prod
echo "[auto-deploy] geprüft, gebaut und Dienst neu gestartet: ${remote_rev:0:8}"

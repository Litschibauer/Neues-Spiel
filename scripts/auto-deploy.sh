#!/usr/bin/env bash
# Auto-Deploy: zieht den Branch, wenn origin neuer ist — aber der neue Stand
# kommt erst auf den Server, wenn er die Prüfung besteht. Auf dem Server läuft
# die LEICHTE Suite: alle Tests außer den dreien, die die 63-MB-Golden-Vektoren
# in den Speicher laden (golden, conformance-bundle, session-fuzz). Die laufen
# auf GitHub bei jedem Push und bei dem, der pusht — ein 1-GB-Server erstickt
# daran. Ein roter Stand wird gemerkt und nicht bei jedem Timer-Lauf neu
# geprüft; der nächste Commit bekommt wieder seine Chance.
#
# Der Zustand des Riegels steht in data/deploy-stand.json; /health zeigt ihn.
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
stand="data/deploy-stand.json"
pruefung="data/deploy-pruefung.log"

schreibe_stand() {
  # $1 Ergebnis, $2 Dauer in Sekunden, $3 Auszug (Text, mehrzeilig)
  node -e '
const [rev, ergebnis, dauer, auszug] = process.argv.slice(1);
console.log(JSON.stringify({ rev: rev.slice(0, 8), ergebnis, dauerS: Number(dauer), zeit: new Date().toISOString(), auszug: auszug.split("\n").filter(Boolean).slice(0, 20) }));
' "$remote_rev" "$1" "$2" "$3" > "$stand"
}

if [ -f "$abgelehnt" ] && [ "$(cat "$abgelehnt")" = "$remote_rev" ]; then
  # Schon geprüft, schon durchgefallen. Kein Grund, es alle zwei Minuten zu wiederholen.
  exit 0
fi

echo "[auto-deploy] $branch: ${local_rev:0:8} -> ${remote_rev:0:8}"
git reset --hard "origin/$branch"
schreibe_stand "laeuft" 0 ""

# Die leichte Suite: nacheinander (ein Prozess), mit Zeitlimit, ein Wiederholungsversuch
# gegen Zeitflimmern auf einer langsamen Maschine.
leicht=$(ls test/*.test.ts | grep -vE 'golden\.test|conformance-bundle|session-fuzz')
begonnen=$(date +%s)
gruen=0
for versuch in 1 2; do
  if timeout 20m node --experimental-strip-types --no-warnings=ExperimentalWarning --test --test-concurrency=1 $leicht > "$pruefung" 2>&1; then
    gruen=1
    break
  fi
  echo "[auto-deploy] Versuch $versuch rot"
done
dauer=$(( $(date +%s) - begonnen ))

if [ "$gruen" != "1" ]; then
  auszug="$(grep -E '^not ok|^# (tests|pass|fail)' "$pruefung" | head -20 || tail -20 "$pruefung")"
  echo "[auto-deploy] Tests rot bei ${remote_rev:0:8} nach ${dauer}s — Dienst bleibt auf ${local_rev:0:8}. Auszug:"
  echo "$auszug"
  echo "$remote_rev" > "$abgelehnt"
  git reset --hard "$local_rev"
  schreibe_stand "rot" "$dauer" "$auszug"
  exit 1
fi
rm -f "$abgelehnt"

npm run build
schreibe_stand "gruen" "$dauer" "$(grep -E '^# (tests|pass|fail)' "$pruefung" | tr '\n' ' ')"

systemctl restart neues-spiel-prod
echo "[auto-deploy] geprüft (${dauer}s), gebaut und Dienst neu gestartet: ${remote_rev:0:8}"

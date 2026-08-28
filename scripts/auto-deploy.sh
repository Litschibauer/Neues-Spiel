#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$branch"

local_rev="$(git rev-parse HEAD)"
remote_rev="$(git rev-parse "origin/$branch")"

if [ "$local_rev" = "$remote_rev" ]; then
  exit 0
fi

echo "[auto-deploy] $branch: ${local_rev:0:8} -> ${remote_rev:0:8}"
git reset --hard "origin/$branch"

npm run build

systemctl restart neues-spiel-prod
echo "[auto-deploy] gebaut und Dienst neu gestartet"

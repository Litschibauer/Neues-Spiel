#!/usr/bin/env bash
#
# Stellt den Spielserver öffentlich — mit Zertifikat, ohne Tailscale und ohne
# gekaufte Domain. Läuft AUF DEM SERVER als root:
#
#   sudo bash scripts/oeffentlich.sh                  # Adresse aus der IP
#   sudo bash scripts/oeffentlich.sh hof.example.de   # eigene Domain
#
# Was es tut: Caddy installieren, die Adresse eintragen, den Spielserver
# hinter den Proxy stellen, Ports öffnen, neu laden, nachsehen ob es geht.
# Alles einzeln nachlesbar in docs/deploy.md.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
	echo "Bitte mit sudo starten." >&2
	exit 1
fi

UNIT=/etc/systemd/system/neues-spiel-prod.service
CADDYFILE=/etc/caddy/Caddyfile

sagen() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ── 1. Adresse bestimmen ───────────────────────────────────────────────
if [ $# -ge 1 ]; then
	ADRESSE="$1"
else
	sagen "Öffentliche Adresse suchen"
	IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
	if ! printf '%s' "$IP" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
		echo "Konnte die öffentliche IP nicht ermitteln." >&2
		echo "Adresse selbst angeben:  sudo bash $0 85-1-2-3.sslip.io" >&2
		exit 1
	fi
	ADRESSE="$(printf '%s' "$IP" | tr '.' '-').sslip.io"
	echo "IP $IP  →  $ADRESSE"
fi

# ── 2. Caddy installieren ──────────────────────────────────────────────
if command -v caddy >/dev/null 2>&1; then
	sagen "Caddy ist schon da ($(caddy version | head -1))"
else
	sagen "Caddy installieren"
	if ! command -v apt-get >/dev/null 2>&1; then
		echo "Kein apt — hier hilft nur die Binärdatei von caddyserver.com/download." >&2
		exit 1
	fi
	apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update
	apt-get install -y caddy
fi

# ── 3. Adresse eintragen ───────────────────────────────────────────────
sagen "Caddy einrichten für $ADRESSE"
if [ -f "$CADDYFILE" ] && ! grep -q 'reverse_proxy 127.0.0.1:8787' "$CADDYFILE"; then
	cp "$CADDYFILE" "$CADDYFILE.vorher.$(date +%Y%m%d-%H%M%S)"
	echo "Alte Datei gesichert."
fi
cat > "$CADDYFILE" <<EOF
$ADRESSE {
	reverse_proxy 127.0.0.1:8787
	encode gzip
	header -Server
}
EOF
caddy fmt --overwrite "$CADDYFILE" >/dev/null 2>&1 || true
caddy validate --config "$CADDYFILE" --adapter caddyfile

# ── 4. Spielserver hinter den Proxy stellen ────────────────────────────
if [ -f "$UNIT" ]; then
	if grep -q 'NEUES_SPIEL_BEHIND_PROXY' "$UNIT"; then
		sagen "Der Dienst weiß schon vom Proxy"
	else
		sagen "NEUES_SPIEL_BEHIND_PROXY=1 in den Dienst eintragen"
		sed -i 's|^Environment=NEUES_SPIEL_VERSION=|Environment=NEUES_SPIEL_BEHIND_PROXY=1\nEnvironment=NEUES_SPIEL_VERSION=|' "$UNIT"
		systemctl daemon-reload
		systemctl restart neues-spiel-prod
	fi
else
	sagen "Achtung"
	echo "$UNIT gibt es nicht — läuft der Spielserver von Hand?"
	echo "Dann beim Start NEUES_SPIEL_BEHIND_PROXY=1 mitgeben, sonst zählt"
	echo "die Anlege-Bremse alle Spieler als eine Adresse."
fi

# ── 5. Ports ───────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
	sagen "Ports 80 und 443 in ufw öffnen"
	ufw allow 80,443/tcp
fi

# ── 6. Starten und nachsehen ───────────────────────────────────────────
sagen "Caddy neu laden"
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

echo "Warte auf das Zertifikat …"
for i in $(seq 1 30); do
	ANTWORT="$(curl -fsS --max-time 5 "https://$ADRESSE/health" 2>/dev/null || true)"
	if [ -n "$ANTWORT" ]; then break; fi
	sleep 2
done

sagen "Ergebnis"
if [ -z "${ANTWORT:-}" ]; then
	echo "Noch keine Antwort über https://$ADRESSE"
	echo
	echo "Das liegt fast immer an den Ports. Nachsehen:"
	echo "  journalctl -u caddy -n 40 --no-pager"
	echo "  ss -tlnp | grep -E ':80|:443'"
	echo "Und in der Firewall des Anbieters müssen 80 und 443 offen sein —"
	echo "das ist eine eigene Ebene, unabhängig von ufw."
	exit 1
fi

echo "$ANTWORT"
if printf '%s' "$ANTWORT" | grep -q '"secure":true'; then
	echo
	echo "Fertig. Gespielt wird über:"
	echo
	echo "    https://$ADRESSE"
	echo
	echo "Diese Adresse weitergeben, nicht die IP mit Port."
else
	echo
	echo "Der Server antwortet, meldet aber secure:false — dann fehlt dem"
	echo "Dienst NEUES_SPIEL_BEHIND_PROXY=1. Siehe docs/deploy.md."
	exit 1
fi

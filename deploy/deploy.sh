#!/bin/sh
# Deploy der Website des DC Torpedo.
#
# Wird von der GitHub Action per SSH aufgerufen – als Zwangsbefehl in
# authorized_keys, d. h. der Deploy-Schlüssel kann NUR dieses Skript starten.
# Von Hand geht es auch:  torpedo-deploy
#
# Installation (einmalig, als root; nach Änderungen an diesem Skript wiederholen):
#   install -m 755 /home/torpedo-website/deploy/deploy.sh /usr/local/sbin/torpedo-deploy
#
# Das Skript liegt bewusst AUSSERHALB des Repos und übernimmt Änderungen an
# docker-compose.yml nicht automatisch. So kann ein Push auf GitHub nur Inhalte
# ausrollen (gebaut in einem abgeschotteten Container), aber nie Befehle auf
# dem Server ausführen.
#
# Ablauf: neuesten Stand holen → Seiten bauen → nginx prüfen und sanft neu
# laden → Redaktion/Liga-Sync bei Code-Änderungen neu starten → deploy.json.

set -eu

REPO_DIR="${TORPEDO_DIR:-/home/torpedo-website}"
cd "$REPO_DIR"

# Nur ein Deploy gleichzeitig (weitere warten bis zu 5 Minuten)
exec 9>/tmp/torpedo-deploy.lock
if ! flock -w 300 9; then
    echo "Ein anderer Deploy läuft noch – Abbruch." >&2
    exit 1
fi

REQ=$(printf '%s' "${SSH_ORIGINAL_COMMAND:-}" | tr -cd '0-9a-f' | cut -c1-40)
[ -n "$REQ" ] && echo "Angefordert: $REQ"

BRANCH=$(sed -n 's/.*"branch": *"\([^"]*\)".*/\1/p' site.config.json | head -n 1)
BRANCH=${BRANCH:-master}

OLD=$(git rev-parse HEAD)
git fetch -q origin "$BRANCH"
git checkout -q -f -B "$BRANCH" "origin/$BRANCH"
NEW=$(git rev-parse HEAD)
echo "Stand: $(git log -1 --format='%h %s')"

changed() {
    [ "$OLD" != "$NEW" ] && ! git diff --quiet "$OLD" "$NEW" -- "$@"
}

# Seiten bauen – in einem Container ohne Netzwerk, als Besitzer des Repos
OWNER=$(stat -c '%u:%g' "$REPO_DIR")
docker run --rm --network none -u "$OWNER" -v "$REPO_DIR:/site" -w /site node:22-alpine node tools/build.mjs

# nginx: Konfiguration prüfen, dann sanft neu laden (laufende Verbindungen bleiben)
if ! docker compose exec -T web nginx -t -q; then
    echo "nginx-Konfiguration fehlerhaft oder Container 'web' läuft nicht – nichts neu geladen." >&2
    exit 1
fi
docker compose exec -T web nginx -s reload

# Code der Redaktion bzw. des Liga-Syncs geändert → nur diese Container neu starten
if changed admin/; then
    docker compose restart admin
fi
if changed deploy/liga-sync.sh; then
    docker compose restart liga-sync
fi

# Änderungen, die bewusst NICHT automatisch übernommen werden
if changed docker-compose.yml deploy/nginx-proxy.yml; then
    echo "::warning::docker-compose.yml geändert – auf dem Server bitte von Hand prüfen und 'docker compose up -d' ausführen."
fi
if changed deploy/deploy.sh; then
    echo "::warning::deploy/deploy.sh geändert – auf dem Server bitte neu installieren: install -m 755 $REPO_DIR/deploy/deploy.sh /usr/local/sbin/torpedo-deploy"
fi

# Für die Redaktion: welcher Stand ist online?
printf '{"commit":"%s","time":"%s"}\n' "$NEW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > public/deploy.json.tmp
mv public/deploy.json.tmp public/deploy.json

echo "Deploy ok: $(git rev-parse --short HEAD)"

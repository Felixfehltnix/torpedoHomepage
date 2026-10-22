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
# docker-compose.yml nicht automatisch. Code aus dem Repo läuft dadurch nur in
# Containern: der Build (tools/build.mjs) ohne Netzwerk als "nobody", der nur
# die erzeugten Dateien schreiben darf, und die Redaktion als "node".
# Trotzdem gilt: Wer auf master pushen darf, bestimmt, was dort läuft – und vor
# jedem "docker compose up -d" von Hand gehört der Diff der Compose-Datei geprüft.
#
# Ablauf: neuesten Stand holen → Seiten bauen → nginx prüfen und sanft neu
# laden → Redaktion/Liga-Sync bei Code-Änderungen neu starten → deploy.json.

set -eu
trap 'rc=$?; [ "$rc" -eq 0 ] || echo "Deploy abgebrochen (Fehlercode $rc) – online bleibt der bisherige Stand." >&2' EXIT

# Fest eingestellt – bewusst NICHT aus dem Repo gelesen, denn alles im Repo
# kann ein Push verändern.
REPO_DIR="${TORPEDO_DIR:-/home/torpedo-website}"
BRANCH="${TORPEDO_BRANCH:-master}"
PROJECT="${TORPEDO_PROJECT:-$(basename "$REPO_DIR")}"   # Name des Compose-Projekts
case "$BRANCH" in
    "" | -* | *[!A-Za-z0-9._/-]*) echo "Ungültiger Branch-Name." >&2; exit 1 ;;
esac
cd "$REPO_DIR"

# Nur ein Deploy gleichzeitig (weitere warten bis zu 5 Minuten).
# Sperrdatei unter /run (nur root darf dort schreiben), nicht in /tmp.
exec 9>/run/torpedo-deploy.lock
if ! flock -w 300 9; then
    echo "Ein anderer Deploy läuft noch – Abbruch." >&2
    exit 1
fi

REQ=$(printf '%s' "${SSH_ORIGINAL_COMMAND:-}" | tr -cd '0-9a-f' | cut -c1-40)
[ -n "$REQ" ] && echo "Angefordert: $REQ"

# Vergleichsbasis: der zuletzt ERFOLGREICH ausgerollte Stand (aus deploy.json,
# das nur dieses Skript schreibt) – sonst der aktuelle Checkout
OLD=$(sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p' public/deploy.json 2>/dev/null | head -n 1)
if [ -z "$OLD" ] || ! git cat-file -e "$OLD^{commit}" 2>/dev/null; then
    OLD=$(git rev-parse HEAD)
fi
# "+" übernimmt auch umgeschriebene Historie (Force-Push); geprüft wird danach trotzdem
if ! git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"; then
    echo "Konnte den Stand von GitHub nicht holen." >&2
    exit 1
fi
TARGET=$(git rev-parse --verify "refs/remotes/origin/$BRANCH^{commit}")

# Neuen Stand prüfen, BEVOR er ausgecheckt wird:
# 1. keine Symlinks oder Submodule – die Website braucht keine, und root soll
#    nie einem Link aus dem Repo folgen
if git ls-tree -r "$TARGET" | awk '$1 == "120000" || $1 == "160000" { found = 1 } END { exit !found }'; then
    echo "Der neue Stand enthält Symlinks oder Submodule – Abbruch, nichts geändert." >&2
    exit 1
fi
# 2. keine Dateien an Stellen, die nur auf dem Server liegen dürfen
#    (Geheimnisse, Liga-Daten, erzeugte Seiten) – git checkout -f würde sie überschreiben
PROTECTED='^(\.env$|deploy/admin-auth/|public/data/|public/deploy\.json|public/index\.html$|public/404\.html$|public/sitemap\.xml$|public/feed\.xml$|public/news/|public/impressum/|public/datenschutz/|deploy/nginx/[^/]*\.inc$)'
if git ls-tree -r --name-only "$TARGET" | grep -Eq "$PROTECTED"; then
    echo "Der neue Stand enthält Dateien an geschützten Stellen:" >&2
    git ls-tree -r --name-only "$TARGET" | grep -E "$PROTECTED" | head -n 10 >&2
    echo "Abbruch, nichts geändert." >&2
    exit 1
fi

OUTPUTS="public/index.html public/404.html public/sitemap.xml public/feed.xml
         public/news public/impressum public/datenschutz
         deploy/nginx/redirects.inc deploy/nginx/security-headers.inc"
# Zusätzlich im Dateisystem: weder die Ordner noch die Ausgaben dürfen Symlinks sein
for p in public deploy deploy/nginx $OUTPUTS; do
    if [ -L "$p" ] || { [ -d "$p" ] && [ -n "$(find "$p" -type l -print -quit)" ]; }; then
        echo "Symlink in $p – Abbruch." >&2
        exit 1
    fi
done

git checkout -q -f -B "$BRANCH" "$TARGET"
NEW=$(git rev-parse HEAD)
echo "Stand: $(git log -1 --format='%h %s')"

changed() {
    [ "$OLD" != "$NEW" ] && ! git diff --quiet "$OLD" "$NEW" -- "$@"
}

# Container über ihre Labels finden – so liest das Skript die (per Push
# veränderbare) docker-compose.yml nie selbst.
container() {
    docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
                 --filter "label=com.docker.compose.service=$1" | head -n 1
}

# Seiten bauen – in einem Container ohne Netzwerk und ohne root-Rechte.
# Der Build darf nur die erzeugten Dateien schreiben (sie gehören "nobody"),
# den Rest des Repos (Code, docker-compose.yml …) kann er nicht verändern.
BUILD_ID=65534:65534
for f in public/index.html public/404.html public/sitemap.xml public/feed.xml \
         deploy/nginx/redirects.inc deploy/nginx/security-headers.inc; do
    [ -e "$f" ] || : > "$f"
done
mkdir -p public/news public/impressum public/datenschutz
# shellcheck disable=SC2086
chown -hR "$BUILD_ID" $OUTPUTS
docker run --rm --network none -u "$BUILD_ID" -v "$REPO_DIR:/site" -w /site node:22-alpine node tools/build.mjs

# nginx: Konfiguration prüfen, dann sanft neu laden (laufende Verbindungen bleiben)
WEB=$(container web)
if [ -z "$WEB" ]; then
    echo "Container 'web' läuft nicht – bitte auf dem Server 'docker compose up -d' ausführen." >&2
    exit 1
fi
if ! docker exec "$WEB" nginx -t -q; then
    echo "nginx-Konfiguration fehlerhaft – nichts neu geladen, die alte läuft weiter." >&2
    exit 1
fi
docker exec "$WEB" nginx -s reload

# Code der Redaktion bzw. des Liga-Syncs geändert → nur diese Container neu starten
for svc in admin liga-sync; do
    case "$svc" in admin) path=admin/ ;; liga-sync) path=deploy/liga-sync.sh ;; esac
    if changed "$path"; then
        c=$(container "$svc")
        if [ -n "$c" ]; then docker restart "$c" >/dev/null && echo "Neu gestartet: $svc"; fi
    fi
done

# Änderungen, die bewusst NICHT automatisch übernommen werden
if changed docker-compose.yml deploy/nginx-proxy.yml; then
    echo "::warning::docker-compose.yml geändert – auf dem Server bitte von Hand prüfen und 'docker compose up -d' ausführen."
fi
if changed deploy/deploy.sh; then
    echo "::warning::deploy/deploy.sh geändert – auf dem Server bitte neu installieren: install -m 755 $REPO_DIR/deploy/deploy.sh /usr/local/sbin/torpedo-deploy"
fi

# Für die Redaktion: welcher Stand ist online?
TMP=$(mktemp public/.deploy.json.XXXXXX)
printf '{"commit":"%s","time":"%s"}\n' "$NEW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP"
chmod 644 "$TMP"
mv -f "$TMP" public/deploy.json

echo "Deploy ok: $(git rev-parse --short HEAD)"

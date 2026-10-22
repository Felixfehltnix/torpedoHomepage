#!/bin/sh
# Holt regelmäßig Daten für die Website und legt sie unter public/data/ ab:
#
#   liga.json – Tabelle & Spielplan aus der 2k-Dart-API (alle 30 Minuten).
#               So müssen Besucher die API nicht selbst aufrufen (schneller,
#               datensparsamer) – und die Seite zeigt auch dann Daten, wenn
#               die API mal hängt. Adresse: site.config.json → "liga" → "api".
#
#   live.json – ob gerade auf Twitch gestreamt wird (jede Minute).
#               Kanal: site.config.json → "twitch" → "channel".
#               Braucht TWITCH_CLIENT_ID und TWITCH_CLIENT_SECRET (in .env);
#               ohne die beiden wird Twitch einfach übersprungen.

set -u
CONFIG="${CONFIG:-/config/site.config.json}"
OUT="${LIGA_OUT:-/data/liga.json}"
INTERVAL="${LIGA_INTERVAL:-1800}"
LIVE_OUT="${LIVE_OUT:-/data/live.json}"
LIVE_INTERVAL="${LIVE_INTERVAL:-60}"
UA="Mozilla/5.0 (compatible; DC-Torpedo-Website; +https://www.torpedo-dc.de)"

mkdir -p "$(dirname "$OUT")" "$(dirname "$LIVE_OUT")"

log() { echo "$(date '+%F %T') $*"; }

sync_liga() {
    URL="$(sed -n 's/.*"api": *"\([^"]*\)".*/\1/p' "$CONFIG" | head -n 1)"
    if [ -z "$URL" ]; then
        log "Keine API-Adresse in $CONFIG gefunden" >&2
    elif wget -q -T 30 -U "$UA" -O "$OUT.tmp" "$URL" && grep -q '"matches"' "$OUT.tmp"; then
        mv "$OUT.tmp" "$OUT"
        log "Liga-Daten aktualisiert"
    else
        rm -f "$OUT.tmp"
        log "Abruf fehlgeschlagen – versuche es später erneut" >&2
    fi
}

TOKEN=""
LAST_STATE=""
sync_twitch() {
    [ -n "${TWITCH_CLIENT_ID:-}" ] && [ -n "${TWITCH_CLIENT_SECRET:-}" ] || return 0
    CHANNEL="$(sed -n 's/.*"channel": *"\([A-Za-z0-9_]*\)".*/\1/p' "$CONFIG" | head -n 1)"
    [ -n "$CHANNEL" ] || return 0

    # App-Token (gilt rund 60 Tage); wird neu geholt, sobald ein Abruf scheitert
    if [ -z "$TOKEN" ]; then
        TOKEN="$(wget -q -T 20 -U "$UA" -O - \
            --post-data "client_id=$TWITCH_CLIENT_ID&client_secret=$TWITCH_CLIENT_SECRET&grant_type=client_credentials" \
            https://id.twitch.tv/oauth2/token | sed -n 's/.*"access_token" *: *"\([A-Za-z0-9]*\)".*/\1/p')"
        if [ -z "$TOKEN" ]; then
            log "Twitch: kein Token erhalten – Client-ID/Secret prüfen" >&2
            return 0
        fi
    fi

    if wget -q -T 20 -U "$UA" -O "$LIVE_OUT.raw" \
        --header "Client-Id: $TWITCH_CLIENT_ID" --header "Authorization: Bearer $TOKEN" \
        "https://api.twitch.tv/helix/streams?user_login=$CHANNEL" && grep -q '"data"' "$LIVE_OUT.raw"; then
        { printf '{"checked":%s,"twitch":' "$(date +%s)"; cat "$LIVE_OUT.raw"; printf '}\n'; } > "$LIVE_OUT.tmp"
        chmod 644 "$LIVE_OUT.tmp"
        mv "$LIVE_OUT.tmp" "$LIVE_OUT"
        if grep -q '"type" *: *"live"' "$LIVE_OUT.raw"; then STATE=live; else STATE=offline; fi
        [ "$STATE" != "$LAST_STATE" ] && log "Twitch: $CHANNEL ist $STATE"
        LAST_STATE="$STATE"
    else
        TOKEN=""
        log "Twitch: Abruf fehlgeschlagen" >&2
    fi
    rm -f "$LIVE_OUT.raw"
}

LAST_LIGA=0
while true; do
    NOW=$(date +%s)
    if [ $((NOW - LAST_LIGA)) -ge "$INTERVAL" ]; then
        sync_liga
        LAST_LIGA=$NOW
    fi
    sync_twitch
    [ "${LIGA_ONCE:-0}" = "1" ] && exit 0
    sleep "$LIVE_INTERVAL"
done

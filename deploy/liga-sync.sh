#!/bin/sh
# Holt regelmäßig Tabelle & Spielplan aus der 2k-Dart-API und legt sie als
# public/data/liga.json ab. So müssen Besucher die API nicht selbst aufrufen
# (schneller, datensparsamer) – und die Seite zeigt auch dann Daten, wenn
# die API mal hängt.
#
# Die API-Adresse steht in site.config.json ("liga" → "api").

set -u
CONFIG="${CONFIG:-/config/site.config.json}"
OUT="${LIGA_OUT:-/data/liga.json}"
INTERVAL="${LIGA_INTERVAL:-1800}"
UA="Mozilla/5.0 (compatible; DC-Torpedo-Website; +https://www.torpedo-dc.de)"

mkdir -p "$(dirname "$OUT")"

while true; do
    URL="$(sed -n 's/.*"api": *"\([^"]*\)".*/\1/p' "$CONFIG" | head -n 1)"
    if [ -z "$URL" ]; then
        echo "$(date '+%F %T') Keine API-Adresse in $CONFIG gefunden" >&2
    elif wget -q -T 30 -U "$UA" -O "$OUT.tmp" "$URL" && grep -q '"matches"' "$OUT.tmp"; then
        mv "$OUT.tmp" "$OUT"
        echo "$(date '+%F %T') Liga-Daten aktualisiert"
    else
        rm -f "$OUT.tmp"
        echo "$(date '+%F %T') Abruf fehlgeschlagen – versuche es später erneut" >&2
    fi
    [ "${LIGA_ONCE:-0}" = "1" ] && exit 0
    sleep "$INTERVAL"
done

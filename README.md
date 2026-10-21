# DC Torpedo – Website

Statische Website des DC Torpedo Osnabrück-Schinkel. Kein WordPress, keine Datenbank, kein PHP:
nur HTML, CSS und ein bisschen JavaScript, ausgeliefert von nginx.

- **Startanimation**: Der Dart fliegt rein, das Logo baut sich per Sonar-Sweep auf. Ein Klick aufs Logo spielt sie nochmal ab.
- **Saison live**: Tabelle, Spielplan, Ergebnisse und „Nächstes Spiel“ kommen aus dem Ligasystem (2K Dart Software / NDV), Termine gibt’s als Kalenderdatei.
- **News** als Markdown-Dateien, daraus werden statische Seiten gebaut.
- **Datensparsam**: Schriften lokal, keine Cookies, kein Tracking, Karte erst nach Klick.

## Aufbau

```
public/                 ← das wird ausgeliefert (Document Root)
  assets/               CSS, JS, Schriften, Bilder (von Hand gepflegt)
  index.html, news/ …   ⚠ erzeugt von tools/build.mjs – nicht direkt bearbeiten
src/
  partials/             Kopf, Header, Footer
  pages/                Startseite, Impressum, Datenschutz, 404
content/news/           News-Beiträge (Markdown)
site.config.json        E-Mail, Liga-API, Spielort
tools/build.mjs         Seitengenerator (Node ≥ 18, keine Abhängigkeiten)
tools/bilder.py         Fotos → WebP (optional, braucht Pillow)
deploy/                 nginx-Konfiguration, Liga-Sync
docker-compose.yml
```

## Lokal ansehen

```bash
node tools/build.mjs
python3 -m http.server 8080 --directory public
# → http://localhost:8080
```

Nach jeder Änderung an `src/`, `content/` oder `site.config.json` einmal `node tools/build.mjs`
ausführen und die erzeugten Dateien mit committen. Der Server braucht dann nur `git pull`.

## News schreiben

1. Fotos vorbereiten (verkleinert, dreht richtig, entfernt GPS-Daten):
   ```bash
   pip install pillow
   python3 tools/bilder.py ~/Bilder/IMG_1234.jpg public/assets/img/news/heimsieg-gegen-xy/team
   ```
2. Datei `content/news/2026-11-07-heimsieg-gegen-xy.md` anlegen:
   ```markdown
   ---
   title: Heimsieg gegen XY!
   date: 2026-11-07
   slug: heimsieg-gegen-xy
   cover: /assets/img/news/heimsieg-gegen-xy/team-1600.webp
   coverAlt: Das Team nach dem Spiel
   ---

   Erster Absatz – wird auch als Vorschau auf der Startseite genutzt.

   ## Zwischenüberschrift

   Text mit **fett**, *kursiv* und [Links](https://example.org).

   ![Bildunterschrift](/assets/img/news/heimsieg-gegen-xy/foto-1600.webp)

   :::galerie
   ![](/assets/img/news/heimsieg-gegen-xy/bild-1-1600.webp)
   ![](/assets/img/news/heimsieg-gegen-xy/bild-2-1600.webp)
   :::
   ```
3. `node tools/build.mjs`, committen, pushen. Die drei neuesten Beiträge landen automatisch auf der Startseite.

## Neue Saison

In `site.config.json` unter `liga` anpassen:

| Feld      | Bedeutung |
|-----------|-----------|
| `saison`  | Anzeige, z. B. `2027/28` |
| `team`    | Teamname genau wie im Ligasystem, z. B. `DC Torpedo Schinkel A` |
| `api`     | `https://backend-ddv.2k-dart-software.com/2k-backend-ddv/api/v1/frontend/event/<EVENT>/phase/<PHASE>/round/0` |
| `tabelle` | Link zur offiziellen Tabelle: `https://portal.3k-darts.com/frontend/events/10/event/<EVENT>/table` |

Die Event-ID steht in der Adresse der Liga im Portal (`…/event/1668/table`). Die Phasen-ID liefert
`https://backend-ddv.2k-dart-software.com/2k-backend-ddv/api/v1/frontend/event/<EVENT>` im Feld `phases[0].id`.
Danach `node tools/build.mjs` ausführen, denn die API-Adresse steckt auch in der Sicherheitsrichtlinie (CSP).

Die Tabelle wird im Browser aus allen Ergebnissen berechnet (2 Punkte pro Sieg, 1 pro Unentschieden;
Sortierung wie im Ligasystem: Punktdifferenz → Pluspunkte → Spieldifferenz → Spiele → Legdifferenz → Legs).

## Auf den Server bringen (WordPress ablösen)

```bash
git clone https://github.com/Felixfehltnix/torpedoHomepage.git torpedo-website
cd torpedo-website
docker compose up -d
```

- **web** (nginx) liefert `public/` aus, im Beispiel auf Port 8080.
- **liga-sync** holt alle 30 Minuten Tabelle & Spielplan nach `public/data/liga.json`. Ist die Datei frisch,
  fragen Besucher die API gar nicht erst an. Fällt der Sync aus, lädt der Browser die Daten direkt.

Dann den bestehenden Reverse-Proxy (der bisher auf den WordPress-Container zeigt) auf den `web`-Container
umbiegen, z. B. bei nginx `proxy_pass http://127.0.0.1:8080;`. TLS/HTTPS und die Weiterleitung
`torpedo-dc.de → www.torpedo-dc.de` bleiben beim Proxy. Wenn alles läuft, den WordPress-Container und
seine Datenbank stoppen (vorher ein Backup ziehen).

Alte WordPress-Adressen (z. B. `/happy-birthday-siggi/`, `/feed/`, `/members/`) werden per 301 auf die neuen
Seiten umgeleitet (`deploy/redirects.conf`, wird automatisch erzeugt). `wp-admin`, `wp-login.php` und
`xmlrpc.php` antworten mit 410.

Updates: `git pull` reicht – nginx liefert die neuen Dateien sofort aus.

## Noch offen

- [ ] Kontakt-E-Mail in `site.config.json` eintragen (dann erscheint auch der „Schreib uns“-Button)
- [ ] Impressum vervollständigen (`src/pages/impressum.html`, rot markierte Stellen)
- [ ] Datenschutz: Speicherdauer der Server-Logs eintragen (`src/pages/datenschutz.html`)

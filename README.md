# DC Torpedo – Website

Statische Website des DC Torpedo Osnabrück-Schinkel. Kein WordPress, keine Datenbank, kein PHP:
nur HTML, CSS und ein bisschen JavaScript, ausgeliefert von nginx.

- **Startanimation**: Der Dart fliegt rein, das Logo baut sich per Sonar-Sweep auf. Ein Klick aufs Logo spielt sie nochmal ab.
- **Saison live**: Tabelle, Spielplan, Ergebnisse und „Nächstes Spiel“ kommen aus dem Ligasystem (2K Dart Software / NDV), Termine gibt’s als Kalenderdatei.
- **News** als Markdown-Dateien, daraus werden statische Seiten gebaut – bequem über die **Redaktion unter `/admin/`**
  (Login, Formular, Foto-Upload mit Komprimierung im Browser) oder per Hand.
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
admin/                  Redaktions-Dienst (Node, ohne Pakete) + Dockerfile
public/admin/           Redaktions-Oberfläche (hinter HTTP Basic Auth)
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

## News über die Redaktion (`/admin/`)

Unter `https://www.torpedo-dc.de/admin/` gibt es nach dem Login ein Formular: Titel, Datum, Text,
Titelbild und weitere Fotos. Die Fotos werden **im Browser** verkleinert (1600 px und 800 px, WebP,
auf Safari JPEG), dabei fallen alle Metadaten wie GPS weg – aus einem 3-MB-Handyfoto werden meist
150–250 KB. Danach baut der Server die Seiten neu, der Beitrag ist sofort online.
Bestehende Beiträge lassen sich dort auch bearbeiten (Text als Markdown) und löschen.

Jede Änderung wird auf dem Server als Git-Commit gespeichert und – wenn ein `GITHUB_TOKEN` gesetzt
ist – nach GitHub gepusht. So bleibt GitHub die Sicherung, und ein späteres `git pull` klappt ohne Konflikte.

**Einrichten** (einmalig, in `/home/torpedo-website`):

```bash
# 1. Zugang anlegen (Benutzername "felix" anpassen; weitere Personen: Zeile mit >> anhängen)
mkdir -p deploy/admin-auth
printf "felix:%s\n" "$(openssl passwd -apr1)" > deploy/admin-auth/htpasswd   # fragt nach dem Passwort
chmod 644 deploy/admin-auth/htpasswd                                          # nginx muss sie lesen können

# 2. Optional, aber empfohlen: Push nach GitHub
#    GitHub → Settings → Developer settings → Fine-grained tokens: nur Repo "torpedoHomepage",
#    Berechtigung "Contents: Read and write".
echo "GITHUB_TOKEN=github_pat_…" >> .env
echo "SITE_UID=$(stat -c %u .)" >> .env && echo "SITE_GID=$(stat -c %g .)" >> .env

# 3. Starten bzw. aktualisieren
docker compose up -d --build
```

Ohne `deploy/admin-auth/htpasswd` bleibt `/admin/` gesperrt. Der Dienst `admin` hängt nur im internen
Netz des Projekts, nicht am Proxy-Netz. Jedes Foto wird einzeln hochgeladen und bleibt unter 900 KB,
deshalb muss am nginx-proxy (Standard-Limit 1 MB pro Anfrage) nichts geändert werden.

## News per Hand schreiben

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

Auf dem Vereinsserver läuft **nginx-proxy** mit **acme-companion** (Compose-Projekt `ssl` unter
`/home/torpedo-wordpress/ssl`). Websites melden sich dort über das Docker-Netz `ssl_default` und die
Variablen `VIRTUAL_HOST`/`LETSENCRYPT_HOST` an – genau das macht `deploy/nginx-proxy.yml`.
Die Darts-App (`app.torpedo-dc.de`) hängt am selben Proxy und bleibt unberührt.

**1. Parallel starten und testen** (stört nichts, der Proxy sieht die Seite noch nicht):

```bash
cd /home
git clone -b claude/relaxed-faraday-8yjgv5 https://github.com/Felixfehltnix/torpedoHomepage.git torpedo-website
cd torpedo-website
docker compose up -d
curl -sI http://127.0.0.1:8080/            # → 200
docker compose logs liga-sync              # → „Liga-Daten aktualisiert“
```

Ansehen vom eigenen Rechner: `ssh -L 8080:127.0.0.1:8080 <user>@<server>` und dann http://localhost:8080 öffnen.

**2. Umschalten** (Website ca. 10 Sekunden weg, die Darts-App merkt nichts – nginx-proxy lädt nur neu):

```bash
docker stop wordpress-app                  # WordPress gibt torpedo-dc.de frei (nur stoppen, nicht löschen)
cd /home/torpedo-website
echo "COMPOSE_FILE=docker-compose.yml:deploy/nginx-proxy.yml" > .env
docker compose up -d                       # Website meldet sich beim Proxy an
curl -sI https://www.torpedo-dc.de/        # → 200
curl -sI https://torpedo-dc.de/            # → 301 auf www
```

**Zurück zu WordPress**, falls etwas nicht passt:

```bash
cd /home/torpedo-website && rm .env && docker compose up -d
docker start wordpress-app
```

**3. Aufräumen** (nach ein paar Tagen): WordPress sichern (Datenbank-Dump + `wp-content`), dann
`wordpress-app` und `wordpressdb` entfernen und aus `/home/torpedo-wordpress/ssl/docker-compose.yml`
austragen. Bis dahin dort kein `docker compose up -d` ohne Dienstnamen ausführen – das würde WordPress
wieder starten, und es würde sich die Domain mit der neuen Seite teilen.

**Wichtig:** Den Proxy-Container nie mit `docker restart nginx` neu starten (docker-gen merkt sich dann
falsche IPs), sondern nur mit `docker compose up -d --force-recreate nginx` in `/home/torpedo-wordpress/ssl`.
Und kein `docker system/image/volume prune` – das kann die Darts-App treffen.

**Updates:** `git pull` in `/home/torpedo-website` reicht, nginx liefert die neuen Dateien sofort aus.
Wenn sich `deploy/nginx.conf`, `docker-compose.yml` oder `admin/` ändern: `docker compose up -d --build`
(ggf. `--force-recreate web`). Achtung: `.env` nur mit `>>` ergänzen, nicht mit `>` überschreiben.

Alte WordPress-Adressen (z. B. `/happy-birthday-siggi/`, `/feed/`, `/members/`) werden per 301 auf die neuen
Seiten umgeleitet (`deploy/redirects.conf`, wird automatisch erzeugt). `wp-admin`, `wp-login.php` und
`xmlrpc.php` antworten mit 410.

**Anderer Server ohne nginx-proxy:** `docker compose up -d` startet die Seite auf `127.0.0.1:8080`
(Port per `WEB_PORT` in `.env` änderbar); davor einen beliebigen Reverse-Proxy mit TLS setzen.

## Noch offen

- [ ] Kontakt-E-Mail in `site.config.json` eintragen (dann erscheint auch der „Schreib uns“-Button)
- [ ] Impressum vervollständigen (`src/pages/impressum.html`, rot markierte Stellen)
- [ ] Datenschutz: Speicherdauer der Server-Logs eintragen (`src/pages/datenschutz.html`)
- [ ] Redaktion einrichten: Passwortdatei + optional `GITHUB_TOKEN` (siehe oben)

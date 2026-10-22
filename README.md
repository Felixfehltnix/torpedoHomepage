# DC Torpedo – Website

Statische Website des DC Torpedo Osnabrück-Schinkel. Kein WordPress, keine Datenbank, kein PHP:
nur HTML, CSS und ein bisschen JavaScript, ausgeliefert von nginx.

- **Startanimation**: Der Dart fliegt rein, das Logo baut sich per Sonar-Sweep auf. Ein Klick aufs Logo spielt sie nochmal ab.
- **Saison live**: Tabelle, Spielplan, Ergebnisse und „Nächstes Spiel“ kommen aus dem Ligasystem (2K Dart Software / NDV), Termine gibt’s als Kalenderdatei.
- **News** als Markdown-Dateien – bequem über die **Redaktion unter `/admin/`** (Login, Formular,
  Foto-Upload mit Komprimierung im Browser) oder per Hand.
- **GitHub ist die einzige Quelle**: Jede Änderung – Code oder News aus der Redaktion – landet als Commit
  auf `master`, eine GitHub Action baut die Seiten und rollt sie aus. Nach etwa einer Minute ist sie online.
- **Datensparsam**: Schriften lokal, keine Cookies, kein Tracking, Karte erst nach Klick.

```
Redaktion (/admin/) ─┐
                     ├─► Commit auf GitHub (master) ─► GitHub Action ─► SSH ─► torpedo-deploy auf dem Server
Code (git push) ─────┘                                  (Probe-Build)          (holen, bauen, nginx neu laden)
```

## Aufbau

```
public/                 ← das wird ausgeliefert (Document Root)
  assets/               CSS, JS, Schriften, Bilder
  admin/                Redaktions-Oberfläche (hinter HTTP Basic Auth)
  index.html, news/ …   erzeugt von tools/build.mjs – nicht im Git
src/
  partials/             Kopf, Header, Footer
  pages/                Startseite, Impressum, Datenschutz, 404
content/news/           News-Beiträge (Markdown)
site.config.json        E-Mail, Liga-API, Spielort, GitHub-Repo/Branch
admin/server.mjs        Redaktions-Dienst (Node, ohne Pakete) – schreibt per GitHub-API
tools/build.mjs         Seitengenerator (Node ≥ 18, keine Abhängigkeiten)
tools/bilder.py         Fotos → WebP für News per Hand (optional, braucht Pillow)
deploy/
  deploy.sh             Deploy-Skript (wird auf dem Server als torpedo-deploy installiert)
  nginx/                nginx-Konfiguration (*.inc erzeugt der Build)
  nginx-proxy.yml       Einbindung hinter nginx-proxy + acme-companion
  liga-sync.sh          holt Tabelle & Spielplan nach public/data/
.github/workflows/deploy.yml   Build + Deploy bei jedem Push auf master
docker-compose.yml
```

## Lokal ansehen

```bash
node tools/build.mjs
python3 -m http.server 8080 --directory public
# → http://localhost:8080
```

Die erzeugten Seiten (`public/index.html`, `public/news/` …) sind nicht im Git – gebaut wird beim Deploy.

## News über die Redaktion (`/admin/`)

Unter `https://www.torpedo-dc.de/admin/` gibt es nach dem Login ein Formular: Titel, Datum, Text,
Titelbild und weitere Fotos. Die Fotos werden **im Browser** verkleinert (1600 px und 800 px, WebP,
auf Safari JPEG), dabei fallen alle Metadaten wie GPS weg – aus einem 3-MB-Handyfoto werden meist
150–250 KB. Jedes Foto wird einzeln hochgeladen und bleibt unter 900 KB, deshalb muss am
nginx-proxy (Standard-Limit 1 MB pro Anfrage) nichts geändert werden.

Beim Speichern wird **genau ein Commit auf GitHub** angelegt (Markdown + Fotos). Die GitHub Action
rollt ihn aus; das Formular zeigt so lange „Wird veröffentlicht …“ und meldet sich mit „Online!“.
Bestehende Beiträge lassen sich bearbeiten (Text als Markdown – ein Foto entfernt man, indem man seine
Zeile löscht; die Datei verschwindet dann auch aus dem Repo) und löschen.

Der Dienst `admin` schreibt **nichts** auf dem Server: Er bindet das Repo nur lesend ein, läuft ohne
root und hängt nur im internen Netz des Projekts, nicht am Proxy-Netz.

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
3. Committen und auf `master` pushen – den Rest erledigt die GitHub Action. Zum Vorab-Ansehen lokal
   `node tools/build.mjs` ausführen. Die drei neuesten Beiträge landen automatisch auf der Startseite.

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
Die API-Adresse steckt auch in der Sicherheitsrichtlinie (CSP); die baut der Deploy automatisch neu.

Die Tabelle wird im Browser aus allen Ergebnissen berechnet (2 Punkte pro Sieg, 1 pro Unentschieden;
Sortierung wie im Ligasystem: Punktdifferenz → Pluspunkte → Spieldifferenz → Spiele → Legdifferenz → Legs).

## Deployment

### So läuft ein Deploy

Bei jedem Push auf `master` (auch aus der Redaktion) startet `.github/workflows/deploy.yml`:

1. **Probe-Build** auf GitHub – geht er schief, wird nichts ausgerollt und GitHub schickt eine Mail.
2. **SSH zum Server** mit einem Schlüssel, der dort **nur** `torpedo-deploy` starten darf (Zwangsbefehl).
3. `torpedo-deploy` holt den neuen Stand von `master` und **prüft ihn vor dem Auschecken**: keine Symlinks
   oder Submodule und keine Dateien an Stellen, die nur auf dem Server liegen (`.env`, Passwortdatei,
   Liga-Daten, erzeugte Seiten). Dann baut es die Seiten in einem Container ohne Netzwerk als `nobody`
   (darf nur die erzeugten Dateien schreiben), prüft die nginx-Konfiguration und lädt nginx sanft neu. Hat sich der Code der Redaktion oder des
   Liga-Syncs geändert, werden nur diese Container neu gestartet. Zum Schluss schreibt es
   `public/deploy.json` – daran erkennt die Redaktion, dass ihr Commit online ist.

Bewusst **nicht** automatisch: Änderungen an `docker-compose.yml` und am Deploy-Skript selbst. Das Skript
liegt außerhalb des Repos (`/usr/local/sbin/torpedo-deploy`). Code aus dem Repo läuft so nur in Containern
(Build ohne Netzwerk als `nobody`, Redaktion als `node`) – aber: **Wer auf `master` pushen darf, bestimmt,
was dort läuft.** Ändern sich die beiden Dateien, meldet die Action eine Warnung; auf dem Server dann
erst den Diff ansehen (`git diff <alt>..HEAD -- docker-compose.yml`) und von Hand nachziehen:

```bash
cd /home/torpedo-website
docker compose up -d                                               # nach Änderungen an docker-compose.yml
install -m 755 deploy/deploy.sh /usr/local/sbin/torpedo-deploy     # nach Änderungen an deploy/deploy.sh
```

Der Branch (`master`) ist im installierten Skript fest eingestellt und wird bewusst nicht aus dem Repo
gelesen; `github.branch` in `site.config.json` nutzt nur die Redaktion und muss dazu passen. Die Container
spricht das Skript über ihre Docker-Labels an, die `docker-compose.yml` aus dem Repo liest es nicht.

**Zurückrollen:** auf GitHub den betreffenden Commit zurücknehmen (*Revert*) – die Action rollt den alten
Stand aus. **Von Hand ausrollen:** `torpedo-deploy` auf dem Server oder in GitHub unter
*Actions → Deploy → Run workflow*.

### Server einrichten (einmalig)

Auf dem Vereinsserver läuft **nginx-proxy** mit **acme-companion** (Compose-Projekt `ssl` unter
`/home/torpedo-wordpress/ssl`). Websites melden sich dort über das Docker-Netz `ssl_default` und die
Variablen `VIRTUAL_HOST`/`LETSENCRYPT_HOST` an – genau das macht `deploy/nginx-proxy.yml`.
Die Darts-App (`app.torpedo-dc.de`) hängt am selben Proxy und bleibt unberührt.

```bash
# Repo und Branch
git clone https://github.com/Felixfehltnix/torpedoHomepage.git /home/torpedo-website
cd /home/torpedo-website

# .env – nur mit >> ergänzen, nie mit > überschreiben
echo "COMPOSE_FILE=docker-compose.yml:deploy/nginx-proxy.yml" >> .env
echo "GITHUB_TOKEN=github_pat_…" >> .env      # Fine-grained Token: nur dieses Repo, „Contents: Read and write“

# Zugang zur Redaktion (weitere Personen: Zeile mit >> anhängen)
mkdir -p deploy/admin-auth
printf "felix:%s\n" "$(openssl passwd -apr1)" > deploy/admin-auth/htpasswd   # fragt nach dem Passwort
chmod 644 deploy/admin-auth/htpasswd                                          # nginx muss sie lesen können

# Deploy-Skript installieren, einmal bauen, starten
install -m 755 deploy/deploy.sh /usr/local/sbin/torpedo-deploy
docker run --rm --network none -u "$(stat -c %u:%g .)" -v "$PWD:/site" -w /site node:22-alpine node tools/build.mjs
docker compose up -d
torpedo-deploy
```

**Deploy-Schlüssel für GitHub** – beim rechtlosen Benutzer `deploy` (kein Passwort, nicht in der
docker-Gruppe), der nur dieses eine Skript per sudo starten darf. Der private Teil liegt nur bei GitHub:

```bash
# sudo-Regel nur für das Deploy-Skript
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/torpedo-deploy' > /etc/sudoers.d/torpedo-deploy
chmod 440 /etc/sudoers.d/torpedo-deploy && visudo -cf /etc/sudoers.d/torpedo-deploy

# Schlüssel erzeugen und mit Zwangsbefehl eintragen
ssh-keygen -t ed25519 -N "" -C "github-actions-torpedo" -f /tmp/torpedo_deploy
echo "restrict,command=\"sudo /usr/local/sbin/torpedo-deploy\" $(cat /tmp/torpedo_deploy.pub)" >> ~deploy/.ssh/authorized_keys
cat /tmp/torpedo_deploy                       # → GitHub-Secret DEPLOY_SSH_KEY, danach:
shred -u /tmp/torpedo_deploy /tmp/torpedo_deploy.pub
echo "<server-ip> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"   # → Secret DEPLOY_KNOWN_HOSTS
```

**GitHub-Secrets** (Repo → *Settings → Secrets and variables → Actions*): `DEPLOY_HOST` (Server-IP),
`DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`. Ohne Secrets läuft nur der Probe-Build.

### Wichtig auf dem Vereinsserver

- Den Proxy-Container nie mit `docker restart nginx` neu starten (docker-gen merkt sich dann falsche IPs),
  sondern nur mit `docker compose up -d --force-recreate nginx` in `/home/torpedo-wordpress/ssl`.
- Kein `docker system/image/volume prune` – das kann die Darts-App treffen.
- In `/home/torpedo-wordpress/ssl` kein `docker compose up -d` ohne Dienstnamen, solange WordPress dort noch
  eingetragen ist – das würde WordPress wieder starten, und es würde sich die Domain mit der neuen Seite teilen.

Alte WordPress-Adressen (z. B. `/happy-birthday-siggi/`, `/feed/`, `/members/`) werden per 301 auf die neuen
Seiten umgeleitet (`deploy/nginx/redirects.inc`, erzeugt der Build). `wp-admin`, `wp-login.php` und
`xmlrpc.php` antworten mit 410.

**Anderer Server ohne nginx-proxy:** ohne `COMPOSE_FILE`-Zeile startet die Seite auf `127.0.0.1:8080`
(Port per `WEB_PORT` in `.env` änderbar); davor einen beliebigen Reverse-Proxy mit TLS setzen.

## Noch offen

- [ ] Kontakt-E-Mail in `site.config.json` eintragen (dann erscheint auch der „Schreib uns“-Button)
- [ ] Impressum vervollständigen (`src/pages/impressum.html`, rot markierte Stellen)
- [ ] Datenschutz: Speicherdauer der Server-Logs eintragen (`src/pages/datenschutz.html`)
- [ ] WordPress endgültig entfernen (vorher prüfen, dass das Backup vom 21.10. vollständig ist)

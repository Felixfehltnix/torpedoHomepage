#!/usr/bin/env node
/**
 * DC Torpedo – Redaktions-Dienst für News (ohne Abhängigkeiten, Node 18+)
 *
 * Läuft im Container "admin" und ist nur über nginx unter /admin/api/ erreichbar.
 * Den Login (HTTP Basic Auth) erledigt nginx; dieser Dienst prüft zusätzlich,
 * dass die Anfrage von dort kommt.
 *
 * Fotos werden im Browser verkleinert und einzeln hochgeladen (POST /admin/api/upload,
 * je Datei unter 1 MB – so passt alles durch das Standard-Limit von nginx-proxy).
 * Beim Speichern landen sie unter public/assets/img/news/<slug>/, der Beitrag als
 * Markdown in content/news/. Danach werden die Seiten mit tools/build.mjs neu
 * gebaut und die Änderung committet. Ist GITHUB_TOKEN gesetzt,
 * wird auch nach GitHub gepusht.
 *
 * Umgebungsvariablen:
 *   SITE_DIR      Pfad zum Repo (Standard: /site)
 *   PORT          Port (Standard: 3000)
 *   GIT_COMMIT    "0" schaltet Commits ab (Standard: an)
 *   GITHUB_TOKEN  Token mit Schreibrecht auf das Repo (optional, für Push)
 */
import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rm, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const run = promisify(execFile);
const SITE = resolve(process.env.SITE_DIR || "/site");
const PORT = Number(process.env.PORT || 3000);
const NEWS_DIR = join(SITE, "content/news");
const IMG_DIR = join(SITE, "public/assets/img/news");
const STAGE_DIR = join(SITE, ".uploads"); // hochgeladene Fotos, bis der Beitrag gespeichert wird
const GIT_COMMIT = process.env.GIT_COMMIT !== "0";
const HAS_TOKEN = Boolean(process.env.GITHUB_TOKEN);

const LIMITS = {
  json: 2 * 1024 * 1024, // Beitragsdaten ohne Fotos
  image: 4 * 1024 * 1024, // je Bildvariante (im Browser schon verkleinert)
  images: 30,
  title: 140,
  text: 60000,
};

/* ------------------------------------------------------------------
   Hilfen
   ------------------------------------------------------------------ */
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Schreibende Aktionen nacheinander ausführen (ein Build zur Zeit)
let chain = Promise.resolve();
function exclusive(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function slugify(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "beitrag";
}

function parseFrontMatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw, order: [] };
  const data = {};
  const order = [];
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      data[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1").trim();
      order.push(kv[1]);
    }
  }
  return { data, body: m[2], order };
}

function serialize(data, order, body) {
  const keys = [...new Set([...order, ...Object.keys(data)])].filter((k) => data[k] !== undefined && data[k] !== "");
  const head = keys.map((k) => `${k}: ${String(data[k]).replace(/[\r\n]+/g, " ")}`).join("\n");
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}

async function listPosts() {
  const files = (await readdir(NEWS_DIR)).filter((f) => f.endsWith(".md"));
  const posts = [];
  for (const file of files) {
    const { data } = parseFrontMatter((await readFile(join(NEWS_DIR, file), "utf8")).replace(/\r/g, ""));
    if (data.slug) posts.push({ file, slug: data.slug, title: data.title || data.slug, date: data.date || "", cover: data.cover || "" });
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

async function findPost(slug) {
  if (!SLUG_RE.test(slug)) throw new UserError("Ungültiger Beitrag.", 404);
  const post = (await listPosts()).find((p) => p.slug === slug);
  if (!post) throw new UserError("Beitrag nicht gefunden.", 404);
  const raw = (await readFile(join(NEWS_DIR, post.file), "utf8")).replace(/\r/g, "");
  return { ...post, ...parseFrontMatter(raw) };
}

function cleanText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function checkTitleDate(title, date) {
  title = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!title) throw new UserError("Bitte einen Titel eingeben.");
  if (title.length > LIMITS.title) throw new UserError(`Der Titel ist zu lang (max. ${LIMITS.title} Zeichen).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(date))) throw new UserError("Bitte ein gültiges Datum wählen.");
  return { title, date: String(date) };
}

const ID_RE = /^[a-f0-9]{24}$/;

function imageExt(buf) {
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  return null;
}

/** Ein (im Browser verkleinertes) Foto zwischenspeichern → { id, ext } */
async function stageUpload(req) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const declared = type === "image/webp" ? "webp" : type === "image/jpeg" ? "jpg" : null;
  if (!declared) throw new UserError("Nur WebP- oder JPEG-Bilder werden angenommen.", 415);
  const buf = await readBody(req, LIMITS.image, "Das Foto ist zu groß.");
  if (imageExt(buf) !== declared) throw new UserError("Das Foto hat ein unerwartetes Format.");
  await mkdir(STAGE_DIR, { recursive: true });
  const id = randomBytes(12).toString("hex");
  await writeFile(join(STAGE_DIR, `${id}.${declared}`), buf);
  cleanupStage().catch(() => {});
  return { id, ext: declared };
}

/** Zwischengespeicherte Dateien, die älter als ein Tag sind, wegräumen */
async function cleanupStage() {
  if (!existsSync(STAGE_DIR)) return;
  const cutoff = Date.now() - 24 * 3600e3;
  for (const f of await readdir(STAGE_DIR)) {
    const st = await stat(join(STAGE_DIR, f)).catch(() => null);
    if (st && st.mtimeMs < cutoff) await rm(join(STAGE_DIR, f), { force: true });
  }
}

/** Foto aus dem Zwischenspeicher an seinen Platz legen: { ext, large, small } (IDs) → Pfad der großen Variante */
async function saveImage(slug, name, img) {
  if (!img || typeof img !== "object") throw new UserError("Bilddaten fehlen.");
  const ext = img.ext === "jpg" || img.ext === "webp" ? img.ext : null;
  if (!ext || !ID_RE.test(String(img.large)) || !ID_RE.test(String(img.small))) throw new UserError("Ungültige Bilddaten.");
  const from = { large: join(STAGE_DIR, `${img.large}.${ext}`), small: join(STAGE_DIR, `${img.small}.${ext}`) };
  if (!existsSync(from.large) || !existsSync(from.small)) throw new UserError("Ein Foto ist nicht (mehr) da. Bitte erneut auswählen.");
  const dir = join(IMG_DIR, slug);
  await mkdir(dir, { recursive: true });
  const base = `${name}-${randomBytes(3).toString("hex")}`;
  await rename(from.small, join(dir, `${base}-800.${ext}`));
  await rename(from.large, join(dir, `${base}-1600.${ext}`));
  return `/assets/img/news/${slug}/${base}-1600.${ext}`;
}

function altText(alt, fallback) {
  return String(alt || fallback).replace(/[\[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
}

function galleryBlock(paths) {
  if (!paths.length) return "";
  if (paths.length === 1) return `\n\n![${paths[0].alt}](${paths[0].path})`;
  return `\n\n:::galerie\n${paths.map((p) => `![${p.alt}](${p.path})`).join("\n")}\n:::`;
}

/* ------------------------------------------------------------------
   Bauen & Git
   ------------------------------------------------------------------ */
async function build() {
  try {
    const { stdout } = await run(process.execPath, [join(SITE, "tools/build.mjs")], { cwd: SITE, timeout: 120000 });
    return stdout.trim();
  } catch (err) {
    throw new UserError(`Die Seiten konnten nicht gebaut werden: ${(err.stderr || err.message).split("\n").find(Boolean)}`, 500);
  }
}

const git = (args) =>
  run("git", args, {
    cwd: SITE,
    timeout: 60000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "DC Torpedo Redaktion",
      GIT_AUTHOR_EMAIL: "redaktion@torpedo-dc.de",
      GIT_COMMITTER_NAME: "DC Torpedo Redaktion",
      GIT_COMMITTER_EMAIL: "redaktion@torpedo-dc.de",
    },
  });

// Zugangsdaten nur über einen Credential-Helper, der das Token aus der Umgebung liest
const AUTH = ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'];

async function isRepo() {
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Vor einer Änderung den Stand von GitHub holen, damit der spätere Push durchgeht */
async function gitPull() {
  if (!GIT_COMMIT || !HAS_TOKEN || !(await isRepo())) return;
  try {
    await git([...AUTH, "pull", "--ff-only", "-q"]);
  } catch (err) {
    console.warn("git pull übersprungen:", (err.stderr || err.message).trim());
  }
}

async function gitCommit(message) {
  if (!GIT_COMMIT) return { committed: false, pushed: false, note: "Git ist abgeschaltet." };
  if (!(await isRepo())) return { committed: false, pushed: false, note: "Kein Git-Repository gefunden." };
  try {
    await git(["add", "-A", "--", "content/news", "public", "deploy/redirects.conf", "deploy/security-headers.conf"]);
    const { stdout } = await git(["diff", "--cached", "--name-only"]);
    if (!stdout.trim()) return { committed: false, pushed: false, note: "Keine Änderungen." };
    await git(["commit", "-q", "-m", message]);
  } catch (err) {
    return { committed: false, pushed: false, note: `Commit fehlgeschlagen: ${(err.stderr || err.message).trim().split("\n")[0]}` };
  }
  if (!HAS_TOKEN) return { committed: true, pushed: false, note: "Auf dem Server gespeichert (kein GITHUB_TOKEN für den Push gesetzt)." };
  try {
    await git([...AUTH, "push", "-q", "origin", "HEAD"]);
    return { committed: true, pushed: true, note: "Auf GitHub gesichert." };
  } catch (err) {
    return { committed: true, pushed: false, note: `Gespeichert, aber der Push zu GitHub ist fehlgeschlagen: ${(err.stderr || err.message).trim().split("\n")[0]}` };
  }
}

/* ------------------------------------------------------------------
   Aktionen
   ------------------------------------------------------------------ */
async function createPost(input) {
  const { title, date } = checkTitleDate(input.title, input.date);
  const text = cleanText(input.text);
  if (text.length > LIMITS.text) throw new UserError("Der Text ist zu lang.");
  const gallery = Array.isArray(input.gallery) ? input.gallery : [];
  if (gallery.length + (input.cover ? 1 : 0) > LIMITS.images) throw new UserError(`Bitte höchstens ${LIMITS.images} Bilder pro Beitrag.`);
  if (!text && !gallery.length) throw new UserError("Bitte einen Text schreiben oder Fotos anhängen.");

  await gitPull();
  const existing = new Set((await listPosts()).map((p) => p.slug));
  const base = slugify(title);
  let slug = base;
  for (let i = 2; existing.has(slug) || existsSync(join(IMG_DIR, slug)); i++) slug = `${base}-${i}`;

  const data = { title, date, slug };
  if (input.cover) {
    data.cover = await saveImage(slug, "titel", input.cover);
    data.coverAlt = altText(input.cover.alt, title);
  }
  const paths = [];
  for (const [i, img] of gallery.entries()) {
    paths.push({ path: await saveImage(slug, `foto-${i + 1}`, img), alt: altText(img.alt, `${title} – Foto ${i + 1}`) });
  }
  const body = `${text}${galleryBlock(paths)}`;
  await writeFile(join(NEWS_DIR, `${date}-${slug}.md`), serialize(data, ["title", "date", "slug", "cover", "coverAlt"], body));
  const buildLog = await build();
  const gitResult = await gitCommit(`News: ${title}`);
  return { slug, url: `/news/${slug}/`, build: buildLog, git: gitResult };
}

async function updatePost(slug, input) {
  const post = await findPost(slug);
  const { title, date } = checkTitleDate(input.title, input.date);
  const text = cleanText(input.text);
  if (text.length > LIMITS.text) throw new UserError("Der Text ist zu lang.");
  const gallery = Array.isArray(input.gallery) ? input.gallery : [];
  if (gallery.length > LIMITS.images) throw new UserError(`Bitte höchstens ${LIMITS.images} Bilder auf einmal.`);

  await gitPull();
  const data = { ...post.data, title, date, slug };
  if (input.cover) {
    data.cover = await saveImage(slug, "titel", input.cover);
    data.coverAlt = altText(input.cover.alt, title);
  } else if (input.removeCover) {
    delete data.cover;
    delete data.coverAlt;
  }
  const paths = [];
  for (const [i, img] of gallery.entries()) {
    paths.push({ path: await saveImage(slug, `foto-neu-${i + 1}`, img), alt: altText(img.alt, `${title} – Foto`) });
  }
  const body = `${text}${galleryBlock(paths)}`;
  const newFile = `${date}-${slug}.md`;
  await writeFile(join(NEWS_DIR, post.file), serialize(data, post.order, body));
  if (newFile !== post.file) await rename(join(NEWS_DIR, post.file), join(NEWS_DIR, newFile));
  const buildLog = await build();
  const gitResult = await gitCommit(`News bearbeitet: ${title}`);
  return { slug, url: `/news/${slug}/`, build: buildLog, git: gitResult };
}

async function deletePost(slug) {
  const post = await findPost(slug);
  await gitPull();
  await rm(join(NEWS_DIR, post.file));
  await rm(join(IMG_DIR, slug), { recursive: true, force: true });
  // Die Ausgabe des gelöschten Beitrags entfernen
  await rm(join(SITE, "public/news", slug), { recursive: true, force: true });
  const buildLog = await build();
  const gitResult = await gitCommit(`News gelöscht: ${post.data.title || slug}`);
  return { slug, build: buildLog, git: gitResult };
}

/* ------------------------------------------------------------------
   HTTP
   ------------------------------------------------------------------ */
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function readBody(req, limit, tooLarge) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new UserError(tooLarge, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new UserError("Erwartet JSON.", 415);
  const buf = await readBody(req, LIMITS.json, "Der Beitrag ist zu groß.");
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new UserError("Ungültige Daten.");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // Nur Anfragen, die nginx nach erfolgreichem Login weiterreicht
    if (!req.headers["x-remote-user"]) throw new UserError("Nicht angemeldet.", 401);
    // Schreibende Anfragen nur von der eigenen Seite (Schutz vor fremden Formularen)
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin) {
        let host = null;
        try {
          host = new URL(origin).host;
        } catch {
          host = null;
        }
        if (host !== req.headers.host) throw new UserError("Fremde Herkunft.", 403);
      }
    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/admin/api/upload" && req.method === "POST") return send(res, 201, await stageUpload(req));
    const m = path.match(/^\/admin\/api\/news(?:\/([^/]+))?$/);
    if (!m) throw new UserError("Nicht gefunden.", 404);
    const slug = m[1] ? decodeURIComponent(m[1]) : null;

    if (req.method === "GET" && !slug) return send(res, 200, { posts: await listPosts(), user: req.headers["x-remote-user"], push: HAS_TOKEN });
    if (req.method === "GET" && slug) {
      const p = await findPost(slug);
      return send(res, 200, { slug: p.slug, title: p.data.title || "", date: p.data.date || "", cover: p.data.cover || "", text: p.body.trim() });
    }
    if (req.method === "POST" && !slug) {
      const input = await readJson(req);
      return send(res, 201, await exclusive(() => createPost(input)));
    }
    if (req.method === "PUT" && slug) {
      const input = await readJson(req);
      return send(res, 200, await exclusive(() => updatePost(slug, input)));
    }
    if (req.method === "DELETE" && slug) return send(res, 200, await exclusive(() => deletePost(slug)));
    throw new UserError("Methode nicht erlaubt.", 405);
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    send(res, err.status || 500, { error: err instanceof UserError ? err.message : "Interner Fehler. Details stehen im Log des admin-Containers." });
  }
});

server.listen(PORT, () => console.log(`Redaktion läuft auf Port ${PORT} (Repo: ${SITE}, Push: ${HAS_TOKEN ? "an" : "aus"})`));

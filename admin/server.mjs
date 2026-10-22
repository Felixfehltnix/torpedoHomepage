#!/usr/bin/env node
/**
 * DC Torpedo – Redaktions-Dienst für News (ohne Abhängigkeiten, Node 18+)
 *
 * Läuft im Container "admin" und ist nur über nginx unter /admin/api/ erreichbar.
 * Den Login (HTTP Basic Auth) erledigt nginx; dieser Dienst prüft zusätzlich,
 * dass die Anfrage von dort kommt.
 *
 * Der Dienst schreibt NICHTS auf dem Server. Jede Aktion (Beitrag anlegen,
 * bearbeiten, löschen) wird zu genau einem Commit auf GitHub (Git Data API).
 * Die GitHub Action baut daraufhin die Seiten und rollt sie aus – nach etwa
 * einer Minute ist die Änderung online. Gelesen wird der ausgerollte Stand
 * aus dem (schreibgeschützt eingebundenen) Repo; für Bearbeitungen holt der
 * Dienst den neuesten Stand direkt von GitHub.
 *
 * Fotos werden im Browser verkleinert und einzeln hochgeladen
 * (POST /admin/api/upload, je Datei unter 1 MB – so passt alles durch das
 * Standard-Limit von nginx-proxy) und bis zum Speichern in STAGE_DIR gehalten.
 *
 * Umgebungsvariablen:
 *   GITHUB_TOKEN  Fine-grained Token, nur dieses Repo, "Contents: Read and write"
 *   SITE_DIR      Pfad zum Repo (Standard: /site)
 *   STAGE_DIR     Zwischenspeicher für Uploads (Standard: /tmp/uploads)
 *   PORT          Port (Standard: 3000)
 *   GITHUB_API    nur für Tests (Standard: https://api.github.com)
 * Repo und Branch stehen in site.config.json unter "github".
 */
import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const SITE = resolve(process.env.SITE_DIR || "/site");
const STAGE_DIR = resolve(process.env.STAGE_DIR || "/tmp/uploads");
const PORT = Number(process.env.PORT || 3000);
const API = (process.env.GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const TOKEN = process.env.GITHUB_TOKEN || "";
const NEWS = "content/news";
const IMG = "public/assets/img/news";

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

// Schreibende Aktionen nacheinander ausführen
let chain = Promise.resolve();
function exclusive(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

function config() {
  const c = JSON.parse(readFileSync(join(SITE, "site.config.json"), "utf8"));
  const repo = c.github?.repo || "";
  const branch = c.github?.branch || "master";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UserError("In site.config.json fehlt github.repo.", 500);
  if (!/^[\w./-]+$/.test(branch)) throw new UserError("Ungültiger Branch in site.config.json.", 500);
  return { repo, branch };
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
  const m = String(raw).replace(/\r/g, "").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(raw), order: [] };
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

function altText(alt, fallback) {
  return String(alt || fallback).replace(/[\[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
}

function galleryBlock(images) {
  if (!images.length) return "";
  if (images.length === 1) return `\n\n![${images[0].alt}](${images[0].path})`;
  return `\n\n:::galerie\n${images.map((p) => `![${p.alt}](${p.path})`).join("\n")}\n:::`;
}

/* ------------------------------------------------------------------
   Ausgerollter Stand (schreibgeschützt eingebunden)
   ------------------------------------------------------------------ */
async function listLocal() {
  const dir = join(SITE, NEWS);
  const posts = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
    const { data } = parseFrontMatter(await readFile(join(dir, file), "utf8"));
    if (data.slug) posts.push({ file, slug: data.slug, title: data.title || data.slug, date: data.date || "", cover: data.cover || "" });
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

function deployedInfo() {
  try {
    return JSON.parse(readFileSync(join(SITE, "public/deploy.json"), "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
   GitHub
   ------------------------------------------------------------------ */
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

async function gh(method, path, body) {
  if (!TOKEN) throw new UserError("Auf dem Server ist kein GITHUB_TOKEN gesetzt – Speichern ist so nicht möglich.", 503);
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dc-torpedo-redaktion",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new UserError("GitHub ist gerade nicht erreichbar. Bitte später noch einmal versuchen.", 502);
  }
  if (res.status === 404 && method === "GET") return null;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new UserError("GitHub verweigert den Zugriff. Ist das Token gültig und hat es „Contents: Read and write“?", 502);
    }
    const err = new Error(`GitHub ${method} ${path}: ${res.status} ${data?.message || ""}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function ghFile(path) {
  const { repo, branch } = config();
  const d = await gh("GET", `/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
  if (!d || Array.isArray(d) || d.type !== "file") return null;
  return Buffer.from(d.content || "", "base64").toString("utf8");
}

async function ghDir(path) {
  const { repo, branch } = config();
  const d = await gh("GET", `/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
  return Array.isArray(d) ? d.filter((e) => e.type === "file").map((e) => ({ name: e.name, path: e.path })) : [];
}

/**
 * Einen Commit mit allen Änderungen anlegen.
 * changes: [{ path, content }] (Text) | [{ path, buffer }] (Binär) | [{ path, delete: true }]
 * Bei einem gleichzeitigen Push wird bis zu dreimal auf dem neuen Stand wiederholt.
 */
async function commit(message, changes) {
  const { repo, branch } = config();
  const blobs = new Map();
  for (let attempt = 1; ; attempt++) {
    const ref = await gh("GET", `/repos/${repo}/git/ref/heads/${branch}`);
    if (!ref) throw new UserError(`Branch „${branch}“ gibt es auf GitHub nicht.`, 500);
    const head = ref.object.sha;
    const headCommit = await gh("GET", `/repos/${repo}/git/commits/${head}`);
    const tree = [];
    for (const c of changes) {
      if (c.delete) {
        tree.push({ path: c.path, mode: "100644", type: "blob", sha: null });
      } else if (c.buffer) {
        if (!blobs.has(c.path)) {
          const b = await gh("POST", `/repos/${repo}/git/blobs`, { content: c.buffer.toString("base64"), encoding: "base64" });
          blobs.set(c.path, b.sha);
        }
        tree.push({ path: c.path, mode: "100644", type: "blob", sha: blobs.get(c.path) });
      } else {
        tree.push({ path: c.path, mode: "100644", type: "blob", content: c.content });
      }
    }
    const newTree = await gh("POST", `/repos/${repo}/git/trees`, { base_tree: headCommit.tree.sha, tree });
    const newCommit = await gh("POST", `/repos/${repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [head],
      author: { name: "DC Torpedo Redaktion", email: "redaktion@torpedo-dc.de" },
    });
    try {
      await gh("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha, force: false });
      return newCommit.sha;
    } catch (err) {
      if (err.status === 422 && attempt < 3) continue; // jemand anderes hat gerade gepusht
      throw err;
    }
  }
}

/* ------------------------------------------------------------------
   Fotos
   ------------------------------------------------------------------ */
const ID_RE = /^[a-f0-9]{24}$/;

function imageExt(buf) {
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  return null;
}

/** Ein (im Browser verkleinertes) Foto zwischenspeichern → { id } */
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

async function cleanupStage() {
  if (!existsSync(STAGE_DIR)) return;
  const cutoff = Date.now() - 24 * 3600e3;
  for (const f of await readdir(STAGE_DIR)) {
    const st = await stat(join(STAGE_DIR, f)).catch(() => null);
    if (st && st.mtimeMs < cutoff) await rm(join(STAGE_DIR, f), { force: true });
  }
}

/** Zwischengespeichertes Foto für den Commit vorbereiten → { path, changes, staged } */
async function takeImage(slug, name, img) {
  if (!img || typeof img !== "object") throw new UserError("Bilddaten fehlen.");
  const ext = img.ext === "jpg" || img.ext === "webp" ? img.ext : null;
  if (!ext || !ID_RE.test(String(img.large)) || !ID_RE.test(String(img.small))) throw new UserError("Ungültige Bilddaten.");
  const staged = [join(STAGE_DIR, `${img.small}.${ext}`), join(STAGE_DIR, `${img.large}.${ext}`)];
  if (!staged.every(existsSync)) throw new UserError("Ein Foto ist nicht (mehr) da. Bitte erneut auswählen.");
  const base = `${name}-${randomBytes(3).toString("hex")}`;
  const changes = [
    { path: `${IMG}/${slug}/${base}-800.${ext}`, buffer: await readFile(staged[0]) },
    { path: `${IMG}/${slug}/${base}-1600.${ext}`, buffer: await readFile(staged[1]) },
  ];
  return { path: `/assets/img/news/${slug}/${base}-1600.${ext}`, changes, staged };
}

async function dropStaged(images) {
  for (const img of images) for (const f of img.staged) await rm(f, { force: true }).catch(() => {});
}

/* ------------------------------------------------------------------
   Beiträge
   ------------------------------------------------------------------ */
const recentSlugs = new Set(); // angelegt, aber evtl. noch nicht ausgerollt

async function findFile(slug) {
  if (!SLUG_RE.test(slug)) throw new UserError("Ungültiger Beitrag.", 404);
  const local = (await listLocal()).find((p) => p.slug === slug);
  if (local) {
    const raw = await ghFile(`${NEWS}/${local.file}`);
    if (raw !== null) return { file: local.file, raw };
  }
  // Noch nicht ausgerollt oder umbenannt: auf GitHub suchen
  for (const e of await ghDir(NEWS)) {
    if (e.name.endsWith(".md") && e.name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "") === slug) {
      const raw = await ghFile(e.path);
      if (raw !== null) return { file: e.name, raw };
    }
  }
  throw new UserError("Beitrag nicht gefunden.", 404);
}

async function createPost(input) {
  const { title, date } = checkTitleDate(input.title, input.date);
  const text = cleanText(input.text);
  if (text.length > LIMITS.text) throw new UserError("Der Text ist zu lang.");
  const gallery = Array.isArray(input.gallery) ? input.gallery : [];
  if (gallery.length + (input.cover ? 1 : 0) > LIMITS.images) throw new UserError(`Bitte höchstens ${LIMITS.images} Fotos pro Beitrag.`);
  if (!text && !gallery.length && !input.cover) throw new UserError("Bitte einen Text schreiben oder Fotos anhängen.");

  const taken = new Set([...(await listLocal()).map((p) => p.slug), ...recentSlugs]);
  const base = slugify(title);
  let slug = base;
  for (let i = 2; taken.has(slug) || (await ghDir(`${IMG}/${slug}`)).length; i++) slug = `${base}-${i}`;

  const images = [];
  const data = { title, date, slug };
  if (input.cover) {
    const c = await takeImage(slug, "titel", input.cover);
    images.push(c);
    data.cover = c.path;
    data.coverAlt = altText(input.cover.alt, title);
  }
  const gal = [];
  for (const [i, g] of gallery.entries()) {
    const img = await takeImage(slug, `foto-${i + 1}`, g);
    images.push(img);
    gal.push({ path: img.path, alt: altText(g.alt, `${title} – Foto ${i + 1}`) });
  }
  const md = serialize(data, ["title", "date", "slug", "cover", "coverAlt"], `${text}${galleryBlock(gal)}`);
  const changes = [...images.flatMap((i) => i.changes), { path: `${NEWS}/${date}-${slug}.md`, content: md }];
  const sha = await commit(`News: ${title}`, changes);
  recentSlugs.add(slug);
  await dropStaged(images);
  return { slug, url: `/news/${slug}/`, commit: sha };
}

async function updatePost(slug, input) {
  const { title, date } = checkTitleDate(input.title, input.date);
  const text = cleanText(input.text);
  if (text.length > LIMITS.text) throw new UserError("Der Text ist zu lang.");
  const gallery = Array.isArray(input.gallery) ? input.gallery : [];
  if (gallery.length > LIMITS.images) throw new UserError(`Bitte höchstens ${LIMITS.images} Fotos auf einmal.`);

  const { file, raw } = await findFile(slug);
  const { data, order } = parseFrontMatter(raw);
  Object.assign(data, { title, date, slug });

  const images = [];
  if (input.cover) {
    const c = await takeImage(slug, "titel", input.cover);
    images.push(c);
    data.cover = c.path;
    data.coverAlt = altText(input.cover.alt, title);
  } else if (input.removeCover) {
    delete data.cover;
    delete data.coverAlt;
  }
  const gal = [];
  for (const [i, g] of gallery.entries()) {
    const img = await takeImage(slug, `foto-neu-${i + 1}`, g);
    images.push(img);
    gal.push({ path: img.path, alt: altText(g.alt, `${title} – Foto`) });
  }
  const body = `${text}${galleryBlock(gal)}`;
  const newFile = file.replace(/^\d{4}-\d{2}-\d{2}/, date);
  const changes = [...images.flatMap((i) => i.changes), { path: `${NEWS}/${newFile}`, content: serialize(data, order, body) }];
  if (newFile !== file) changes.push({ path: `${NEWS}/${file}`, delete: true });

  // Fotos, die im Beitrag nicht mehr vorkommen (Zeile gelöscht, Titelbild ersetzt), entfernen
  const used = `${data.cover || ""}\n${body}`;
  for (const f of await ghDir(`${IMG}/${slug}`)) {
    const m = f.name.match(/^(.+)-(800|1600)\.(webp|jpe?g)$/);
    if (m && !used.includes(`/${slug}/${m[1]}-1600.${m[3]}`)) changes.push({ path: f.path, delete: true });
  }

  const sha = await commit(`News bearbeitet: ${title}`, changes);
  await dropStaged(images);
  return { slug, url: `/news/${slug}/`, commit: sha };
}

async function deletePost(slug) {
  const { file, raw } = await findFile(slug);
  const title = parseFrontMatter(raw).data.title || slug;
  const changes = [{ path: `${NEWS}/${file}`, delete: true }];
  for (const f of await ghDir(`${IMG}/${slug}`)) changes.push({ path: f.path, delete: true });
  const sha = await commit(`News gelöscht: ${title}`, changes);
  recentSlugs.delete(slug);
  return { slug, commit: sha };
}

/** Ist ein Commit schon ausgerollt? (public/deploy.json schreibt das Deploy-Skript) */
async function deployStatus(sha) {
  const deployed = deployedInfo();
  if (!sha) return { deployed };
  if (!/^[a-f0-9]{7,40}$/.test(sha)) throw new UserError("Ungültiger Commit.");
  if (!deployed?.commit) return { online: false, deployed };
  if (deployed.commit.startsWith(sha) || sha.startsWith(deployed.commit)) return { online: true, deployed };
  const { repo } = config();
  const cmp = await gh("GET", `/repos/${repo}/compare/${sha}...${deployed.commit}`);
  return { online: Boolean(cmp && (cmp.status === "ahead" || cmp.status === "identical")), deployed };
}

/* ------------------------------------------------------------------
   HTTP
   ------------------------------------------------------------------ */
function send(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
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
    if (path === "/admin/api/status" && req.method === "GET") return send(res, 200, await deployStatus(url.searchParams.get("commit")));
    const m = path.match(/^\/admin\/api\/news(?:\/([^/]+))?$/);
    if (!m) throw new UserError("Nicht gefunden.", 404);
    const slug = m[1] ? decodeURIComponent(m[1]) : null;

    if (req.method === "GET" && !slug) {
      return send(res, 200, { posts: await listLocal(), user: req.headers["x-remote-user"], token: Boolean(TOKEN), deployed: deployedInfo() });
    }
    if (req.method === "GET" && slug) {
      const { raw } = await findFile(slug);
      const p = parseFrontMatter(raw);
      return send(res, 200, { slug, title: p.data.title || "", date: p.data.date || "", cover: p.data.cover || "", text: p.body.trim() });
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
    send(res, err.status && err instanceof UserError ? err.status : 500, {
      error: err instanceof UserError ? err.message : "Interner Fehler. Details stehen im Log des admin-Containers.",
    });
  }
});

server.listen(PORT, () => {
  let target = "?";
  try {
    const c = config();
    target = `${c.repo}@${c.branch}`;
  } catch {}
  console.log(`Redaktion läuft auf Port ${PORT} → ${target} (Token: ${TOKEN ? "gesetzt" : "FEHLT"})`);
});

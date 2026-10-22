#!/usr/bin/env node
/**
 * DC Torpedo – Seitengenerator (ohne Abhängigkeiten, Node 18+)
 *
 *   node tools/build.mjs              → baut nach public/ (die erzeugten Dateien sind nicht im Git)
 *   node tools/build.mjs --preview    → Links enden auf index.html (für Vorschau ohne Webserver)
 *   node tools/build.mjs --out pfad   → anderes Zielverzeichnis (Assets werden NICHT kopiert)
 *
 * Quellen:
 *   src/partials/*.html   Kopf, Header, Footer
 *   src/pages/*.html      Seiten (Startseite, Impressum, Datenschutz, 404)
 *   content/news/*.md     News-Beiträge (Markdown mit Kopfbereich)
 *
 * Erzeugt: HTML-Seiten, news/, sitemap.xml, feed.xml, deploy/nginx/*.inc
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = join(ROOT, "public"); // hier liegen Bilder, CSS, JS
const args = process.argv.slice(2);
const PREVIEW = args.includes("--preview");
const OUT = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : STATIC;

/* ------------------------------------------------------------------
   Einstellungen – hier bei Bedarf anpassen
   ------------------------------------------------------------------ */
const SITE = JSON.parse(readFileSync(join(ROOT, "site.config.json"), "utf8"));

/* ------------------------------------------------------------------
   Hilfsfunktionen
   ------------------------------------------------------------------ */
const read = (p) => readFileSync(p, "utf8");
const write = (p, s) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hash = (...files) => {
  const h = createHash("sha1");
  for (const f of files) h.update(readFileSync(f));
  return h.digest("hex").slice(0, 8);
};
const VERSION = hash(join(STATIC, "assets/css/main.css"), join(STATIC, "assets/js/main.js"));

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const fmtDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}. ${MONTHS[m - 1]} ${y}`;
};

/** Relativer Pfad von einer Seite (z. B. "news/foo/") zur Wurzel */
const rootFor = (pagePath) => {
  const depth = pagePath.split("/").filter(Boolean).length;
  return depth ? "../".repeat(depth) : "";
};
/** Link auf eine Seite relativ zur aktuellen Wurzel */
const linkTo = (root, target) => {
  // target: "" (Startseite), "news/", "impressum/" …
  if (PREVIEW) return `${root}${target}index.html`;
  return target === "" ? root || "./" : `${root}${target}`;
};
/** "/assets/…" → relativer Pfad */
const asset = (root, p) => (p.startsWith("/") ? root + p.slice(1) : p);

/* ------------------------------------------------------------------
   Bildgrößen lesen (PNG, JPEG, WebP) – für width/height gegen Layout-Sprünge
   ------------------------------------------------------------------ */
const sizeCache = new Map();
function imageSize(webPath) {
  if (sizeCache.has(webPath)) return sizeCache.get(webPath);
  const file = join(STATIC, webPath.replace(/^\//, ""));
  let size = null;
  try {
    const b = readFileSync(file);
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const chunk = b.toString("ascii", 12, 16);
      if (chunk === "VP8X") size = { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      else if (chunk === "VP8 ") size = { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      else if (chunk === "VP8L") {
        const bits = b.readUInt32LE(21);
        size = { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
    } else if (b.readUInt32BE(0) === 0x89504e47) {
      size = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    } else if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) break;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          size = { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
          break;
        }
        i += 2 + len;
      }
    }
  } catch {
    console.warn(`⚠ Bild nicht gefunden: ${webPath}`);
  }
  sizeCache.set(webPath, size);
  return size;
}

/** <img> mit srcset, wenn eine -800-Variante neben der -1600-Datei liegt */
function img(root, src, { alt = "", sizes = "100vw", cls = "", lazy = true, priority = false } = {}) {
  const size = imageSize(src);
  let srcset = "";
  const m = src.match(/^(.*)-1600\.(webp|jpe?g)$/);
  if (m) {
    const small = `${m[1]}-800.${m[2]}`;
    if (existsSync(join(STATIC, small.replace(/^\//, "")))) {
      srcset = ` srcset="${asset(root, small)} 800w, ${asset(root, src)} ${size?.w || 1600}w" sizes="${sizes}"`;
    }
  }
  const dims = size ? ` width="${size.w}" height="${size.h}"` : "";
  const loading = lazy ? ' loading="lazy" decoding="async"' : "";
  const prio = priority ? ' fetchpriority="high"' : "";
  return `<img${cls ? ` class="${cls}"` : ""} src="${asset(root, src)}"${srcset}${dims} alt="${esc(alt)}"${loading}${prio}>`;
}

/* ------------------------------------------------------------------
   Mini-Markdown (Absätze, Überschriften, fett/kursiv, Links, Listen,
   Bilder, Galerien mit :::galerie … :::)
   ------------------------------------------------------------------ */
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, t, href) => {
      // Nur sichere Ziele zulassen (kein javascript: o. Ä.)
      if (!/^(https?:\/\/|mailto:|\/|#)/i.test(href)) return t;
      const ext = /^https?:/i.test(href);
      return `<a href="${href}"${ext ? ' rel="noopener" target="_blank"' : ""}>${t}</a>`;
    });
}

const IMG_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)(?:\{\.([\w-]+)\})?$/;

function markdown(src, root) {
  const lines = src.replace(/\r/g, "").split("\n");
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === ":::galerie") {
      flushPara();
      flushList();
      const items = [];
      while (++i < lines.length && lines[i].trim() !== ":::") {
        const m = lines[i].trim().match(IMG_RE);
        if (m) items.push(m);
      }
      out.push(
        `<div class="gallery">${items
          .map(
            ([, alt, path]) =>
              `<a href="${asset(root, path)}" data-lightbox>${img(root, path, {
                alt,
                sizes: "(min-width: 1040px) 260px, (min-width: 600px) 33vw, 50vw",
              })}</a>`
          )
          .join("")}</div>`
      );
      continue;
    }
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    const im = line.match(IMG_RE);
    if (im) {
      flushPara();
      flushList();
      const [, alt, path, cls] = im;
      out.push(
        `<figure${cls ? ` class="${cls}"` : ""}><a href="${asset(root, path)}" data-lightbox>${img(root, path, {
          alt,
          sizes: "(min-width: 760px) 44rem, 100vw",
        })}</a>${alt && !cls ? `<figcaption>${inline(alt)}</figcaption>` : ""}</figure>`
      );
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      (list ||= []).push(li[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

function frontMatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("Kopfbereich (---) fehlt");
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1").trim();
  }
  return { data, body: m[2] };
}

/* ------------------------------------------------------------------
   Templates
   ------------------------------------------------------------------ */
const partials = Object.fromEntries(
  readdirSync(join(ROOT, "src/partials"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => [f.replace(/\.html$/, ""), read(join(ROOT, "src/partials", f))])
);

function render(tpl, vars) {
  let s = tpl;
  // Partials (auch verschachtelt)
  for (let n = 0; n < 5 && /\{\{>\s*[\w-]+\s*\}\}/.test(s); n++) {
    s = s.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
      if (!(name in partials)) throw new Error(`Partial fehlt: ${name}`);
      return partials[name];
    });
  }
  // Links: {{link:news/}}  Assets: {{asset:/assets/…}}
  s = s.replace(/\{\{link:([^}]*)\}\}/g, (_, t) => linkTo(vars.root, t.trim()));
  s = s.replace(/\{\{asset:([^}]*)\}\}/g, (_, p) => asset(vars.root, p.trim()));
  s = s.replace(/\{\{img:([^}|]*)\|([^}|]*)\|?([^}]*)\}\}/g, (_, p, alt, sizes) =>
    img(vars.root, p.trim(), { alt: alt.trim(), sizes: sizes.trim() || "100vw" })
  );
  // Variablen
  s = s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), vars);
    if (v === undefined) throw new Error(`Variable fehlt: ${k}`);
    return v;
  });
  return s;
}

function page(tpl, { path, title, description, bodyClass = "page-sub", ogType = "website", ogImage, extra = {}, absolute = false }) {
  // Die 404-Seite wird unter beliebigen Pfaden ausgeliefert → absolute Pfade
  const root = absolute && !PREVIEW ? "/" : rootFor(path);
  const isHome = path === "" && !absolute; // die 404-Seite ist nie die Startseite
  const vars = {
    ...SITE,
    ...extra,
    root,
    version: VERSION,
    title: esc(title),
    ogTitle: esc(extra.ogTitle || title),
    description: esc(description),
    canonical: `${SITE.url}/${path}`,
    ogType,
    ogImage: `${SITE.url}${ogImage || "/assets/img/og-image.jpg"}`,
    bodyClass,
    home: isHome ? "" : linkTo(root, ""),
    headerClass: isHome ? "" : " is-solid",
    headerAttr: isHome ? "" : "data-always-solid",
    contactActions: contactActions(root, isHome),
    emailLink: SITE.email
      ? `<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>`
      : `<span class="todo">E-Mail-Adresse eintragen (site.config.json)</span>`,
  };
  return render(tpl, vars);
}

function contactActions(root, isHome) {
  const home = isHome ? "" : linkTo(root, "");
  const mail = SITE.email
    ? `<a class="btn" href="mailto:${esc(SITE.email)}?subject=${encodeURIComponent("Probetraining beim DC Torpedo")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>
        Schreib uns</a>`
    : "";
  return `${mail}
      <a class="btn${mail ? " btn--ghost" : ""}" href="${home}#schinkeltreff">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
        Komm vorbei</a>`;
}

/* ------------------------------------------------------------------
   News einlesen
   ------------------------------------------------------------------ */
const NEWS_DIR = join(ROOT, "content/news");
const posts = readdirSync(NEWS_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const { data, body } = frontMatter(read(join(NEWS_DIR, f)));
    for (const k of ["title", "date", "slug"]) if (!data[k]) throw new Error(`${f}: "${k}" fehlt`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error(`${f}: Datum bitte als JJJJ-MM-TT`);
    const text = body.replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, "").replace(/[#*>:\[\]()_-]/g, " ");
    const words = text.split(/\s+/).filter(Boolean).length;
    const excerpt =
      data.excerpt ||
      body
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .find((p) => p && !p.startsWith("#") && !p.startsWith("!") && !p.startsWith(":::"))
        ?.replace(/\s+/g, " ")
        .replace(/\*\*?/g, "") ||
      "";
    const short = excerpt.length > 200 ? `${excerpt.slice(0, 200).replace(/\s+\S*$/, "")} …` : excerpt;
    return { ...data, file: f, body, excerpt: short, minutes: Math.max(1, Math.round(words / 200)) };
  })
  .sort((a, b) => b.date.localeCompare(a.date));

function card(root, p, { priority = false } = {}) {
  const href = linkTo(root, `news/${p.slug}/`);
  const cover = p.cover
    ? `<div class="card__media">${img(root, p.cover, {
        alt: p.coverAlt || "",
        sizes: "(min-width: 1040px) 380px, (min-width: 700px) 50vw, 100vw",
        lazy: !priority,
      })}</div>`
    : "";
  return `<article class="card reveal">
        ${cover}
        <div class="card__body">
          <time class="card__date" datetime="${p.date}">${fmtDate(p.date)}</time>
          <h3 class="card__title"><a href="${href}">${esc(p.title)}</a></h3>
          <p class="card__excerpt">${esc(p.excerpt)}</p>
        </div>
      </article>`;
}

/* ------------------------------------------------------------------
   Seiten bauen
   ------------------------------------------------------------------ */
const written = [];
const emit = (path, html) => {
  const file = path.endsWith(".html") ? join(OUT, path) : join(OUT, path, "index.html");
  write(file, html);
  written.push(relative(ROOT, file));
};

// Startseite & statische Seiten
const PAGES = [
  { src: "index.html", path: "", bodyClass: "page-home" },
  { src: "impressum.html", path: "impressum/" },
  { src: "datenschutz.html", path: "datenschutz/" },
  { src: "404.html", path: "404.html", absolute: true },
];
for (const p of PAGES) {
  const { data, body } = frontMatter(read(join(ROOT, "src/pages", p.src)));
  const pathForRoot = p.path.endsWith(".html") ? "" : p.path;
  const root = p.absolute && !PREVIEW ? "/" : rootFor(pathForRoot);
  const newsCards = posts
    .slice(0, 3)
    .map((post, i) => card(root, post, { priority: false }))
    .join("\n      ");
  const html = page(body, {
    path: pathForRoot,
    title: PREVIEW && p.path === "" ? "DC Torpedo Website" : data.title,
    description: data.description,
    bodyClass: p.bodyClass || "page-sub",
    extra: { newsCards, newsCount: String(posts.length) },
    absolute: p.absolute,
  });
  emit(p.path, html);
}

// Newsübersicht
{
  const path = "news/";
  const root = rootFor(path);
  const tpl = `{{> head}}
<body class="{{bodyClass}}">
{{> header}}
<main id="main">
  <section class="page-hero">
    <div class="wrap">
      <ol class="breadcrumb"><li><a href="{{home}}">Start</a></li><li>News</li></ol>
      <h1 class="display">News</h1>
      <p class="lead" style="margin-top:20px">Spielberichte, Aufstiege und alles, was sonst im Schinkel passiert.</p>
    </div>
  </section>
  <section class="news-list">
    <div class="wrap">
      <div class="cards">
      ${posts.map((p, i) => card(root, p, { priority: i < 3 })).join("\n      ")}
      </div>
    </div>
  </section>
</main>
{{> footer}}
</body>
</html>
`;
  emit(
    path,
    page(tpl, {
      path,
      title: "News – DC Torpedo Osnabrück-Schinkel",
      description: "Spielberichte und Neuigkeiten vom DC Torpedo, dem Steeldart-Team aus Osnabrück-Schinkel.",
    })
  );
}

// Seiten gelöschter Beiträge wegräumen (nur erzeugte Ordner mit index.html)
{
  const newsOut = join(OUT, "news");
  const keep = new Set(posts.map((p) => p.slug));
  if (existsSync(newsOut)) {
    for (const name of readdirSync(newsOut)) {
      const dir = join(newsOut, name);
      if (!keep.has(name) && statSync(dir).isDirectory() && existsSync(join(dir, "index.html"))) {
        rmSync(dir, { recursive: true, force: true });
        console.log(`– entfernt: news/${name}/`);
      }
    }
  }
}

// Einzelne Beiträge
posts.forEach((p, i) => {
  const path = `news/${p.slug}/`;
  const root = rootFor(path);
  const newer = posts[i - 1];
  const older = posts[i + 1];
  const nav = [
    older
      ? `<a class="prev" href="${linkTo(root, `news/${older.slug}/`)}"><span>← Älterer Beitrag</span><b>${esc(older.title)}</b></a>`
      : "<span></span>",
    newer
      ? `<a class="next" href="${linkTo(root, `news/${newer.slug}/`)}"><span>Neuerer Beitrag →</span><b>${esc(newer.title)}</b></a>`
      : "",
  ].join("");
  const cover = p.cover
    ? `<figure class="article__cover">${img(root, p.cover, { alt: p.coverAlt || "", sizes: "(min-width: 1280px) 1200px, 100vw", lazy: false, priority: true })}</figure>`
    : "";
  const tpl = `{{> head}}
<body class="{{bodyClass}}">
{{> header}}
<main id="main">
  <article>
    <header class="page-hero">
      <div class="wrap">
        <ol class="breadcrumb"><li><a href="{{home}}">Start</a></li><li><a href="{{link:news/}}">News</a></li></ol>
        <h1 class="display display--md">${esc(p.title)}</h1>
        <p class="article__meta"><time datetime="${p.date}">${fmtDate(p.date)}</time><span>${p.minutes} Min. Lesezeit</span></p>
      </div>
    </header>
    <div class="article">
      <div class="wrap">
        ${cover}
        <div class="prose">
${markdown(p.body, root)}
        </div>
        <nav class="article__nav" aria-label="Weitere Beiträge">${nav}</nav>
      </div>
    </div>
  </article>
</main>
{{> footer}}
</body>
</html>
`;
  emit(
    path,
    page(tpl, {
      path,
      title: `${p.title} – DC Torpedo`,
      description: p.excerpt.slice(0, 160),
      ogType: "article",
      ogImage: p.cover ? p.cover.replace(/-1600\.webp$/, "-800.webp") : undefined,
      extra: { ogTitle: p.title },
    })
  );
});

/* ------------------------------------------------------------------
   sitemap.xml, feed.xml, Weiterleitungen
   ------------------------------------------------------------------ */
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: "", lastmod: posts[0]?.date || today },
  { loc: "news/", lastmod: posts[0]?.date || today },
  ...posts.map((p) => ({ loc: `news/${p.slug}/`, lastmod: p.date })),
  { loc: "impressum/", lastmod: today },
  { loc: "datenschutz/", lastmod: today },
];
write(
  join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE.url}/${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`
);
written.push(relative(ROOT, join(OUT, "sitemap.xml")));

const rfc822 = (iso) => new Date(`${iso}T12:00:00Z`).toUTCString();
write(
  join(OUT, "feed.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>DC Torpedo – News</title>
    <link>${SITE.url}/</link>
    <atom:link href="${SITE.url}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Neuigkeiten vom DC Torpedo Osnabrück-Schinkel</description>
    <language>de-de</language>
${posts
  .map(
    (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE.url}/news/${p.slug}/</link>
      <guid>${SITE.url}/news/${p.slug}/</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${esc(p.excerpt)}</description>
    </item>`
  )
  .join("\n")}
  </channel>
</rss>
`
);
written.push(relative(ROOT, join(OUT, "feed.xml")));

if (!PREVIEW && OUT === STATIC) {
  // Content-Security-Policy mit Hash des kleinen Inline-Skripts im <head>
  const inline = partials.head.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const scriptHash = createHash("sha256").update(inline).digest("base64");
  const apiOrigin = new URL(SITE.liga.api).origin;
  write(
    join(ROOT, "deploy/nginx/security-headers.inc"),
    `# Automatisch erzeugt von tools/build.mjs – nicht von Hand bearbeiten.
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-${scriptHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${apiOrigin}; frame-src https://www.openstreetmap.org; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()" always;
`
  );
  written.push("deploy/nginx/security-headers.inc");

  const rules = posts
    .filter((p) => p.oldUrl)
    .map((p) => `location = "${p.oldUrl}" { return 301 /news/${p.slug}/; }`);
  write(
    join(ROOT, "deploy/nginx/redirects.inc"),
    `# Automatisch erzeugt von tools/build.mjs – nicht von Hand bearbeiten.
# Leitet alte WordPress-Adressen auf die neuen Seiten um.
${rules.join("\n")}
location = /feed/ { return 301 /feed.xml; }
location = /members/ { return 301 /#saison; }
location = /labor/ { return 301 /; }
location = /landing/ { return 301 /; }
location = /elementor-31/ { return 301 /; }
location ^~ /wp-content/uploads/ { return 301 /; }
location ~ ^/(wp-admin|wp-login\\.php|xmlrpc\\.php|wp-json) { return 410; }
`
  );
  written.push("deploy/nginx/redirects.inc");
}

console.log(`✔ ${written.length} Dateien gebaut${PREVIEW ? " (Vorschau-Modus)" : ""} – ${posts.length} News`);

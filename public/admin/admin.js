/* DC Torpedo – Redaktion: Beiträge anlegen, bearbeiten, löschen.
   Fotos werden im Browser verkleinert (1600 px und 800 px, WebP bzw. JPEG),
   dabei fallen auch alle Metadaten wie GPS-Koordinaten weg. */
(() => {
  "use strict";

  const API = "api/news";
  const SIZES = [
    ["large", 1600],
    ["small", 800],
  ];
  const QUALITY = { webp: 0.8, jpg: 0.82 };
  // Jede Datei bleibt unter 900 KB – der vorgeschaltete nginx-proxy erlaubt nur 1 MB pro Anfrage
  const MAX_BYTES = 900 * 1024;

  const $ = (sel) => document.querySelector(sel);
  const form = $("#post-form");
  const titleEl = $("#title");
  const dateEl = $("#date");
  const textEl = $("#text");
  const coverInput = $("#cover");
  const galleryInput = $("#gallery");
  const coverList = $("#cover-preview");
  const galleryList = $("#gallery-preview");
  const statusEl = $("#status");
  const submitBtn = $("#submit");
  const savingsEl = $("#savings");
  const listEl = $("#post-list");
  const formTitle = $("#form-title");
  const cancelBtn = $("#cancel-edit");
  const currentCover = $("#current-cover");
  const currentCoverImg = $("#current-cover-img");
  const removeCover = $("#remove-cover");

  let editing = null; // Slug beim Bearbeiten
  let cover = null; // { id, file, state, result }
  let gallery = [];
  let busy = false;
  let dirty = false;
  let nextId = 1;

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fmtDate = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
  const small = (path) => path.replace(/-1600\.(webp|jpe?g)$/, "-800.$1");

  /* ---------------- Bilder komprimieren ---------------- */
  function encode(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  // Kann der Browser WebP erzeugen? (Safari z. B. nicht → dann JPEG)
  let webpSupport = null;
  async function canWebp() {
    if (webpSupport === null) {
      const c = document.createElement("canvas");
      c.width = c.height = 2;
      const blob = await encode(c, "image/webp", 0.8);
      webpSupport = Boolean(blob && blob.type === "image/webp");
    }
    return webpSupport;
  }

  async function compress(file) {
    if (!file.type.startsWith("image/")) throw new Error("Keine Bilddatei");
    const ext = (await canWebp()) ? "webp" : "jpg";
    const mime = ext === "webp" ? "image/webp" : "image/jpeg";
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode(); // Browser drehen das Bild dabei laut EXIF richtig
      const out = {};
      for (const [key, max] of SIZES) {
        const scale = Math.min(1, max / img.naturalWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let q = QUALITY[ext];
        let blob = await encode(canvas, mime, q);
        while (blob && blob.size > MAX_BYTES && q > 0.45) {
          q -= 0.1;
          blob = await encode(canvas, mime, q);
        }
        if (!blob || blob.size > MAX_BYTES) throw new Error("Bild konnte nicht verkleinert werden");
        out[key] = blob;
      }
      return {
        ext,
        large: out.large,
        small: out.small,
        before: file.size,
        after: out.large.size + out.small.size,
        preview: URL.createObjectURL(out.small),
      };
    } catch (err) {
      throw new Error(err.message === "Keine Bilddatei" ? err.message : "Format wird nicht unterstützt");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Nacheinander komprimieren, damit Handys nicht ins Schwitzen kommen
  let queue = Promise.resolve();
  function enqueue(item, render) {
    queue = queue.then(async () => {
      if (item.removed) return;
      item.state = "working";
      render();
      try {
        item.result = await compress(item.file);
        item.state = "done";
      } catch (err) {
        item.state = "error";
        item.error = err.message;
      }
      render();
    });
    return queue;
  }

  /* ---------------- Vorschau ---------------- */
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function thumb(item, onRemove) {
    const li = document.createElement("li");
    li.className = `thumb${item.state === "error" ? " is-error" : ""}`;
    if (item.result) {
      const img = document.createElement("img");
      img.src = item.result.preview;
      img.alt = "";
      li.append(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "thumb__ph skeleton";
      li.append(ph);
    }
    const meta = document.createElement("span");
    meta.className = "thumb__meta";
    if (item.state === "done") {
      meta.innerHTML = `${kb(item.result.before)} → <b>${kb(item.result.after)}</b>`;
    } else if (item.state === "error") {
      meta.textContent = `Fehler: ${item.error}`;
    } else {
      meta.textContent = item.state === "working" ? "Wird verkleinert …" : "Wartet …";
    }
    meta.title = item.file.name;
    li.append(meta);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb__remove";
    btn.setAttribute("aria-label", `${item.file.name} entfernen`);
    btn.innerHTML = icon;
    btn.addEventListener("click", onRemove);
    li.append(btn);
    return li;
  }

  function render() {
    coverList.replaceChildren(...(cover ? [thumb(cover, () => { drop(cover); cover = null; render(); })] : []));
    galleryList.replaceChildren(
      ...gallery.map((g) =>
        thumb(g, () => {
          drop(g);
          gallery = gallery.filter((x) => x !== g);
          render();
        })
      )
    );
    const items = [cover, ...gallery].filter(Boolean);
    const done = items.filter((i) => i.state === "done");
    if (items.length) {
      const before = done.reduce((s, i) => s + i.result.before, 0);
      const after = done.reduce((s, i) => s + i.result.after, 0);
      const pending = items.length - done.length - items.filter((i) => i.state === "error").length;
      savingsEl.textContent = pending
        ? `Fotos werden verkleinert … (${done.length}/${items.length})`
        : `${items.length} Foto${items.length === 1 ? "" : "s"}: ${kb(before)} → ${kb(after)}`;
    } else {
      savingsEl.textContent = "";
    }
  }

  function drop(item) {
    item.removed = true;
    if (item.result?.preview) URL.revokeObjectURL(item.result.preview);
  }

  coverInput.addEventListener("change", () => {
    const file = coverInput.files[0];
    coverInput.value = "";
    if (!file) return;
    if (cover) drop(cover);
    cover = { id: nextId++, file, state: "queued" };
    dirty = true;
    render();
    enqueue(cover, render);
  });

  galleryInput.addEventListener("change", () => {
    const files = [...galleryInput.files];
    galleryInput.value = "";
    for (const file of files) {
      const item = { id: nextId++, file, state: "queued" };
      gallery.push(item);
      enqueue(item, render);
    }
    dirty = true;
    render();
  });

  // Hervorhebung beim Drüberziehen
  document.querySelectorAll(".drop").forEach((zone) => {
    ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, () => zone.classList.add("is-over")));
    ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, () => zone.classList.remove("is-over")));
  });

  /* ---------------- Status ---------------- */
  function setStatus(kind, html, progress) {
    statusEl.hidden = false;
    statusEl.className = `status${kind ? ` is-${kind}` : ""}`;
    statusEl.innerHTML = html + (progress != null ? `<div class="progress"><span style="width:${Math.round(progress * 100)}%"></span></div>` : "");
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /* ---------------- API ---------------- */
  function request(method, url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.responseType = "json";
      if (body) xhr.setRequestHeader("Content-Type", "application/json");
      if (onProgress) xhr.upload.addEventListener("progress", (e) => e.lengthComputable && onProgress(e.loaded / e.total));
      xhr.addEventListener("load", () => {
        const data = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else if (xhr.status === 401) reject(new Error("Nicht angemeldet. Bitte die Seite neu laden."));
        else reject(new Error(data.error || `Fehler ${xhr.status}`));
      });
      xhr.addEventListener("error", () => reject(new Error("Keine Verbindung zum Server.")));
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  async function upload(blob) {
    const res = await fetch("api/upload", { method: "POST", headers: { "Content-Type": blob.type }, body: blob, credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 413) throw new Error("Ein Foto ist zu groß für den Server.");
      if (res.status === 401) throw new Error("Nicht angemeldet. Bitte die Seite neu laden.");
      throw new Error(data.error || `Upload fehlgeschlagen (${res.status}).`);
    }
    return data.id;
  }

  /** Beide Größen eines Fotos hochladen → { ext, large, small, alt } mit Upload-IDs */
  async function uploadImage(item, alt) {
    return { ext: item.result.ext, large: await upload(item.result.large), small: await upload(item.result.small), alt };
  }

  /* ---------------- Veröffentlichung verfolgen ----------------
     Gespeichert wird als Commit auf GitHub; die GitHub Action rollt ihn aus.
     Bis dahin steht der Beitrag als „ausstehend“ oben in der Liste. */
  const pending = new Map(); // slug → { title, action, commit }
  const ACTION_TEXT = { create: "Wird veröffentlicht …", update: "Änderung wird ausgerollt …", delete: "Wird gelöscht …" };

  function track(slug, title, action, commit, onDone) {
    pending.set(slug, { title, action, commit });
    loadList();
    const started = Date.now();
    const tick = async () => {
      try {
        const st = await request("GET", `api/status?commit=${encodeURIComponent(commit)}`);
        if (st.online) {
          pending.delete(slug);
          await loadList();
          onDone(true);
          return;
        }
      } catch (_) {
        /* nochmal versuchen */
      }
      if (Date.now() - started > 8 * 60e3) {
        pending.delete(slug);
        loadList();
        onDone(false);
        return;
      }
      setTimeout(tick, 5000);
    };
    setTimeout(tick, 4000);
  }

  /* ---------------- Liste ---------------- */
  async function loadList() {
    try {
      const data = await request("GET", API);
      const info = document.querySelector("#push-info");
      info.textContent = data.token
        ? "Speichern geht über GitHub – nach ca. 1 Minute online"
        : "Achtung: Auf dem Server fehlt das GitHub-Token – Speichern klappt so nicht";
      info.style.color = data.token ? "" : "var(--loss)";
      const pendingRows = [...pending.entries()]
        .filter(([slug, p]) => p.action === "create" && !data.posts.some((x) => x.slug === slug))
        .map(([, p]) => {
          const li = document.createElement("li");
          const ph = document.createElement("span");
          ph.className = "ph skeleton";
          const title = document.createElement("span");
          title.className = "post-list__title";
          title.textContent = p.title;
          const meta = document.createElement("span");
          meta.className = "post-list__meta";
          meta.textContent = ACTION_TEXT.create;
          li.append(ph, title, meta);
          return li;
        });
      if (!data.posts.length && !pendingRows.length) {
        listEl.innerHTML = '<li class="post-list__empty">Noch keine Beiträge.</li>';
        return;
      }
      listEl.replaceChildren(
        ...pendingRows,
        ...data.posts.map((p) => {
          const li = document.createElement("li");
          if (p.cover) {
            const img = document.createElement("img");
            img.src = small(p.cover);
            img.alt = "";
            img.loading = "lazy";
            li.append(img);
          } else {
            const ph = document.createElement("span");
            ph.className = "ph";
            li.append(ph);
          }
          const title = document.createElement("span");
          title.className = "post-list__title";
          title.textContent = p.title;
          const meta = document.createElement("span");
          meta.className = "post-list__meta";
          meta.innerHTML = `<span>${esc(fmtDate(p.date))}</span>`;
          const view = document.createElement("a");
          view.href = `../news/${encodeURIComponent(p.slug)}/`;
          view.target = "_blank";
          view.rel = "noopener";
          view.textContent = "Ansehen";
          const edit = document.createElement("button");
          edit.type = "button";
          edit.textContent = "Bearbeiten";
          edit.addEventListener("click", () => startEdit(p.slug));
          const del = document.createElement("button");
          del.type = "button";
          del.className = "danger";
          del.textContent = "Löschen";
          del.addEventListener("click", () => removePost(p));
          const state = pending.get(p.slug);
          if (state) {
            const note = document.createElement("span");
            note.className = "post-list__pending";
            note.textContent = ACTION_TEXT[state.action];
            meta.replaceChildren(note);
          } else {
            meta.append(view, edit, del);
          }
          li.append(title, meta);
          return li;
        })
      );
    } catch (err) {
      listEl.innerHTML = `<li class="post-list__empty">${esc(err.message)}</li>`;
    }
  }

  /* ---------------- Formular ---------------- */
  function resetForm() {
    form.reset();
    dateEl.value = today();
    [cover, ...gallery].filter(Boolean).forEach(drop);
    cover = null;
    gallery = [];
    editing = null;
    dirty = false;
    formTitle.textContent = "Neuer Beitrag";
    submitBtn.textContent = "Veröffentlichen";
    cancelBtn.hidden = true;
    currentCover.hidden = true;
    removeCover.checked = false;
    titleEl.removeAttribute("aria-invalid");
    render();
  }

  async function startEdit(slug) {
    if (busy) return;
    if (dirty && !window.confirm("Ungespeicherte Eingaben verwerfen?")) return;
    try {
      const p = await request("GET", `${API}/${encodeURIComponent(slug)}`);
      resetForm();
      editing = p.slug;
      titleEl.value = p.title;
      dateEl.value = p.date;
      textEl.value = p.text;
      formTitle.textContent = "Beitrag bearbeiten";
      submitBtn.textContent = "Änderungen speichern";
      cancelBtn.hidden = false;
      if (p.cover) {
        currentCoverImg.src = small(p.cover);
        currentCover.hidden = false;
      }
      statusEl.hidden = true;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      titleEl.focus({ preventScroll: true });
    } catch (err) {
      setStatus("error", esc(err.message));
    }
  }

  cancelBtn.addEventListener("click", () => {
    if (dirty && !window.confirm("Änderungen verwerfen?")) return;
    resetForm();
    statusEl.hidden = true;
  });

  async function removePost(p) {
    if (busy) return;
    if (!window.confirm(`„${p.title}“ wirklich löschen? Das lässt sich hier nicht rückgängig machen.`)) return;
    busy = true;
    setStatus("", "Wird gelöscht …");
    try {
      const res = await request("DELETE", `${API}/${encodeURIComponent(p.slug)}`);
      setStatus("ok", `„${esc(p.title)}“ ist gelöscht.<small>Von der Website verschwindet der Beitrag in etwa einer Minute.</small>`);
      if (editing === p.slug) resetForm();
      track(p.slug, p.title, "delete", res.commit, (ok) => {
        if (!ok) setStatus("error", "Das Ausrollen dauert ungewöhnlich lange. Bitte im Actions-Tab auf GitHub nachsehen.");
      });
    } catch (err) {
      setStatus("error", esc(err.message));
    } finally {
      busy = false;
    }
  }

  [titleEl, textEl, dateEl].forEach((el) => el.addEventListener("input", () => (dirty = true)));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const title = titleEl.value.trim();
    titleEl.setAttribute("aria-invalid", String(!title));
    if (!title) {
      setStatus("error", "Bitte einen Titel eingeben.");
      titleEl.focus();
      return;
    }
    if (!dateEl.value) {
      setStatus("error", "Bitte ein Datum wählen.");
      dateEl.focus();
      return;
    }
    if (!editing && !textEl.value.trim() && !gallery.length && !cover) {
      setStatus("error", "Bitte einen Text schreiben oder Fotos anhängen.");
      textEl.focus();
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    try {
      setStatus("", "Fotos werden vorbereitet …");
      await queue; // laufende Komprimierungen abwarten
      const failed = [cover, ...gallery].filter((i) => i && i.state === "error");
      if (failed.length) throw new Error("Mindestens ein Foto konnte nicht verarbeitet werden. Bitte entfernen und erneut versuchen.");

      const photos = [cover, ...gallery].filter(Boolean);
      let done = 0;
      const step = () => setStatus("", `Foto ${Math.min(done + 1, photos.length)} von ${photos.length} wird hochgeladen …`, photos.length ? done / photos.length : 1);
      const send = async (item, alt) => {
        step();
        const img = await uploadImage(item, alt);
        done++;
        return img;
      };
      const body = {
        title,
        date: dateEl.value,
        text: textEl.value,
        cover: cover ? await send(cover, title) : null,
        removeCover: Boolean(editing && removeCover.checked && !cover),
        gallery: [],
      };
      for (const [i, g] of gallery.entries()) body.gallery.push(await send(g, `${title} – Foto ${i + 1}`));

      setStatus("", "Beitrag wird gespeichert und die Seiten gebaut …", 1);
      const res = editing
        ? await request("PUT", `${API}/${encodeURIComponent(editing)}`, body)
        : await request("POST", API, body);

      const action = editing ? "update" : "create";
      const link = `<a href="..${esc(res.url)}" target="_blank" rel="noopener">Beitrag ansehen ↗</a>`;
      resetForm();
      setStatus("", `<span class="spinner" aria-hidden="true"></span>Gespeichert. ${ACTION_TEXT[action]}<small>Das dauert meist etwa eine Minute. Du kannst die Seite offen lassen oder schon den nächsten Beitrag schreiben.</small>`);
      track(res.slug, title, action, res.commit, (ok) => {
        if (ok) setStatus("ok", `${action === "create" ? "Online!" : "Änderung ist online!"} ${link}`);
        else setStatus("error", `Gespeichert, aber noch nicht online. Bitte im Actions-Tab auf GitHub nachsehen. ${link}`);
      });
    } catch (err) {
      setStatus("error", esc(err.message));
    } finally {
      busy = false;
      submitBtn.disabled = false;
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty || busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  resetForm();
  loadList();
})();

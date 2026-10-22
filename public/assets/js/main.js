/* DC Torpedo — Website-Skript. Ohne Abhängigkeiten. */
(() => {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------------------------------------------------------------
     1. Intro: Dart fliegt rein, Logo erscheint
     --------------------------------------------------------------- */
  const intro = document.querySelector("[data-intro]");
  if (intro) {
    const imgs = [...intro.querySelectorAll("img")];
    const ready = imgs.map((img) =>
      img.decode ? img.decode().catch(() => {}) : Promise.resolve()
    );
    const start = () => body.classList.add("is-intro");
    // Spätestens nach 1,5 s starten, auch wenn ein Bild hängt
    Promise.race([Promise.all(ready), new Promise((r) => setTimeout(r, 1500))]).then(() =>
      requestAnimationFrame(start)
    );

    intro.addEventListener("click", () => {
      if (reducedMotion.matches) return;
      body.classList.remove("is-intro");
      void intro.offsetWidth; // Reflow, damit die Animation neu startet
      start();
    });
  }

  /* ---------------------------------------------------------------
     2. Header & Navigation
     --------------------------------------------------------------- */
  const header = document.querySelector(".site-header");
  const navToggle = document.querySelector(".nav__toggle");
  const nav = document.getElementById("nav");

  if (header && !header.hasAttribute("data-always-solid")) {
    const onScroll = () => header.classList.toggle("is-solid", window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  const setNav = (open) => {
    root.classList.toggle("nav-open", open);
    navToggle?.setAttribute("aria-expanded", String(open));
    navToggle?.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
  };
  navToggle?.addEventListener("click", () => setNav(!root.classList.contains("nav-open")));
  nav?.addEventListener("click", (e) => {
    if (e.target.closest("a")) setNav(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root.classList.contains("nav-open")) {
      setNav(false);
      navToggle?.focus();
    }
  });

  /* ---------------------------------------------------------------
     3. Einblenden beim Scrollen
     --------------------------------------------------------------- */
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-visible"));
  }

  /* ---------------------------------------------------------------
     4. Rotierende Superlative
     --------------------------------------------------------------- */
  document.querySelectorAll("[data-rotator]").forEach((el) => {
    const words = (el.dataset.words || "").split("|").map((w) => w.trim()).filter(Boolean);
    if (words.length < 2 || reducedMotion.matches) return;
    let i = 0;
    let current = el.querySelector("span");
    setInterval(() => {
      if (document.hidden) return;
      i = (i + 1) % words.length;
      const next = document.createElement("span");
      next.textContent = words[i];
      next.className = "rotator__in";
      current.className = "rotator__out";
      el.append(next);
      const old = current;
      setTimeout(() => old.remove(), 500);
      current = next;
    }, 2200);
  });

  /* ---------------------------------------------------------------
     5. Liga: Tabelle, Spielplan, nächstes Spiel
     Daten: 2k-dart-software (öffentliche API). Wenn auf dem Server
     /data/liga.json aktuell ist (siehe deploy/), wird diese genutzt.
     --------------------------------------------------------------- */
  const liga = document.querySelector("[data-liga]");
  const tickers = document.querySelectorAll("[data-next-match]");
  const venueNext = document.querySelector("[data-next-home]");

  if (liga || tickers.length) {
    const cfgEl = liga || tickers[0];
    const cfg = {
      api: cfgEl.dataset.ligaApi,
      local: cfgEl.dataset.ligaLocal,
      team: cfgEl.dataset.ligaTeam,
      maxAgeH: Number(cfgEl.dataset.ligaMaxAge || 6),
    };
    loadLiga(cfg)
      .then((res) => renderLiga(res, cfg))
      .catch((err) => {
        console.warn("Liga-Daten nicht verfügbar:", err);
        liga?.querySelectorAll("[data-liga-target]").forEach((t) => {
          t.innerHTML =
            '<p class="season__error">Die Live-Daten sind gerade nicht erreichbar. Die offizielle Tabelle findest du über den Link unten.</p>';
        });
        liga?.querySelector("[data-liga-stats]")?.setAttribute("hidden", "");
        liga?.querySelectorAll("[data-liga-asof]").forEach((el) => (el.textContent = "Nicht erreichbar"));
      });
  }

  async function fetchJson(url, timeoutMs = 9000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.matches)) throw new Error("Unerwartetes Format");
      return { data, modified: res.headers.get("last-modified") };
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadLiga({ api, local, maxAgeH }) {
    let cached = null;
    if (local) {
      try {
        cached = await fetchJson(local, 4000);
      } catch (_) {
        cached = null;
      }
      if (cached) {
        const age = cached.modified ? Date.now() - Date.parse(cached.modified) : Infinity;
        if (age < maxAgeH * 3600e3) return { ...cached, stale: false };
      }
    }
    try {
      const live = await fetchJson(api);
      return { ...live, modified: null, stale: false };
    } catch (err) {
      if (cached) return { ...cached, stale: true };
      throw err;
    }
  }

  // "2026-10-24T17:30:00.000+0000" -> Date (Safari mag "+0000" nicht)
  const toDate = (s) => new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

  // Alle Zeiten in deutscher Zeit anzeigen – egal, wo der Besucher gerade ist
  const TZ = { timeZone: "Europe/Berlin" };
  const fmt = {
    wd: (d) => d.toLocaleDateString("de-DE", { ...TZ, weekday: "short" }).replace(".", ""),
    day: (d) => d.toLocaleDateString("de-DE", { ...TZ, day: "2-digit", month: "2-digit" }),
    date: (d) => d.toLocaleDateString("de-DE", { ...TZ, day: "2-digit", month: "2-digit", year: "numeric" }),
    time: (d) => d.toLocaleTimeString("de-DE", { ...TZ, hour: "2-digit", minute: "2-digit" }),
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function computeTable(matches) {
    const rows = new Map();
    const row = (name) => {
      if (!rows.has(name)) {
        rows.set(name, { name, played: 0, w: 0, d: 0, l: 0, pPlus: 0, pMinus: 0, sPlus: 0, sMinus: 0, lPlus: 0, lMinus: 0 });
      }
      return rows.get(name);
    };
    for (const m of matches) {
      const home = m.participantHome?.displayName;
      const away = m.participantGuest?.displayName;
      if (!home || !away) continue;
      row(home);
      row(away);
      if (m.statusCd !== "FINISH") continue;
      const sides = [
        [home, m.setsHome, m.setsAway, m.legsHome, m.legsAway],
        [away, m.setsAway, m.setsHome, m.legsAway, m.legsHome],
      ];
      for (const [name, sf, sa, lf, la] of sides) {
        const r = row(name);
        r.played++;
        r.sPlus += sf || 0;
        r.sMinus += sa || 0;
        r.lPlus += lf || 0;
        r.lMinus += la || 0;
        if (sf > sa) { r.w++; r.pPlus += 2; }
        else if (sf < sa) { r.l++; r.pMinus += 2; }
        else { r.d++; r.pPlus += 1; r.pMinus += 1; }
      }
    }
    // Sortierung wie in der Liga: Punktdifferenz, Pluspunkte, Spieldifferenz, Spiele, Legdifferenz, Legs
    return [...rows.values()].sort(
      (a, b) =>
        b.pPlus - b.pMinus - (a.pPlus - a.pMinus) ||
        b.pPlus - a.pPlus ||
        b.sPlus - b.sMinus - (a.sPlus - a.sMinus) ||
        b.sPlus - a.sPlus ||
        b.lPlus - b.lMinus - (a.lPlus - a.lMinus) ||
        b.lPlus - a.lPlus ||
        a.name.localeCompare(b.name, "de")
    );
  }

  function venueOf(m) {
    const v = m.participantHome?.teamSeason?.playingVenue || {};
    return {
      name: v.name || "Spielort folgt",
      street: v.locationStreet || "",
      city: [v.locationPostalCode, v.locationCity].filter(Boolean).join(" "),
    };
  }

  function renderLiga({ data, modified, stale }, cfg) {
    const all = data.matches.filter((m) => m.active !== false);
    const table = computeTable(all);
    const ours = all
      .filter((m) => [m.participantHome?.displayName, m.participantGuest?.displayName].includes(cfg.team))
      .map((m) => {
        const home = m.participantHome.displayName === cfg.team;
        const date = toDate(m.datePlanned);
        const done = m.statusCd === "FINISH";
        const us = home ? m.setsHome : m.setsAway;
        const them = home ? m.setsAway : m.setsHome;
        return {
          id: m.id,
          home,
          date,
          done,
          us,
          them,
          opponent: home ? m.participantGuest.displayName : m.participantHome.displayName,
          venue: venueOf(m),
          round: m.round?.name || "",
        };
      });
    const upcoming = ours.filter((m) => !m.done).sort((a, b) => a.date - b.date);
    const results = ours.filter((m) => m.done).sort((a, b) => b.date - a.date);
    const now = Date.now();
    const next = upcoming.find((m) => m.date.getTime() > now - 3 * 3600e3);
    const nextHome = upcoming.find((m) => m.home && m.date.getTime() > now - 3 * 3600e3);

    // Liga-Name aus den Daten
    const leagueName = all[0]?.event?.name;
    if (leagueName) document.querySelectorAll("[data-liga-name]").forEach((el) => (el.textContent = leagueName));

    // Nächstes Spiel (Hero)
    tickers.forEach((t) => {
      if (!next) return;
      t.querySelector("[data-next-text]").innerHTML =
        `${esc(fmt.wd(next.date))} ${esc(fmt.day(next.date))} · ${esc(fmt.time(next.date))} Uhr · ` +
        `<strong>${next.home ? "vs." : "@"} ${esc(next.opponent)}</strong>`;
      t.hidden = false;
    });

    // Nächstes Heimspiel (Schinkeltreff)
    if (venueNext && nextHome) {
      venueNext.innerHTML =
        `Nächstes Heimspiel<b>${esc(fmt.wd(nextHome.date))}, ${esc(fmt.date(nextHome.date))} · ${esc(fmt.time(nextHome.date))} Uhr</b>` +
        `gegen ${esc(nextHome.opponent)}`;
      venueNext.hidden = false;
    }

    if (!liga) return;

    // Kennzahlen
    const pos = table.findIndex((r) => r.name === cfg.team);
    const me = table[pos];
    const stats = liga.querySelector("[data-liga-stats]");
    if (stats && me) {
      const set = (k, html) => {
        const el = stats.querySelector(`[data-stat="${k}"]`);
        if (el) el.innerHTML = html;
      };
      set("pos", `${pos + 1}<small>/ ${table.length}</small>`);
      set("pts", `${me.pPlus}:${me.pMinus}`);
      set("sets", `${me.sPlus}:${me.sMinus}`);
      set("record", `${me.w}-${me.d}-${me.l}`);
    }

    // Tabelle
    const tableTarget = liga.querySelector('[data-liga-target="table"]');
    if (tableTarget) {
      tableTarget.innerHTML = `
        <div class="table-scroll">
          <table class="league">
            <caption class="visually-hidden">Tabelle ${esc(leagueName || "")}</caption>
            <thead>
              <tr>
                <th scope="col"><abbr title="Platz">Pl.</abbr></th>
                <th scope="col" class="team">Team</th>
                <th scope="col"><abbr title="Begegnungen">Sp.</abbr></th>
                <th scope="col" class="opt"><abbr title="Siege – Unentschieden – Niederlagen">S-U-N</abbr></th>
                <th scope="col" class="opt"><abbr title="Gewonnene : verlorene Spiele">Spiele</abbr></th>
                <th scope="col"><abbr title="Spieldifferenz">Diff.</abbr></th>
                <th scope="col"><abbr title="Punkte">Pkt.</abbr></th>
              </tr>
            </thead>
            <tbody>
              ${table
                .map((r, i) => {
                  const diff = r.sPlus - r.sMinus;
                  const diffCls = diff > 0 ? "diff-pos" : diff < 0 ? "diff-neg" : "";
                  return `<tr class="${r.name === cfg.team ? "is-us" : ""}">
                    <td class="pos">${i + 1}</td>
                    <td class="team">${esc(r.name)}</td>
                    <td>${r.played}</td>
                    <td class="opt">${r.w}-${r.d}-${r.l}</td>
                    <td class="opt">${r.sPlus}:${r.sMinus}</td>
                    <td class="${diffCls}">${diff > 0 ? "+" : ""}${diff}</td>
                    <td class="pts">${r.pPlus}:${r.pMinus}</td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>`;
    }

    // Stand: Server-Zeitstempel, sonst letzte Änderung in den Daten
    const lastChange = all.reduce((max, m) => {
      const t = Date.parse(String(m.lastUpdate || "").replace(" ", "T"));
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
    const asOf = modified ? new Date(modified) : stale && lastChange ? new Date(lastChange) : new Date();
    liga.querySelectorAll("[data-liga-asof]").forEach((el) => {
      el.textContent = `${stale ? "Stand" : "Aktualisiert"}: ${fmt.date(asOf)}, ${fmt.time(asOf)} Uhr`;
    });

    // Spielplan
    const planTarget = liga.querySelector('[data-liga-target="plan"]');
    if (!planTarget) return;
    const tabs = liga.querySelectorAll("[data-plan-tab]");
    const LIMIT = 6;
    let mode = upcoming.length ? "upcoming" : "results";
    let expanded = false;

    const icon = {
      cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18M12 13.5v4M10 15.5h4"/></svg>',
    };

    const matchRow = (m) => {
      const where = m.home ? "Schinkeltreff" : `${m.venue.name}${m.venue.city ? ", " + m.venue.city : ""}`;
      const chip = `<span class="chip ${m.home ? "chip--home" : ""}">${m.home ? "Heim" : "Ausw."}</span>`;
      let right;
      if (m.done) {
        const res = m.us > m.them ? "win" : m.us < m.them ? "loss" : "draw";
        const letter = { win: "S", loss: "N", draw: "U" }[res];
        const label = { win: "Sieg", loss: "Niederlage", draw: "Unentschieden" }[res];
        right = `<span class="score score--${res}"><span class="score__badge" title="${label}">${letter}</span>${m.us}:${m.them}<span class="visually-hidden"> – ${label}</span></span>`;
      } else {
        right = `<button type="button" class="cal-btn" data-ics="${m.id}" aria-label="Spiel gegen ${esc(m.opponent)} in den Kalender">${icon.cal}</button>`;
      }
      return `<li class="match">
        <span class="match__date"><span>${esc(fmt.wd(m.date))}</span><b>${esc(fmt.day(m.date))}</b>${m.done ? "" : `<span>${esc(fmt.time(m.date))}</span>`}</span>
        <span class="match__body">
          <span class="match__opp">${chip} ${esc(m.opponent)}</span>
          <span class="match__where">${esc(where)}</span>
        </span>
        ${right}
      </li>`;
    };

    const draw = () => {
      const list = mode === "upcoming" ? upcoming : results;
      const shown = expanded ? list : list.slice(0, LIMIT);
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.planTab === mode)));
      planTarget.innerHTML = list.length
        ? `<ul class="matches" id="plan-list">${shown.map(matchRow).join("")}</ul>` +
          (list.length > LIMIT
            ? `<div class="panel__foot"><button type="button" class="btn-text" data-plan-more>${
                expanded ? "Weniger anzeigen" : `Alle ${list.length} anzeigen`
              }</button></div>`
            : "")
        : `<p class="season__error">${mode === "upcoming" ? "Keine offenen Spiele mehr in dieser Saison." : "Noch keine Ergebnisse."}</p>`;
    };
    tabs.forEach((t) =>
      t.addEventListener("click", () => {
        mode = t.dataset.planTab;
        expanded = false;
        draw();
      })
    );
    planTarget.addEventListener("click", (e) => {
      if (e.target.closest("[data-plan-more]")) {
        expanded = !expanded;
        draw();
        return;
      }
      const btn = e.target.closest("[data-ics]");
      if (btn) {
        const m = ours.find((x) => String(x.id) === btn.dataset.ics);
        if (m) downloadIcs([m], `torpedo-${fmt.date(m.date).replaceAll(".", "-")}.ics`);
      }
    });
    liga.querySelector("[data-ics-all]")?.addEventListener("click", () => {
      if (upcoming.length) downloadIcs(upcoming, "dc-torpedo-spielplan.ics");
    });
    draw();
  }

  function downloadIcs(matches, filename) {
    const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const text = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DC Torpedo//Website//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    for (const m of matches) {
      const end = new Date(m.date.getTime() + 3 * 3600e3);
      const loc = [m.venue.name, m.venue.street, m.venue.city].filter(Boolean).join(", ");
      lines.push(
        "BEGIN:VEVENT",
        `UID:match-${m.id}@torpedo-dc.de`,
        `DTSTAMP:${stamp(new Date())}`,
        `DTSTART:${stamp(m.date)}`,
        `DTEND:${stamp(end)}`,
        `SUMMARY:${text(`Dart: DC Torpedo ${m.home ? "vs." : "@"} ${m.opponent}`)}`,
        `LOCATION:${text(loc)}`,
        `DESCRIPTION:${text(`${m.round} – ${m.home ? "Heimspiel" : "Auswärtsspiel"}`)}`,
        "END:VEVENT"
      );
    }
    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------------------------------------------------------------
     6. Karte erst nach Klick laden (keine Daten an Dritte vorher)
     --------------------------------------------------------------- */
  document.querySelectorAll("[data-map-load]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const box = document.querySelector(btn.dataset.mapLoad);
      if (!box) return;
      const iframe = document.createElement("iframe");
      iframe.src = box.dataset.src;
      iframe.title = "Karte: Schinkeltreff";
      iframe.loading = "lazy";
      iframe.referrerPolicy = "no-referrer";
      box.replaceChildren(iframe);
      box.hidden = false;
      btn.remove();
    });
  });

  /* ---------------------------------------------------------------
     7. Lightbox für Galerien
     --------------------------------------------------------------- */
  const galleryLinks = [...document.querySelectorAll("[data-lightbox]")];
  if (galleryLinks.length && "HTMLDialogElement" in window) {
    const dlg = document.createElement("dialog");
    dlg.className = "lightbox";
    dlg.setAttribute("aria-label", "Bildansicht");
    dlg.innerHTML =
      '<button type="button" class="lightbox__close" aria-label="Schließen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><img alt="">';
    document.body.append(dlg);
    const img = dlg.querySelector("img");
    let idx = 0;
    const show = (i) => {
      idx = (i + galleryLinks.length) % galleryLinks.length;
      const a = galleryLinks[idx];
      img.src = a.href;
      img.alt = a.querySelector("img")?.alt || "";
    };
    galleryLinks.forEach((a, i) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        show(i);
        dlg.showModal();
      })
    );
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest(".lightbox__close") || e.target === img) dlg.close();
    });
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(idx + 1);
      if (e.key === "ArrowLeft") show(idx - 1);
    });
  }

  /* ---------------------------------------------------------------
     8. Live auf Twitch
     Der Server fragt jede Minute bei Twitch nach und legt das Ergebnis
     in /data/live.json ab (deploy/liga-sync.sh). Der Browser fragt nur
     unseren Server – Twitch lädt erst nach Klick auf „ansehen“.
     --------------------------------------------------------------- */
  const liveNav = document.querySelectorAll("[data-live]");
  const liveSec = document.querySelector("[data-live-section]");
  const liveSrc = liveNav[0]?.dataset.liveSrc;
  let playerLoaded = false;

  function setLive(stream) {
    liveNav.forEach((el) => (el.hidden = !stream));
    if (!liveSec) return;
    // Läuft der Player schon, bleibt er stehen – Twitch zeigt selbst „offline“ an
    if (!stream) {
      if (!playerLoaded) liveSec.hidden = true;
      return;
    }
    liveSec.hidden = false;
    liveSec.querySelector("[data-live-title]").textContent = stream.title || "DC Torpedo live";
    const parts = [];
    const since = stream.started_at ? new Date(stream.started_at) : null;
    if (since && !isNaN(since)) parts.push(`Live seit ${fmt.time(since)} Uhr`);
    if (Number.isFinite(stream.viewer_count)) parts.push(`${stream.viewer_count} Zuschauer`);
    liveSec.querySelector("[data-live-meta]").textContent = parts.join(" · ");
  }

  async function checkLive() {
    let stream = null;
    try {
      const res = await fetch(liveSrc, { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        const fresh = Date.now() / 1000 - Number(j.checked || 0) < 15 * 60;
        const s = j?.twitch?.data?.[0];
        if (fresh && s && s.type === "live") stream = s;
      }
    } catch (_) {
      stream = null;
    }
    setLive(stream);
  }

  if (liveSrc) {
    checkLive();
    setInterval(() => document.hidden || checkLive(), 60e3);
    document.addEventListener("visibilitychange", () => document.hidden || checkLive());
  }

  liveSec?.querySelectorAll("[data-live-load]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const box = liveSec.querySelector("[data-live-player]");
      const channel = encodeURIComponent(liveSec.dataset.twitch || "");
      const iframe = document.createElement("iframe");
      iframe.src = `https://player.twitch.tv/?channel=${channel}&parent=${encodeURIComponent(location.hostname)}&autoplay=true`;
      iframe.title = "Livestream des DC Torpedo auf Twitch";
      iframe.allow = "autoplay; fullscreen";
      iframe.allowFullscreen = true;
      box.replaceChildren(iframe);
      box.classList.add("is-playing");
      playerLoaded = true;
      liveSec.querySelectorAll(".live__actions [data-live-load]").forEach((b) => b.remove());
      box.scrollIntoView({ behavior: "smooth", block: "center" });
    })
  );

  /* Jahr im Footer */
  document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));
})();

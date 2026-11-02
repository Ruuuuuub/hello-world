(function () {
  "use strict";

  const API = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets";
  const $ = (s) => document.querySelector(s);

  /* ---------------- Utilitaires ---------------- */
  const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  function norm(s) {
    return strip(s).toUpperCase()
      .replace(/[-'’.()\/,]/g, " ")
      .split(/\s+/).filter(Boolean)
      .map((t) => (t === "ST" ? "SAINT" : t === "STE" ? "SAINTE" : t))
      .join(" ");
  }
  const NOISE = new Set(["VILLE", "GARE", "SNCF", "TGV", "INTRAMUROS", "HBF", "HB"]);
  const stripNoise = (n) => n.split(" ").filter((t) => !NOISE.has(t)).join(" ");

  const KEEP_UP = new Set(["TGV", "CDG", "SBB", "HBF", "HB", "II"]);
  const SMALL = new Set(["de", "du", "des", "la", "le", "les", "sur", "en", "et", "au", "aux", "pres", "am", "d", "l"]);
  function pretty(name) {
    if (!name) return "";
    if (/\(intramuros\)/i.test(name)) return titleCase(name.replace(/\s*\(intramuros\)/i, "")) + " (toutes gares)";
    return titleCase(name.replace(/\.$/, "").replace(/ GARE SNCF$| GARE$/, "").replace(/(\S)\(/g, "$1 (").replace(/\s+/g, " "));
  }
  function titleCase(s) {
    let first = true;
    return s.split(/(\s+|-|'|\(|\/)/).map((w) => {
      if (!w || /^(\s+|-|'|\(|\/)$/.test(w)) return w;
      if (KEEP_UP.has(w.toUpperCase())) { first = false; return w.toUpperCase(); }
      const low = w.toLowerCase();
      if (!first && SMALL.has(low)) return low;
      first = false;
      return low.charAt(0).toUpperCase() + low.slice(1);
    }).join("").replace(/\bSt\b/g, "St").replace(/\bSte\b/g, "Ste");
  }
  const qstr = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toMin = (h) => { const [a, b] = h.split(":").map(Number); return a * 60 + b; };
  function duration(dep, arr) {
    let d = toMin(arr) - toMin(dep);
    if (d < 0) d += 1440;
    return d;
  }
  const fmtDur = (m) => (m >= 60 ? Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") : m + " min");
  function isoDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  function fmtDay(iso, long) {
    const d = new Date(iso + "T12:00:00");
    const today = isoDate(new Date());
    const tomorrow = isoDate(new Date(Date.now() + 864e5));
    if (!long && iso === today) return "Aujourd'hui";
    if (!long && iso === tomorrow) return "Demain";
    return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
  }
  const plural = (n, w) => n + " " + w + (n > 1 ? "s" : "");

  async function exportJSON(dataset, params) {
    const url = new URL(API + "/" + dataset + "/exports/json");
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  /* ---------------- Gares & coordonnées ---------------- */
  let stations = Array.from(new Set(window.STATION_NAMES));
  const coords = Object.assign({}, window.STATION_COORDS);
  let geoIndex = null;

  async function loadStationNames() {
    try {
      const all = new Set(stations);
      for (let offset = 0; offset < 1000; offset += 100) {
        const url = API + "/tgvmax/records?select=origine&group_by=origine&limit=100&offset=" + offset;
        const r = await fetch(url);
        if (!r.ok) break;
        const j = await r.json();
        (j.results || []).forEach((x) => x.origine && all.add(x.origine));
        if (!j.results || j.results.length < 100) break;
      }
      stations = Array.from(all);
    } catch (e) { /* on garde la liste intégrée */ }
  }

  async function loadGeo() {
    let rows = lsGet("ml_gares_v1");
    if (!rows || !rows.t || Date.now() - rows.t > 7 * 864e5) {
      try {
        const data = await exportJSON("gares-de-voyageurs", { select: "nom,position_geographique,segment_drg" });
        rows = { t: Date.now(), d: data.filter((g) => g.position_geographique).map((g) => [g.nom, g.position_geographique.lat, g.position_geographique.lon, g.segment_drg || "C"]) };
        lsSet("ml_gares_v1", rows);
      } catch (e) { rows = { d: [] }; }
    }
    const rank = { A: 0, B: 1, C: 2 };
    const exact = new Map(), loose = new Map(), list = [];
    rows.d.sort((a, b) => (rank[a[3]] ?? 3) - (rank[b[3]] ?? 3)).forEach(([nom, lat, lon]) => {
      const n = norm(nom), s = stripNoise(n);
      if (!exact.has(n)) exact.set(n, [lat, lon]);
      if (s && !loose.has(s)) loose.set(s, [lat, lon]);
      list.push({ t: s.split(" "), c: [lat, lon] });
    });
    geoIndex = { exact, loose, list };
  }

  function locate(name) {
    if (coords[name] !== undefined) return coords[name];
    let c = null;
    if (geoIndex) {
      const n = norm(name), s = stripNoise(n);
      c = geoIndex.exact.get(n) || geoIndex.loose.get(s) || null;
      if (!c && s) {
        const tok = s.split(" ");
        let best = null, bestLen = 0;
        for (const g of geoIndex.list) {
          const k = Math.min(g.t.length, tok.length);
          let ok = k > 0;
          for (let i = 0; i < k && ok; i++) ok = g.t[i] === tok[i];
          if (ok && k > bestLen) { best = g.c; bestLen = k; }
        }
        c = best;
      }
    }
    if (geoIndex) coords[name] = c;
    return c;
  }

  /* ---------------- Carte ---------------- */
  const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([46.6, 2.6], 6);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const baseLayer = L.layerGroup().addTo(map);
  const resultLayer = L.layerGroup().addTo(map);
  const markers = new Map();

  function drawAllStations() {
    baseLayer.clearLayers();
    stations.forEach((name) => {
      const c = locate(name);
      if (!c) return;
      L.circleMarker(c, { radius: 4, weight: 1, color: "#8b8fa3", fillColor: "#c9ccd8", fillOpacity: 0.9 })
        .bindTooltip(pretty(name), { direction: "top", offset: [0, -4] })
        .on("click", () => {
          if (!state.from) setStation("from", name);
          else if (!state.to && name !== state.from) setStation("to", name);
          else setStation("from", name);
          runSearch();
        })
        .addTo(baseLayer);
    });
  }

  const originIcon = L.divIcon({ className: "pin-origin", html: "<span></span>", iconSize: [26, 26], iconAnchor: [13, 13] });

  /* ---------------- État & formulaire ---------------- */
  const state = { from: null, to: null, date: isoDate(new Date()), period: "all", sort: "trains", rows: [], mode: null, selected: null, calDate: null };

  function setStation(which, name) {
    state[which] = name;
    $("#" + which).value = name ? pretty(name) : "";
    $("#" + which).closest(".input-wrap").classList.toggle("filled", !!name);
  }

  function setupCombo(which) {
    const input = $("#" + which), list = $("#" + which + "-list");
    let active = -1, items = [];
    function close() { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; }
    function render() {
      const q = norm(input.value);
      if (!q) { items = POPULAR.slice(); }
      else {
        const qs = q.split(" ");
        items = stations
          .map((s) => { const n = norm(pretty(s)); return { s, n, score: n.startsWith(q) ? 0 : n.split(" ").some((t) => t.startsWith(qs[0])) ? 1 : 2 }; })
          .filter((o) => qs.every((t) => o.n.includes(t)))
          .sort((a, b) => a.score - b.score || a.n.localeCompare(b.n))
          .slice(0, 8).map((o) => o.s);
      }
      list.innerHTML = items.length
        ? items.map((s, i) => `<li role="option" data-i="${i}" class="${i === active ? "active" : ""}"><span class="sg-ico">${/intramuros/.test(s) ? "🏙️" : "🚉"}</span>${esc(pretty(s))}</li>`).join("")
        : `<li class="empty">Aucune gare trouvée</li>`;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    function pick(i) {
      if (items[i] === undefined) return;
      setStation(which, items[i]);
      close();
      $("#form-msg").textContent = "";
      if (which === "from" && !state.to) $("#go").focus();
    }
    input.addEventListener("focus", () => { input.select(); render(); });
    input.addEventListener("input", () => { state[which] = null; input.closest(".input-wrap").classList.remove("filled"); active = -1; render(); });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter") { if (items.length && input.value) { pick(active < 0 ? 0 : active); e.preventDefault(); } }
      else if (e.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(() => {
      close();
      if (!state[which] && input.value.trim()) {
        const q = norm(input.value);
        const m = stations.find((s) => norm(pretty(s)) === q || norm(s) === q);
        if (m) setStation(which, m);
      }
    }, 150));
    list.addEventListener("mousedown", (e) => { const li = e.target.closest("li[data-i]"); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  }
  setupCombo("from");
  setupCombo("to");

  document.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => { setStation(b.dataset.clear, null); $("#" + b.dataset.clear).focus(); }));
  $("#swap").addEventListener("click", () => { const f = state.from, t = state.to; setStation("from", t); setStation("to", f); if (state.from || state.to) runSearch(); });

  // Raccourcis populaires
  const quick = $("#quick");
  POPULAR.slice(0, 5).forEach((s) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = pretty(s).replace(" (toutes gares)", "");
    b.addEventListener("click", () => { setStation("from", s); runSearch(); });
    quick.appendChild(b);
  });

  // Dates : 7 pastilles + sélecteur libre (fenêtre de réservation de 30 jours)
  const dateInput = $("#date");
  const minD = isoDate(new Date()), maxD = isoDate(new Date(Date.now() + 30 * 864e5));
  dateInput.min = minD; dateInput.max = maxD; dateInput.value = state.date;
  function renderDates() {
    const box = $("#dates");
    let html = "";
    for (let i = 0; i < 7; i++) {
      const iso = isoDate(new Date(Date.now() + i * 864e5));
      const d = new Date(iso + "T12:00:00");
      html += `<button type="button" class="day ${iso === state.date ? "on" : ""}" data-d="${iso}"><small>${i === 0 ? "Auj." : i === 1 ? "Dem." : DAYS[d.getDay()]}</small><b>${d.getDate()}</b><small>${MONTHS[d.getMonth()]}</small></button>`;
    }
    const inWeek = state.date <= isoDate(new Date(Date.now() + 6 * 864e5));
    html += `<label class="day more ${inWeek ? "" : "on"}" for="date"><small>Autre</small><b>📅</b><small>${inWeek ? "date" : fmtDay(state.date, true).split(" ").slice(1).join(" ")}</small></label>`;
    box.innerHTML = html;
  }
  $("#dates").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-d]");
    if (b) { state.date = b.dataset.d; dateInput.value = state.date; renderDates(); if (state.from || state.to) runSearch(); }
  });
  $("#dates").addEventListener("click", (e) => {
    if (e.target.closest(".more")) { try { dateInput.showPicker(); } catch (err) { dateInput.focus(); } }
  });
  dateInput.addEventListener("change", () => { if (dateInput.value) { state.date = dateInput.value; renderDates(); if (state.from || state.to) runSearch(); } });
  renderDates();

  $("#search").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });

  /* ---------------- Recherche ---------------- */
  let searchId = 0;
  async function runSearch() {
    const msg = $("#form-msg");
    if (!state.from && !state.to) { msg.textContent = "Choisis au moins une gare de départ ou d'arrivée dans la liste."; $("#from").focus(); return; }
    if (state.from && state.from === state.to) { msg.textContent = "Le départ et l'arrivée sont identiques."; return; }
    msg.textContent = "";
    const id = ++searchId;
    $("#map-loading").hidden = false;
    $("#results").innerHTML = skeleton();
    state.selected = null;
    updateUrl();
    try {
      const where = ['od_happy_card="OUI"'];
      if (state.from) where.push("origine=" + qstr(state.from));
      if (state.to) where.push("destination=" + qstr(state.to));
      const both = state.from && state.to;
      if (!both) where.push("date=date'" + state.date + "'");
      const rows = await exportJSON("tgvmax", { where: where.join(" AND "), order_by: "date,heure_depart" });
      if (id !== searchId) return;
      state.rows = rows;
      state.mode = both ? "both" : state.from ? "from" : "to";
      if (both) {
        const days = new Set(rows.map((r) => r.date));
        state.calDate = days.has(state.date) ? state.date : (rows[0] ? rows[0].date : state.date);
      }
      render();
    } catch (err) {
      if (id !== searchId) return;
      $("#results").innerHTML = `<div class="card empty-state"><div class="big">📡</div><h3>Impossible de joindre les données SNCF</h3><p>Vérifie ta connexion puis réessaie dans un instant.</p><button class="btn-ghost" id="retry">Réessayer</button></div>`;
      $("#retry").onclick = runSearch;
      resultLayer.clearLayers();
    } finally {
      if (id === searchId) $("#map-loading").hidden = true;
    }
  }

  const PERIODS = { all: [0, 1440], morning: [0, 720], afternoon: [720, 1080], evening: [1080, 1440] };
  const inPeriod = (r) => { const m = toMin(r.heure_depart); const [a, b] = PERIODS[state.period]; return m >= a && m < b; };

  function dedupe(rows) {
    const seen = new Set();
    return rows.filter((r) => { const k = r.date + r.train_no + r.origine + r.destination + r.heure_depart; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function render() {
    resultLayer.clearLayers();
    markers.clear();
    if (state.mode === "both") return renderBoth();

    const key = state.mode === "from" ? "destination" : "origine";
    const anchor = state.mode === "from" ? state.from : state.to;
    const rows = dedupe(state.rows).filter(inPeriod);
    const groups = new Map();
    rows.forEach((r) => {
      if (!groups.has(r[key])) groups.set(r[key], []);
      groups.get(r[key]).push(r);
    });
    let list = Array.from(groups, ([name, trains]) => ({
      name, trains,
      minDur: Math.min(...trains.map((t) => duration(t.heure_depart, t.heure_arrivee))),
      first: trains[0].heure_depart,
    }));
    const sorters = {
      trains: (a, b) => b.trains.length - a.trains.length,
      duration: (a, b) => a.minDur - b.minDur,
      first: (a, b) => a.first.localeCompare(b.first),
      az: (a, b) => pretty(a.name).localeCompare(pretty(b.name)),
    };
    list.sort(sorters[state.sort]);

    // Carte
    const ac = locate(anchor);
    const bounds = [];
    if (ac) {
      bounds.push(ac);
      L.marker(ac, { icon: originIcon, zIndexOffset: 1000 }).bindTooltip(pretty(anchor), { permanent: true, direction: "top", offset: [0, -14], className: "tt-origin" }).addTo(resultLayer);
    }
    const maxT = Math.max(1, ...list.map((g) => g.trains.length));
    list.forEach((g) => {
      const c = locate(g.name);
      if (!c) return;
      bounds.push(c);
      if (ac) L.polyline([ac, c], { color: "#16a34a", weight: 1.5, opacity: 0.35, dashArray: "4 6" }).addTo(resultLayer);
      const m = L.circleMarker(c, { radius: 7 + 7 * (g.trains.length / maxT), weight: 2, color: "#fff", fillColor: "#16a34a", fillOpacity: 0.95 })
        .bindTooltip(`<b>${esc(pretty(g.name))}</b><br>${plural(g.trains.length, "train")} à 0 € · dès ${fmtDur(g.minDur)}`, { direction: "top", offset: [0, -8] })
        .on("click", () => selectGroup(g.name, true))
        .addTo(resultLayer);
      markers.set(g.name, m);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });
    else if (bounds.length === 1) map.setView(bounds[0], 8);

    // Liste
    const verb = state.mode === "from" ? "Destinations" : "Gares de départ";
    const total = rows.length;
    let html = `<div class="res-head">
      <div>
        <h2>${list.length ? `<span class="count">${list.length}</span> ${state.mode === "from" ? "destination" + (list.length > 1 ? "s" : "") + " à 0 €" : "gare" + (list.length > 1 ? "s" : "") + " de départ à 0 €"}` : "Aucun train à 0 €"}</h2>
        <p class="sub">${state.mode === "from" ? "Au départ de" : "Pour aller à"} <b>${esc(pretty(anchor))}</b> · ${fmtDay(state.date, true)}${total ? " · " + plural(total, "train") : ""}</p>
      </div>
    </div>
    ${filtersBar(true)}`;
    if (!list.length) {
      html += emptyState();
    } else {
      html += `<ul class="groups">` + list.map((g) => `
        <li class="group" data-name="${esc(g.name)}">
          <button class="g-head" type="button" aria-expanded="false">
            <span class="g-dot"></span>
            <span class="g-main"><b>${esc(pretty(g.name))}</b><small>Dès ${fmtDur(g.minDur)} · 1er départ ${g.first.replace(":", "h")}</small></span>
            <span class="g-count">${g.trains.length}<small>${g.trains.length > 1 ? "trains" : "train"}</small></span>
            <span class="g-free">0 €</span>
          </button>
          <div class="g-body" hidden>${trainList(g.trains)}
            <button type="button" class="btn-link" data-detail="${esc(g.name)}">Voir les autres jours pour ce trajet →</button>
          </div>
        </li>`).join("") + `</ul>`;
    }
    $("#results").innerHTML = html;
    bindFilters();
    document.querySelectorAll(".group .g-head").forEach((h) => h.addEventListener("click", () => selectGroup(h.parentElement.dataset.name, false)));
    document.querySelectorAll("[data-detail]").forEach((b) => b.addEventListener("click", () => {
      const other = b.dataset.detail;
      if (state.mode === "from") setStation("to", other); else setStation("from", other);
      runSearch();
      $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function selectGroup(name, fromMap) {
    const li = Array.from(document.querySelectorAll(".group")).find((x) => x.dataset.name === name);
    if (!li) return;
    const open = li.classList.contains("open") && !fromMap;
    document.querySelectorAll(".group.open").forEach((x) => { x.classList.remove("open"); x.querySelector(".g-body").hidden = true; x.querySelector(".g-head").setAttribute("aria-expanded", "false"); });
    markers.forEach((m) => m.setStyle({ fillColor: "#16a34a" }));
    if (open) { state.selected = null; return; }
    li.classList.add("open");
    li.querySelector(".g-body").hidden = false;
    li.querySelector(".g-head").setAttribute("aria-expanded", "true");
    state.selected = name;
    const m = markers.get(name);
    if (m) {
      m.setStyle({ fillColor: "#f59e0b" }); m.bringToFront(); m.openTooltip();
      if (!fromMap) map.panTo(m.getLatLng());
    }
    li.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function trainList(trains) {
    return `<ul class="trains">` + trains.map((t) => {
      const d = duration(t.heure_depart, t.heure_arrivee);
      return `<li class="train">
        <div class="t-times"><b>${t.heure_depart.replace(":", "h")}</b><span class="t-line"><i></i><small>${fmtDur(d)}</small><i></i></span><b>${t.heure_arrivee.replace(":", "h")}</b></div>
        <div class="t-meta"><span>${esc(pretty(t.origine))} → ${esc(pretty(t.destination))}</span><span class="t-no">Train n° ${esc(t.train_no)}</span></div>
      </li>`;
    }).join("") + `</ul>
    <a class="btn-book" href="https://www.sncf-connect.com/" target="_blank" rel="noopener">Réserver sur SNCF Connect ↗</a>`;
  }

  function filtersBar(withSort) {
    const p = (k, l) => `<button type="button" class="pill ${state.period === k ? "on" : ""}" data-period="${k}">${l}</button>`;
    return `<div class="filters">
      <div class="pills">${p("all", "Toute la journée")}${p("morning", "🌅 Matin")}${p("afternoon", "☀️ Après-midi")}${p("evening", "🌙 Soir")}</div>
      ${withSort ? `<label class="sort">Trier : <select id="sort">
        <option value="trains" ${state.sort === "trains" ? "selected" : ""}>Plus de trains</option>
        <option value="duration" ${state.sort === "duration" ? "selected" : ""}>Plus rapide</option>
        <option value="first" ${state.sort === "first" ? "selected" : ""}>Plus tôt</option>
        <option value="az" ${state.sort === "az" ? "selected" : ""}>A → Z</option>
      </select></label>` : ""}
    </div>`;
  }
  function bindFilters() {
    document.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => { state.period = b.dataset.period; render(); }));
    const s = $("#sort");
    if (s) s.addEventListener("change", () => { state.sort = s.value; render(); });
  }

  function emptyState() {
    return `<div class="card empty-state"><div class="big">😕</div><h3>Plus de place à 0 € ${state.period !== "all" ? "sur ce créneau" : "ce jour-là"}</h3>
      <p>Essaie une autre date ${state.period !== "all" ? "ou un autre moment de la journée" : "ou une gare voisine"}. Des places se libèrent régulièrement.</p></div>`;
  }

  function renderBoth() {
    const all = dedupe(state.rows);
    const byDay = new Map();
    all.forEach((r) => { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); });
    const dayTrains = (byDay.get(state.calDate) || []).filter(inPeriod);

    // Carte : départ + arrivée
    const a = locate(state.from), b = locate(state.to);
    if (a) L.marker(a, { icon: originIcon, zIndexOffset: 1000 }).bindTooltip(pretty(state.from), { permanent: true, direction: "top", offset: [0, -14], className: "tt-origin" }).addTo(resultLayer);
    if (b) L.circleMarker(b, { radius: 11, weight: 3, color: "#fff", fillColor: all.length ? "#16a34a" : "#9ca3af", fillOpacity: 1 }).bindTooltip(pretty(state.to), { permanent: true, direction: "top", offset: [0, -10] }).addTo(resultLayer);
    if (a && b) {
      L.polyline([a, b], { color: all.length ? "#16a34a" : "#9ca3af", weight: 3, opacity: 0.7, dashArray: "6 8" }).addTo(resultLayer);
      map.fitBounds([a, b], { padding: [60, 60], maxZoom: 9 });
    } else if (a || b) map.setView(a || b, 8);

    // Calendrier 31 jours
    let cal = "";
    for (let i = 0; i <= 30; i++) {
      const iso = isoDate(new Date(Date.now() + i * 864e5));
      const d = new Date(iso + "T12:00:00");
      const n = (byDay.get(iso) || []).length;
      cal += `<button type="button" class="cal-day ${n ? "has" : "none"} ${iso === state.calDate ? "on" : ""}" data-cal="${iso}" ${n ? "" : "disabled"} title="${fmtDay(iso, true)} : ${n ? plural(n, "train") + " à 0 €" : "aucune place"}">
        <small>${DAYS[d.getDay()]}</small><b>${d.getDate()}</b><span>${n ? n : "–"}</span></button>`;
    }
    const nDays = byDay.size;
    let html = `<div class="res-head"><div>
      <h2>${esc(pretty(state.from))} <span class="arrow">→</span> ${esc(pretty(state.to))}</h2>
      <p class="sub">${nDays ? `Places à 0 € disponibles <b>${plural(nDays, "jour")}</b> sur les 30 prochains` : "Aucune place à 0 € sur les 30 prochains jours"}</p>
    </div></div>`;
    html += `<div class="card cal-card"><div class="cal-title">Choisis ton jour <small>(nombre de trains à 0 €)</small></div><div class="cal">${cal}</div></div>`;
    if (nDays) {
      html += `<h3 class="day-title">${fmtDay(state.calDate, true)}</h3>` + filtersBar(false);
      html += dayTrains.length ? `<div class="card">${trainList(dayTrains)}</div>` : emptyState();
    } else {
      html += `<div class="card empty-state"><div class="big">🔍</div><h3>Ce trajet n'est pas disponible à 0 € pour le moment</h3><p>Essaie sans gare d'arrivée pour découvrir toutes les destinations possibles depuis ${esc(pretty(state.from))}.</p><button class="btn-ghost" id="anywhere">Voir toutes les destinations</button></div>`;
    }
    $("#results").innerHTML = html;
    bindFilters();
    document.querySelectorAll("[data-cal]").forEach((x) => x.addEventListener("click", () => { state.calDate = x.dataset.cal; state.date = x.dataset.cal; dateInput.value = state.date; renderDates(); render(); }));
    const on = document.querySelector(".cal-day.on");
    if (on) on.scrollIntoView({ block: "nearest", inline: "center" });
    const any = $("#anywhere");
    if (any) any.onclick = () => { setStation("to", null); runSearch(); };
  }

  function skeleton() {
    return `<div class="skeleton"><div></div><div></div><div></div><div></div></div>`;
  }

  /* ---------------- URL partageable ---------------- */
  function updateUrl() {
    const p = new URLSearchParams();
    if (state.from) p.set("de", state.from);
    if (state.to) p.set("a", state.to);
    p.set("date", state.date);
    history.replaceState(null, "", "?" + p.toString());
  }
  function readUrl() {
    const p = new URLSearchParams(location.search);
    const d = p.get("date");
    if (d && d >= minD && d <= maxD) { state.date = d; dateInput.value = d; renderDates(); }
    if (p.get("de")) setStation("from", p.get("de"));
    if (p.get("a")) setStation("to", p.get("a"));
    return !!(state.from || state.to);
  }

  /* ---------------- Démarrage ---------------- */
  const hasQuery = readUrl();
  $("#results").innerHTML = `<div class="card intro">
    <h3>Comment ça marche ?</h3>
    <ul>
      <li>🟢 Chaque <b>point vert</b> sur la carte = une gare où tu peux aller <b>gratuitement</b> ce jour-là.</li>
      <li>🎯 Mets <b>seulement ton départ</b> pour découvrir toutes les destinations possibles.</li>
      <li>📅 Mets <b>départ + arrivée</b> pour voir les jours où il reste des places sur 30 jours.</li>
      <li>👆 Tu peux aussi <b>cliquer sur une gare</b> de la carte pour la choisir.</li>
    </ul>
  </div>`;
  (async () => {
    await Promise.all([loadGeo(), loadStationNames()]);
    drawAllStations();
    if (state.mode) render(); // repositionne les gares une fois les coordonnées chargées
  })();
  if (hasQuery) runSearch();
})();

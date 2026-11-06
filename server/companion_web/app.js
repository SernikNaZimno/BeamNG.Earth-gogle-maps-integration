// BeamNG.Earth live map (phases 1 to 3 of the Google Maps integration; contract: docs/COMPANION.md).
// Plain JS, no build step. The map is drawn by one of two renderers behind one small interface ("renderers" below):
// MapLibre GL JS (bundled in vendor/maplibre-gl/, the default: no key) over a keyless base map, or Google's Maps
// JavaScript API, loaded only when the player picks it with their own key.
// Everything that comes from the server or from Google is inserted as text (textContent), never as HTML.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TOKEN = new URLSearchParams(location.search).get("t") || "";
  // phase 2: the same files on a phone over the local network (any address but the PC's own loopback names)
  const PHONE = ["127.0.0.1", "localhost", "[::1]"].indexOf(location.hostname) < 0;
  const SITE = "http://" + location.host + "/*";     // what the key's website restriction must allow for this page
  const KEY_RE = /^[A-Za-z0-9_-]{20,80}$/;
  const UNITS_KEY = "bne.liveMap.units";
  const BASE_KEY = "bne.liveMap.base";
  const RETRY_MS = 3000;
  const BUSY_MS = 61000;          // after a 429 (the server blocks a peer for 60 s)
  const LAN_POLL_MS = 5000;       // the phone box asks /api/lan this often (a new code made in the game shows too)
  const JUMP_M = 2000;            // a move farther than this between two states is a teleport: no animation
  const FIRST_ZOOM = 16;          // zoom levels in this file are Google's (256 px tiles) whichever renderer draws
  // phase 3: the base maps (docs/COMPANION.md "The map without a key")
  const BASES = ["streets", "satellite", "terrain", "google"];
  const BASE_NAMES = { streets: "Streets", satellite: "Satellite", terrain: "Terrain", google: "Google Maps" };
  const STREETS_STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const TILE_MAX_Z = 18;          // maptiles.MAX_Z: the deepest tile the server makes (MapLibre overzooms beyond)
  const EOX_CREDIT = "EOX IT Services GmbH (maps.eox.at), data © OpenStreetMap contributors and others";
  const BASE_GRACE_MS = 12000;    // a base map whose style or first tiles have not loaded by then has failed
  const MSG_EXPIRED = PHONE
    ? "This link has expired: scan the new QR code on the PC"
    : "This link is no longer valid (the world server was restarted?). Open the Live map again from the game (world map > Live map).";
  const MSG_NO_GAME = "The game is not connected";
  // (a phone cannot tell a lost Wi-Fi from sharing stopped on the PC: nothing answers either way)
  const MSG_NO_SERVER = PHONE ? "The PC is not reachable (same Wi-Fi? sharing still on?)" : "World server not reachable";
  const MSG_BUSY = "Too many requests: wait a minute";
  const MSG_STREETS_DOWN = "Street map unavailable (offline?): showing the world server's satellite map";
  const MSG_KEY_REFUSED = "Google did not accept the API key. In Google Cloud check that the key may use the Maps JavaScript API, " +
    "that billing is enabled, and that its website restriction allows " + SITE + (PHONE
    ? " (this phone's address, besides the PC's). The key itself is replaced or removed on the PC."
    : " . Replace or remove the key below.");

  // ------------------------------------------------------------------------------------------ state
  let units = loadUnits();        // "metric" | "imperial"
  let state = null;               // the last state JSON
  let streamUp = false;           // the event stream is open
  let triedStream = false;
  let unreachable = false;        // the last check of /api/state got no answer at all
  let expired = false;
  let keyStored = "";

  let view = null;                // the renderer drawing the map (libreView / googleView), null while none is up
  let lastAt = null;              // the last view ({lat, lon, zoom}) of a renderer that was taken down
  let base = "";                  // the base map shown or being loaded: one of BASES
  let baseSeq = 0;                // bumped by every switch: a slow Google start that was overtaken is dropped
  let streetsDown = false;        // the street map failed in this page (offline?) and the fallback was used
  let libreBroken = false;        // MapLibre cannot run here (no WebGL, its script missing)
  let mapMsg = false;             // the message card shows a map problem (hidden again when a base map loads)
  let routeVersion = -1, routePoints = [];
  let searchPin = null;           // {lat, lon, title}: the search result the menu is open for
  let hadGps = false;
  let follow = true;
  let menuOpen = false;           // the click menu holds the map still (follow mode would pan it away)

  let shown = null;               // the car as drawn: {lat, lon, heading}
  let anim = null;                // {from, to, start, dur}
  let animating = false;
  let lastPoseAt = 0;

  // ------------------------------------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function num(v) { return typeof v === "number" && isFinite(v); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function capital(s) { s = String(s || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function loadUnits() {
    try { return localStorage.getItem(UNITS_KEY) === "imperial" ? "imperial" : "metric"; } catch (e) { return "metric"; }
  }
  function saveUnits() {
    try { localStorage.setItem(UNITS_KEY, units); } catch (e) { /* private window: not remembered */ }
  }

  function fmtSpeed(ms) {
    if (!num(ms)) return "-";
    return String(Math.round(Math.max(0, ms) * (units === "imperial" ? 2.236936 : 3.6)));
  }
  function fmtDist(m) {
    if (!num(m)) return "-";
    if (units === "imperial") {
      const mi = m / 1609.344;
      if (mi < 0.1) return Math.round(m * 3.28084 / 10) * 10 + " ft";
      return (mi < 100 ? mi.toFixed(1) : String(Math.round(mi))) + " mi";
    }
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    return (m < 100000 ? (m / 1000).toFixed(1) : String(Math.round(m / 1000))) + " km";
  }
  function fmtDur(s) {
    if (!num(s)) return "-";
    if (s < 60) return "<1 min";
    const m = Math.round(s / 60), h = Math.floor(m / 60);
    return h ? h + " h " + String(m % 60).padStart(2, "0") + " min" : m + " min";
  }
  function fmtClock(s) {
    if (!num(s)) return "";
    try {
      return new Date(Date.now() + s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  function fmtCoord(lat, lon) { return lat.toFixed(5) + ", " + lon.toFixed(5); }

  let toastTimer = 0;
  function toast(text, bad, ms) {
    const t = $("toast");
    t.textContent = text;
    t.className = bad ? "bad" : "";
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || (bad ? 6000 : 2500));
  }

  function showMessage(text, bad) {
    const m = $("message");
    m.textContent = text;
    m.className = "card" + (bad ? " bad" : "");
    m.hidden = false;
    mapMsg = false;
  }
  // a map problem (no base map at all): hidden again when one loads; never over the expired link's message
  function mapMessage(text) {
    if (expired) return;
    showMessage(text, true);
    mapMsg = true;
  }

  function setStatus() {
    const s = $("status");
    let text = "", cls = "";
    if (expired) { text = "Link expired"; cls = "bad"; }
    else if (triedStream && !streamUp) {
      // the stream dropped (a phone slept, the Wi-Fi changed, earthd restarted): openStream / recheck are on it
      if (!unreachable) { text = "Reconnecting…"; cls = "warn"; }
      else { text = PHONE ? "Reconnecting… " + MSG_NO_SERVER : MSG_NO_SERVER; cls = "bad"; }
    }
    else if (state && !state.connected) { text = "Game not connected"; cls = "warn"; }
    s.textContent = text;
    s.className = cls;
    s.hidden = !text;
  }

  // ------------------------------------------------------------------------------------------ HTTP
  function apiUrl(path, params) {
    const u = new URL(path, location.origin);
    u.searchParams.set("t", TOKEN);
    if (params) for (const k in params) u.searchParams.set(k, params[k]);
    return u.toString();
  }

  // -> {status, data} ; status 0 = the server is not reachable
  async function getJSON(path, params) {
    let r;
    try { r = await fetch(apiUrl(path, params), { cache: "no-store" }); } catch (e) { return { status: 0, data: null }; }
    let data = null;
    try { data = await r.json(); } catch (e) { /* not JSON */ }
    return { status: r.status, data: data };
  }

  // -> {ok: true, data} | {ok: false, error}
  async function post(path, body) {
    let r;
    try {
      r = await fetch(path, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-BNE-Token": TOKEN },
        body: JSON.stringify(body),
      });
    } catch (e) { return { ok: false, error: MSG_NO_SERVER }; }
    let data = null;
    try { data = await r.json(); } catch (e) { /* not JSON */ }
    if (r.status === 409) return { ok: false, error: MSG_NO_GAME };
    if (r.status === 429) return { ok: false, error: MSG_BUSY };
    if (r.status === 403) { linkExpired(); return { ok: false, error: MSG_EXPIRED }; }
    if (!r.ok || !data || data.ok === false) {
      return { ok: false, error: data && data.error ? capital(data.error) : "Error " + r.status };
    }
    return { ok: true, data: data };
  }

  // the token is no longer accepted (earthd restarted; on a phone: a new code or sharing stopped): no more retries,
  // a phone would only run into the server's 429 for wrong tokens
  function linkExpired() {
    expired = true;
    stopStream();
    if (!PHONE) closeLanBox();
    showMessage(MSG_EXPIRED, true);
    setStatus();
  }

  async function cmd(body, okText, buttons) {
    if (buttons) buttons.forEach((b) => { b.disabled = true; });
    const r = await post("/api/cmd", body);
    if (buttons) buttons.forEach((b) => { b.disabled = false; });
    if (r.ok) { if (okText) toast(okText); return true; }
    toast(r.error, true);
    return false;
  }

  // ------------------------------------------------------------------------------------------ top bar
  function renderBar() {
    const p = state && state.player;
    $("speed").textContent = p ? fmtSpeed(p.speed) : "-";
    $("unitsBtn").textContent = units === "imperial" ? "mph" : "km/h";

    const g = state && state.gps;
    const info = $("destInfo");
    info.textContent = "";
    if (g) {
      $("destName").textContent = g.name ? g.name : (num(g.lat) && num(g.lon) ? fmtCoord(g.lat, g.lon) : "Destination");
      $("destName").title = $("destName").textContent;
      info.append(el("b", null, fmtDist(g.remaining)), " · ", el("b", null, fmtDur(g.eta)));
      const at = fmtClock(g.eta);
      if (at) info.append(" · arrive " + at);
    } else {
      $("destName").textContent = "No destination";
      $("destName").title = "";
      info.textContent = (PHONE ? "Tap" : "Click") + " the map or search to set one";
    }

    const ad = $("autodriveBtn");
    const on = !!(g && g.autodrive);
    ad.disabled = !g;
    ad.textContent = on ? "Autodrive on" : "Autodrive off";
    ad.classList.toggle("on", on);
    ad.setAttribute("aria-pressed", String(on));
    $("clearBtn").disabled = !g;
  }

  function setFollow(on) {
    follow = on;
    const b = $("followBtn");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    if (view) view.follow(on);
    if (on) centreOnCar(false);
  }

  // soft: the animation's frames, which leave a map alone while it moves (a wheel zoom, a pinch: MapLibre would stop it)
  function centreOnCar(soft) {
    if (view && shown) view.centre(shown.lat, shown.lon, soft);
  }

  // ------------------------------------------------------------------------------------------ state
  function applyState(s) {
    if (!s || typeof s !== "object") return;
    state = s;
    renderBar();
    setStatus();
    onPlayer(s.player);
    renderDest();
    if (!PHONE) renderLanState();
  }

  function renderDest() {
    const g = state && state.gps;
    if (!g) {
      if (hadGps) { routePoints = []; drawRoute(); }    // no destination: no route either
      hadGps = false;
      if (view) view.setDest(null);
      return;
    }
    hadGps = true;
    if (!view || !num(g.lat) || !num(g.lon)) return;
    view.setDest({ lat: g.lat, lon: g.lon, title: g.name || "Destination" });
  }

  // ------------------------------------------------------------------------------------------ the car
  const CAR_SVG =
    '<svg viewBox="-20 -20 40 40" aria-hidden="true">' +
    '<path class="arrow" d="M0,-16 L11,13 L0,7 L-11,13 Z" fill="#3fa7ff" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/>' +
    '<circle class="dot" r="8" fill="#3fa7ff" stroke="#ffffff" stroke-width="2.5"/>' +
    "</svg>";
  const ARROW_PATH = "M0,-16 L11,13 L0,7 L-11,13 Z";

  function carElement() {
    const d = el("div", "car");
    d.innerHTML = CAR_SVG;        // a constant, no data
    return d;
  }
  function pinElement(cls, color) {
    const d = el("div", cls);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 30 40");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M15 1C7.3 1 1 7.3 1 15c0 10 14 24 14 24s14-14 14-24C29 7.3 22.7 1 15 1z");
    path.setAttribute("fill", color);
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "2");
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", "15"); dot.setAttribute("cy", "15"); dot.setAttribute("r", "5");
    dot.setAttribute("fill", "#ffffff");
    svg.append(path, dot);
    d.append(svg);
    return d;
  }

  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function onPlayer(p) {
    if (!p || !num(p.lat) || !num(p.lon)) {
      if (view) view.setCar(null);
      shown = null;
      return;
    }
    const heading = num(p.heading) ? p.heading : null;
    const now = performance.now();
    const gap = lastPoseAt ? now - lastPoseAt : 250;
    lastPoseAt = now;
    if (!shown) {
      shown = { lat: p.lat, lon: p.lon, heading: heading };
      if (view) {
        placeCar();
        if (follow && !menuOpen) {
          centreOnCar(false);
          if (view.getView().zoom < 10) view.setView({ lat: shown.lat, lon: shown.lon, zoom: FIRST_ZOOM });
        }
      }
      return;
    }
    if (shown.lat === p.lat && shown.lon === p.lon && shown.heading === heading && !animating) return;
    const jump = distM(shown, p) > JUMP_M;
    anim = {
      from: { lat: shown.lat, lon: shown.lon, heading: shown.heading },
      to: { lat: p.lat, lon: p.lon, heading: heading },
      start: now,
      dur: jump ? 0 : clamp(gap, 100, 1000),
    };
    if (!animating) { animating = true; requestAnimationFrame(frame); }
  }

  function frame(now) {
    if (!anim || !shown) { animating = false; return; }
    const k = anim.dur ? clamp((now - anim.start) / anim.dur, 0, 1) : 1;
    const f = anim.from, t = anim.to;
    shown.lat = f.lat + (t.lat - f.lat) * k;
    let dl = t.lon - f.lon;
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    shown.lon = f.lon + dl * k;
    if (t.heading == null) shown.heading = f.heading;
    else if (f.heading == null) shown.heading = t.heading;
    else {
      const dh = ((t.heading - f.heading + 540) % 360) - 180;     // the short way round
      shown.heading = (f.heading + dh * k + 360) % 360;
    }
    if (k >= 1) shown.heading = t.heading;
    if (shown.lon > 180) shown.lon -= 360; else if (shown.lon < -180) shown.lon += 360;
    if (view) {
      placeCar();
      if (follow && !menuOpen) centreOnCar(true);
    }
    if (k < 1) requestAnimationFrame(frame);
    else animating = false;
  }

  function placeCar() {
    if (view && shown) view.setCar(shown);
  }

  // ------------------------------------------------------------------------------------------ the route
  function onRoute(r) {
    if (!r || !Array.isArray(r.points)) return;
    if (r.version === routeVersion && r.points.length === routePoints.length) return;
    routeVersion = r.version;
    routePoints = r.points.filter((q) => Array.isArray(q) && num(q[0]) && num(q[1]));
    drawRoute();
  }

  function drawRoute() {
    $("routeCredit").hidden = !routePoints.length;
    if (view) view.setRoute(routePoints);
  }

  // every overlay onto a renderer that was just put up (the data lives here, not in the renderer)
  function drawOverlays() {
    if (!view) return;
    view.setCar(shown);
    renderDest();
    view.setRoute(routePoints);
    view.setSearchPin(searchPin);
  }

  // ------------------------------------------------------------------------------------------ the menu
  function closeMenu() {
    menuOpen = false;
    if (view) view.closeMenu();
    if (searchPin) { searchPin = null; if (view) view.setSearchPin(null); }
  }

  function openMenu(lat, lon, title, detail) {
    if (!view) return;
    lon = ((lon + 540) % 360) - 180;
    lat = clamp(lat, -90, 90);
    lat = Math.round(lat * 1e6) / 1e6;
    lon = Math.round(lon * 1e6) / 1e6;
    const root = el("div", "menu");
    if (title) root.append(el("div", "mt", title));
    if (detail) root.append(el("div", "mc", detail));
    root.append(el("div", "mc", fmtCoord(lat, lon)));
    const box = el("div", "mb");
    const bGps = el("button", "primary", "Set GPS here");
    const bTp = el("button", null, "Teleport here");
    const bNo = el("button", null, "Cancel");
    [bGps, bTp, bNo].forEach((b) => { b.type = "button"; });
    const all = [bGps, bTp];
    bGps.addEventListener("click", async () => {
      const body = { action: "gps", lat: lat, lon: lon };
      if (title) body.name = String(title).slice(0, 120);
      if (await cmd(body, "GPS destination set", all)) closeMenu();
    });
    bTp.addEventListener("click", async () => {
      if (await cmd({ action: "teleport", lat: lat, lon: lon }, "Teleporting", all)) closeMenu();
    });
    bNo.addEventListener("click", closeMenu);
    box.append(bGps, bTp, bNo);
    root.append(box);
    // above the search pin when there is one, else pointing at the clicked spot
    view.openMenu(lat, lon, root, !!searchPin);
    menuOpen = true;
  }

  // ------------------------------------------------------------------------------------------ search
  let searchTimer = 0, searchSeq = 0, results = [], activeIdx = -1;

  function hideResults() { $("results").hidden = true; activeIdx = -1; }

  function resultNote(text) {
    const ul = $("results");
    ul.textContent = "";
    ul.append(el("li", "note", text));
    ul.hidden = false;
    results = [];
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    resultNote("Searching…");
    const r = await getJSON("/api/search", { q: q });
    if (seq !== searchSeq) return;               // an older answer
    if (r.status === 0) { resultNote(MSG_NO_SERVER); return; }
    if (r.status === 403) { linkExpired(); resultNote("Link expired"); return; }
    if (r.status === 429) { resultNote(MSG_BUSY); return; }
    const d = r.data || {};
    const list = Array.isArray(d.results) ? d.results.filter((x) => x && num(x.lat) && num(x.lon)) : [];
    if (!list.length) {
      resultNote(d.error ? "Search failed: " + d.error : (r.status !== 200 ? "Search failed (" + r.status + ")" : "No results"));
      return;
    }
    results = list;
    activeIdx = -1;
    const ul = $("results");
    ul.textContent = "";
    list.forEach((x, i) => {
      const li = el("li");
      li.setAttribute("role", "option");
      li.append(el("span", "rn", x.name || fmtCoord(x.lat, x.lon)));
      if (x.detail) li.append(el("span", "rd", x.detail));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pickResult(i); });
      ul.append(li);
    });
    ul.hidden = false;
  }

  function markActive() {
    const items = $("results").children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle("active", i === activeIdx);
    if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: "nearest" });
  }

  function pickResult(i) {
    const x = results[i];
    if (!x) return;
    hideResults();
    $("search").blur();
    if (!view) { toast("The map is not loaded", true); return; }
    setFollow(false);
    if (view.getView().zoom < 14) view.setView({ lat: x.lat, lon: x.lon, zoom: 15 });
    else view.panTo(x.lat, x.lon);
    closeMenu();
    searchPin = { lat: x.lat, lon: x.lon, title: x.name || "" };
    view.setSearchPin(searchPin);
    openMenu(x.lat, x.lon, x.name || "Search result", x.detail || "");
  }

  function wireSearch() {
    const inp = $("search");
    inp.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = inp.value.trim().slice(0, 200);
      if (q.length < 3) { searchSeq++; hideResults(); return; }
      searchTimer = setTimeout(() => runSearch(q), 300);
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { hideResults(); return; }
      if ($("results").hidden || !results.length) return;
      if (e.key === "ArrowDown") { activeIdx = Math.min(results.length - 1, activeIdx + 1); markActive(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { activeIdx = Math.max(0, activeIdx - 1); markActive(); e.preventDefault(); }
      else if (e.key === "Enter") { pickResult(activeIdx < 0 ? 0 : activeIdx); e.preventDefault(); }
    });
    inp.addEventListener("focus", () => { if (results.length) $("results").hidden = false; });
    inp.addEventListener("blur", () => { setTimeout(hideResults, 150); });
  }

  // ------------------------------------------------------------------------------------------ key panel
  // Opened from the base map picker only ("Google Maps (your own key)…"), never by itself (phase 3).
  function setupKeyPanel(key) {
    keyStored = key;
    document.querySelectorAll(".keysite").forEach((c) => { c.textContent = SITE; });
    if (PHONE) {
      // the key is set on the PC (POST /api/key answers 403 here): no form, only what the phone's address needs
      $("keySteps").hidden = $("keyForm").hidden = $("keyStored").hidden = true;
      $("keyPhone").hidden = false;
      $("keyLead").textContent = key
        ? "The Google Maps key comes from the PC (it is set and changed on the PC's Live map page)."
        : "No Google Maps key is set. The key is set on the PC: paste it on the PC's Live map page, then reload this page to find Google Maps among the base maps.";
      return;
    }
    $("keyStored").hidden = !key;
    $("keyLead").textContent = key
      ? "Google Maps is among the base maps. Paste a new key to replace the stored one."
      : "The map works without a key. With your own Google Maps key, Google's map is one more base map: paste the key here.";
  }
  function showKeyPanel(on) {
    $("keyPanel").hidden = !on;
  }
  function keyError(text) {
    const e = $("keyError");
    e.textContent = text || "";
    e.hidden = !text;
  }
  function wireKeyPanel() {
    $("keyHide").addEventListener("click", () => showKeyPanel(false));
    $("keyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const k = $("keyInput").value.trim();
      if (!KEY_RE.test(k)) { keyError("That does not look like an API key (20-80 letters, digits, - or _)."); return; }
      keyError("");
      const r = await post("/api/key", { key: k });
      if (r.ok) { saveBaseChoice("google"); location.reload(); }      // a new key: show Google's map at once
      else keyError(r.error);
    });
    let armed = 0;
    $("keyRemove").addEventListener("click", async (e) => {
      const b = e.currentTarget;
      if (!armed) {                  // two clicks instead of confirm(): a modal dialog would freeze the live map
        b.textContent = "Click again to remove it";
        armed = setTimeout(() => { armed = 0; b.textContent = "Remove the key"; }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      const r = await post("/api/key", { key: "" });
      if (r.ok) location.reload();
      else keyError(r.error);
    });
  }

  // ------------------------------------------------------------------------------------------ base maps
  // streets / satellite / terrain are MapLibre styles (one renderer, setStyle between them); google is the other
  // renderer. Switching keeps the view (centre, zoom) and draws the overlays again; the click menu closes.
  function baseAvailable(id) {
    if (id === "streets") return true;
    if (id === "satellite" || id === "terrain") return !!(state && state.tiles);
    if (id === "google") return KEY_RE.test(keyStored);
    return false;
  }
  function loadBaseChoice() {
    try { return localStorage.getItem(BASE_KEY) || ""; } catch (e) { return ""; }
  }
  function saveBaseChoice(id) {
    try { localStorage.setItem(BASE_KEY, id); } catch (e) { /* private window: not remembered */ }
  }
  function firstBase() {
    const b = loadBaseChoice();
    if (BASES.indexOf(b) >= 0 && baseAvailable(b)) return b;
    return baseAvailable("google") ? "google" : "streets";      // a stored key: Google until the player picks another
  }

  function startView() {
    if (lastAt) return lastAt;
    return shown ? { lat: shown.lat, lon: shown.lon, zoom: FIRST_ZOOM } : { lat: 30, lon: 0, zoom: 3 };
  }
  function currentView() { return view ? view.getView() : startView(); }

  // the server's imagery credit (/api/attribution), asked once before the first raster base map
  // and its sources by area ([credit, w, s, e, n] or [credit]): only those the view shows are credited, as the in-game
  // map does (the whole line names every regional service the server knows: dozens)
  let tilesCredit = "", tilesAreas = [], creditAsk = null;
  function loadCredit() {
    if (!creditAsk) {
      creditAsk = getJSON("/api/attribution").then((r) => {
        if (r.status === 200 && r.data && typeof r.data.attribution === "string") {
          tilesCredit = r.data.attribution;
          tilesAreas = Array.isArray(r.data.areas) ? r.data.areas.filter((a) => Array.isArray(a) && typeof a[0] === "string") : [];
        } else creditAsk = null;    // asked again next time
      });
    }
    return creditAsk;
  }
  // the imagery credit for a view {west, south, east, north} (degrees; west > east across the antimeridian)
  function creditFor(b) {
    if (!tilesAreas.length) return tilesCredit;
    const meets = (w, e) => {
      if (b.east - b.west >= 360) return true;
      for (const k of [-360, 0, 360]) if (w + k <= b.east && e + k >= b.west) return true;
      return false;
    };
    const used = [];
    for (const a of tilesAreas) {
      if (used.includes(a[0])) continue;
      if (a.length >= 5 && !(a[2] <= b.north && a[4] >= b.south && meets(a[1], a[3]))) continue;
      used.push(a[0]);
    }
    return used.length ? "Map imagery: " + used.join("; ") : "";
  }

  const hooks = {
    click(lat, lon) {
      hideResults();
      if (searchPin) { searchPin = null; if (view) view.setSearchPin(null); }
      openMenu(lat, lon, null, null);
    },
    dragstart() { if (follow) setFollow(false); },
    menuClosed() { closeMenu(); },
    baseOk(id) {
      if (id === "streets") streetsDown = false;
      if (mapMsg) { $("message").hidden = true; mapMsg = false; }
    },
    baseFailed(id) {
      if (id !== base) return;
      if (id === "streets") {
        streetsDown = true;
        if (baseAvailable("satellite")) { toast(MSG_STREETS_DOWN, false, 10000); setBase("satellite"); }
        else mapMessage("No map can be shown: the street map is unavailable (offline?) and the world server has no map tiles to show instead.");
        return;
      }
      if (streetsDown) mapMessage("No map can be shown: the street map is unavailable (offline?) and the world server's map tiles do not load either.");
      else toast("The world server's " + BASE_NAMES[id].toLowerCase() + " map does not load", true);
    },
  };

  // show a base map (not remembered: pickBase remembers the player's own choices)
  async function setBase(id) {
    closeMenu();
    if (!baseAvailable(id)) id = "streets";
    const seq = ++baseSeq;
    base = id;
    renderPicker();
    if (id === "google") {
      let v = null;
      try { v = await googleView(currentView()); } catch (e) {
        console.warn("Google Maps", e);
        if (seq === baseSeq) googleFailed(e && e.message ? e.message : String(e));
        return;
      }
      if (seq !== baseSeq) { v.destroy(false); return; }        // another base map was picked meanwhile
      useView(v);
      return;
    }
    if (id !== "streets") await loadCredit();
    if (seq !== baseSeq) return;
    if (view && view.kind === "maplibre") { view.setBase(id); return; }
    if (libreBroken) { noLibre(null); return; }
    let v = null;
    try { v = libreView(id, currentView()); } catch (e) { console.error(e); noLibre(e); return; }
    useView(v);
  }

  function useView(v) {
    const at = currentView();
    if (view) view.destroy(false);
    view = v;
    v.setView(at);
    v.follow(follow);
    drawOverlays();
  }

  function pickBase(id) {
    if (id === "google" && googleBad) {
      keyError(MSG_KEY_REFUSED);
      showKeyPanel(true);
      return;
    }
    saveBaseChoice(id);
    if (id !== base || !view) setBase(id);
  }

  // MapLibre cannot run (no WebGL: an old phone, graphics acceleration off; its script missing): Google with a key
  function noLibre(e) {
    libreBroken = true;
    if (baseAvailable("google") && !googleBad) { setBase("google"); return; }
    mapMessage("This browser cannot show the map (" + (e && e.message ? e.message : "WebGL is not available") +
      "). Turn on graphics acceleration in the browser's settings, or use another browser.");
  }

  // the picker: the button names the base map, its list switches (on a phone too: plain buttons, no hover)
  function pickerOpen() { return !$("baseList").hidden; }
  function openPicker() {
    $("baseList").hidden = false;
    $("baseBtn").setAttribute("aria-expanded", "true");
    renderPicker();
  }
  function closePicker() {
    $("baseList").hidden = true;
    $("baseBtn").setAttribute("aria-expanded", "false");
  }
  function renderPicker() {
    $("baseBtn").textContent = BASE_NAMES[base] || "Map";
    const ul = $("baseList");
    if (ul.hidden) return;
    ul.textContent = "";
    const item = (b) => { const li = el("li"); li.setAttribute("role", "none"); li.append(b); ul.append(li); };
    BASES.filter(baseAvailable).forEach((id) => {
      const b = el("button", id === base ? "on" : null, BASE_NAMES[id]);
      b.type = "button";
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(id === base));
      b.addEventListener("click", () => { closePicker(); pickBase(id); });
      item(b);
    });
    const k = el("button", "keyitem", "Google Maps (your own key)…");
    k.type = "button";
    k.setAttribute("role", "menuitem");
    k.addEventListener("click", () => { closePicker(); showKeyPanel(true); });
    item(k);
  }
  function wirePicker() {
    $("baseBtn").addEventListener("click", () => { if (pickerOpen()) closePicker(); else openPicker(); });
    document.addEventListener("pointerdown", (e) => {
      if (pickerOpen() && !$("basePick").contains(e.target)) closePicker();
    });
  }

  // ------------------------------------------------------------------------------------------ renderers
  // Both renderers have the same methods; the page above does not care which map is underneath:
  //   kind, setCar({lat, lon, heading} | null), setDest({lat, lon, title} | null), setRoute([[lat, lon], ...]),
  //   setSearchPin({lat, lon, title} | null), openMenu(lat, lon, element, abovePin), closeMenu(),
  //   centre(lat, lon, soft), panTo(lat, lon), getView() -> {lat, lon, zoom}, setView({lat, lon, zoom}),
  //   follow(on), destroy(dead); MapLibre's also setBase(id).
  // They call the page back through `hooks`: click(lat, lon), dragstart(), menuClosed(), baseOk(id), baseFailed(id).

  // ---- MapLibre (phase 3, the default). Its zoom is one less than Google's for the same scale (512 px tiles).
  const ROUTE_SRC = "bne-route";

  // MapLibre's attribution control inserts its strings as HTML: the server's text goes in escaped
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function tileUrl(layer) {
    return location.origin + "/api/tiles/" + layer + "/{z}/{x}/{y}?t=" + encodeURIComponent(TOKEN);
  }
  function libreStyle(id) {
    if (id === "streets") return STREETS_STYLE;
    const raster = (layer, credit) => ({ type: "raster", tiles: [tileUrl(layer)], tileSize: 256, maxzoom: TILE_MAX_Z,
      attribution: credit ? esc(credit) : "" });
    return {
      version: 8,
      sources: {
        "bne-base": id === "terrain" ? raster("map", "Terrain Light by " + EOX_CREDIT) : raster("sat", ""),     // (credited by the view: tileCredit)
        "bne-labels": raster("labels", "Overlay by " + EOX_CREDIT),
      },
      layers: [
        { id: "bne-bg", type: "background", paint: { "background-color": "#0d1014" } },
        { id: "bne-base", type: "raster", source: "bne-base" },
        { id: "bne-labels", type: "raster", source: "bne-labels" },
      ],
    };
  }

  function libreView(baseId, at) {
    if (typeof maplibregl === "undefined") throw new Error("the map library did not load");
    const box = el("div", "mapview");
    $("map").append(box);
    let map;
    try {
      map = new maplibregl.Map({
        container: box,
        style: libreStyle(baseId),
        center: [at.lon, at.lat],
        zoom: Math.max(0, at.zoom - 1),
        // north up: a turn by two fingers would fight the panning on a phone (and the car's arrow is compass-true)
        dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
        cooperativeGestures: false,
        attributionControl: false,      // (added compact below: the expanded one would sit under the imagery credit)
      });
    } catch (e) { box.remove(); throw e; }
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // (a compact one still starts open: closed once the map is up; its (i) opens it)
    map.once("load", () => {
      const a = box.querySelector(".maplibregl-ctrl-attrib");
      if (a) { a.classList.remove("maplibregl-compact-show"); a.removeAttribute("open"); }
    });
    // the satellite map's imagery credit, for what the view shows (two lines; a click shows it whole)
    let curBase = baseId;
    const credit = el("div", "tilecredit");
    credit.addEventListener("click", () => credit.classList.toggle("full"));
    box.append(credit);
    function tileCredit() {
      const t = curBase === "satellite" ? creditFor({ west: map.getBounds().getWest(), south: map.getBounds().getSouth(),
        east: map.getBounds().getEast(), north: map.getBounds().getNorth() }) : "";
      credit.textContent = t;
      credit.hidden = !t;
    }
    map.on("moveend", tileCredit);
    tileCredit();

    let car = null, dest = null, pin = null, popup = null;
    let route = [];
    let watch = null;             // the base map being checked: {id, loaded, errors, timer}

    // -- the route: a GeoJSON line with a casing; setStyle drops it, so it is added again after every style load
    function routeData() {
      const coords = [];
      let prev = null;
      for (const q of route) {
        let lon = q[1];
        // unwrapped longitudes: a route over the antimeridian is drawn the short way
        if (prev != null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
        coords.push([lon, q[0]]);
        prev = lon;
      }
      return { type: "FeatureCollection", features: coords.length < 2 ? [] :
        [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] };
    }
    function addRoute() {
      if (map.getSource(ROUTE_SRC)) return;
      map.addSource(ROUTE_SRC, { type: "geojson", data: routeData() });
      // under the labels (the street map's names, the raster labels), over everything else: the first symbol layer
      // after the last 3D building layer (liberty's one-way arrows come before its bridges and buildings)
      const order = map.getLayersOrder();
      let from = 0;
      order.forEach((id, i) => { if (map.getLayer(id).type === "fill-extrusion") from = i + 1; });
      const before = order.slice(from).find((id) => id === "bne-labels" || map.getLayer(id).type === "symbol");
      const line = { "line-join": "round", "line-cap": "round" };
      map.addLayer({ id: ROUTE_SRC + "-casing", type: "line", source: ROUTE_SRC, layout: line,
        paint: { "line-color": "#0b3558", "line-opacity": 0.9, "line-width": 9 } }, before);
      map.addLayer({ id: ROUTE_SRC + "-line", type: "line", source: ROUTE_SRC, layout: line,
        paint: { "line-color": "#3fa7ff", "line-width": 5 } }, before);
    }

    // -- the base map check: the style must load and its tiles must not all fail in the first seconds (offline,
    // OpenFreeMap down). A missing tile (404) is not an error to MapLibre: the world server's empty spots are fine.
    function isBaseSource(src) { return !!src && src !== ROUTE_SRC && src !== "bne-labels"; }
    function watchBase(id) {
      if (watch) clearTimeout(watch.timer);
      const w = watch = { id: id, loaded: false, errors: 0, timer: 0 };
      w.timer = setTimeout(() => { if (watch === w && (!w.loaded || w.errors)) baseDone(w, false); }, BASE_GRACE_MS);
    }
    function baseDone(w, ok) {
      if (watch !== w) return;
      clearTimeout(w.timer);
      watch = null;
      if (ok) hooks.baseOk(w.id); else hooks.baseFailed(w.id);
    }
    map.on("style.load", () => {
      addRoute();
      if (watch) watch.loaded = true;
    });
    map.on("data", (e) => {
      const w = watch;
      if (w && w.loaded && e.dataType === "source" && e.tile && isBaseSource(e.sourceId)) baseDone(w, true);
    });
    map.on("error", (e) => {
      const err = e && e.error;
      console.warn("map:", err && err.message ? err.message : err);
      const w = watch;
      if (!w) return;
      if (!e.sourceId) { if (!w.loaded) baseDone(w, false); return; }        // the style itself did not load
      // (only the current style's sources: a late error of the previous one does not count)
      if (w.loaded && isBaseSource(e.sourceId) && map.getSource(e.sourceId) && ++w.errors >= 3) baseDone(w, false);
    });
    watchBase(baseId);

    // the street map's style names a few icons its sprite lacks: an empty image instead of a console warning each
    map.on("styleimagemissing", (e) => {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    let pressed = 0;              // pointers down on the map (a mouse button, fingers)
    const release = () => { pressed = 0; };
    box.addEventListener("pointerdown", () => { pressed++; }, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    map.on("dragstart", () => hooks.dragstart());
    map.on("click", (e) => {
      const t = e.originalEvent && e.originalEvent.target;
      if (t && t.closest && t.closest(".maplibregl-popup")) return;          // a click inside the menu
      const ll = e.lngLat.wrap();
      hooks.click(ll.lat, ll.lng);
    });

    function setPin(m, p, cls, color) {
      if (!p) { if (m) m.remove(); return null; }
      if (!m) m = new maplibregl.Marker({ element: pinElement(cls, color), anchor: "bottom" }).setLngLat([p.lon, p.lat]).addTo(map);
      else m.setLngLat([p.lon, p.lat]);
      m.getElement().title = p.title || "";
      return m;
    }

    return {
      kind: "maplibre",
      setBase(id) {
        watchBase(id);
        curBase = id;
        map.setStyle(libreStyle(id), { diff: false });
        tileCredit();
      },
      setCar(c) {
        if (!c) { if (car) { car.remove(); car = null; } return; }
        if (!car) {
          const e = carElement();
          e.title = "Your car";
          car = new maplibregl.Marker({ element: e, rotationAlignment: "map", pitchAlignment: "map" })
            .setLngLat([c.lon, c.lat]).addTo(map);
        } else car.setLngLat([c.lon, c.lat]);
        car.getElement().classList.toggle("noheading", c.heading == null);
        if (c.heading != null) car.setRotation(c.heading);
      },
      setDest(d) { dest = setPin(dest, d, "dest-pin", "#ff5d5d"); },
      setSearchPin(p) { pin = setPin(pin, p, "search-pin", "#f0b429"); },
      setRoute(points) {
        route = points;
        const s = map.getSource(ROUTE_SRC);
        if (s) s.setData(routeData());          // else the next style load adds it
      },
      openMenu(lat, lon, content, abovePin) {
        this.closeMenu();
        const p = popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false,
          maxWidth: "300px", offset: abovePin ? 32 : 6, className: "bne-popup" });
        p.setLngLat([lon, lat]).setDOMContent(content).addTo(map);
        p.on("close", () => { if (popup === p) { popup = null; hooks.menuClosed(); } });
      },
      closeMenu() {
        const p = popup;
        popup = null;               // closed from here: no menuClosed back
        if (p) p.remove();
      },
      // jumpTo stops every gesture in progress, even one not started yet (a button held before the drag threshold):
      // the frames' soft calls wait while a pointer is down, the map moves or a wheel zoom is pending
      centre(lat, lon, soft) {
        if (soft && (pressed || map.isMoving() || map.scrollZoom.isActive())) return;
        map.jumpTo({ center: [lon, lat] });
      },
      panTo(lat, lon) { map.panTo([lon, lat]); },
      getView() {
        const c = map.getCenter().wrap();
        return { lat: c.lat, lon: c.lng, zoom: map.getZoom() + 1 };
      },
      setView(v) { map.jumpTo({ center: [v.lon, v.lat], zoom: Math.max(0, v.zoom - 1) }); },
      // following: zoom about the middle (where the car is), not about the pointer
      follow(on) {
        const o = on ? { around: "center" } : undefined;
        map.scrollZoom.disable(); map.scrollZoom.enable(o);
        map.touchZoomRotate.disable(); map.touchZoomRotate.enable(o);
      },
      destroy() {
        if (watch) clearTimeout(watch.timer);
        watch = null;
        lastAt = this.getView();
        popup = null;
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
        map.remove();
        box.remove();
      },
    };
  }

  // ---- Google Maps (phases 1 and 2), only with the player's own key; the script is loaded on first use
  let googleLoad = null;          // the script's promise (loaded once per page)
  let googleBad = false;          // Google refused the key (gm_authFailure): not tried again until a reload

  function loadGoogle(key) {
    if (googleLoad) return googleLoad;
    googleLoad = new Promise((resolve, reject) => {
      window.gm_authFailure = googleRefused;
      window.__bneMapsReady = () => resolve();
      const p = new URLSearchParams();
      p.set("key", key);
      p.set("callback", "__bneMapsReady");
      p.set("loading", "async");
      p.set("v", "weekly");
      p.set("libraries", "marker");
      const s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?" + p.toString();
      s.async = true;
      s.onerror = () => {
        googleLoad = null;          // nothing loaded: the next try adds the script again
        s.remove();
        reject(new Error("Could not load Google Maps. Is the computer online? (An ad or script blocker can also stop it.)"));
      };
      document.head.append(s);
      setTimeout(() => reject(new Error("Google Maps did not load (timed out). Reload the page to try again.")), 30000);
    });
    return googleLoad;
  }

  function googleRefused() {
    googleBad = true;
    // Google tears its map down: touching it again (setCenter, marker positions) throws inside its code
    if (view && view.kind === "google") { const v = view; view = null; v.destroy(true); }
    if (base === "google") googleFailed(MSG_KEY_REFUSED);
  }

  // Google did not start or refused the key: the reason in the key panel, and the street map instead
  function googleFailed(text) {
    keyError(text);
    showKeyPanel(true);
    if (libreBroken) { mapMessage(text); return; }
    toast("Google Maps is not available: showing the street map", true);
    setBase("streets");
  }

  async function googleView(at) {
    await loadGoogle(keyStored);
    const core = await google.maps.importLibrary("core");
    const mapsLib = await google.maps.importLibrary("maps");
    let markerLib = null;
    try { markerLib = await google.maps.importLibrary("marker"); } catch (e) { console.warn("marker library", e); }
    if (googleBad) throw new Error(MSG_KEY_REFUSED);
    // ?classic=1 forces the fallback (classic markers, no map ID) for testing
    const useAdvanced = !!(markerLib && markerLib.AdvancedMarkerElement) && !new URLSearchParams(location.search).has("classic");
    const box = el("div", "mapview");
    $("map").append(box);
    const opts = {
      center: { lat: at.lat, lng: at.lon },
      zoom: at.zoom,
      gestureHandling: "greedy",
      clickableIcons: false,          // Google's own places stay out of it: a click is always "here"
      streetViewControl: false,
      mapTypeControl: true,
      // the top left corner holds the page's base map picker
      mapTypeControlOptions: { position: core.ControlPosition.TOP_RIGHT },
      fullscreenControl: true,
      colorScheme: "DARK",
    };
    if (useAdvanced) opts.mapId = "DEMO_MAP_ID";      // AdvancedMarkerElement needs a map ID
    const map = new mapsLib.Map(box, opts);
    const infoWin = new mapsLib.InfoWindow({ headerDisabled: true });
    let car = null, carHeading = null, dest = null, pin = null, routeLine = null, routeCasing = null;
    let lastIconHeading = NaN, last = at;

    function classicPin(color, scale) {
      return {
        path: "M0,0 C-2,-14 -14,-16 -14,-26 A14,14 0 1,1 14,-26 C14,-16 2,-14 0,0 Z",
        fillColor: color, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2, scale: scale / 1.6,
        anchor: new google.maps.Point(0, 0),
      };
    }
    function carIcon(heading) {
      if (!num(heading)) {
        return { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: "#3fa7ff", fillOpacity: 1,
          strokeColor: "#ffffff", strokeWeight: 2.5 };
      }
      return { path: ARROW_PATH, rotation: heading, fillColor: "#3fa7ff", fillOpacity: 1, strokeColor: "#ffffff",
        strokeWeight: 2.2, scale: 1.1, anchor: new google.maps.Point(0, 0) };
    }

    // one wrapper over both marker kinds: set(pos), setTitle(t), remove()
    function makeMarker(pos, content, classicIcon, z) {
      if (useAdvanced) {
        const m = new google.maps.marker.AdvancedMarkerElement({ map: map, position: pos, content: content, zIndex: z });
        return {
          el: content,
          set(p) { m.position = p; },
          setTitle(t) { m.title = t; },
          remove() { m.map = null; },
        };
      }
      const m = new google.maps.Marker({ map: map, position: pos, icon: classicIcon, zIndex: z, clickable: false });
      return {
        m: m,
        set(p) { m.setPosition(p); },
        setTitle(t) { m.setTitle(t); },
        remove() { m.setMap(null); },
      };
    }
    function setPin(m, p, cls, color, scale, z) {
      if (!p) { if (m) m.remove(); return null; }
      const pos = { lat: p.lat, lng: p.lon };
      if (m) m.set(pos);
      else m = makeMarker(pos, pinElement(cls, color), classicPin(color, scale), z);
      m.setTitle(p.title || "");
      return m;
    }

    function rotateCar() {
      if (!car) return;
      const h = carHeading;
      if (useAdvanced) {
        car.el.classList.toggle("noheading", h == null);
        // the arrow is in screen space: subtract the map's own rotation (vector maps can be rotated)
        if (h != null) car.el.firstChild.style.transform = "rotate(" + (h - (map.getHeading() || 0)).toFixed(1) + "deg)";
      } else {
        // setIcon is not free: only when the heading changed visibly
        const hv = h == null ? -1 : Math.round(h);
        if (hv !== lastIconHeading) { lastIconHeading = hv; car.m.setIcon(carIcon(h)); }
      }
    }

    infoWin.addListener("closeclick", () => hooks.menuClosed());
    map.addListener("dragstart", () => hooks.dragstart());
    map.addListener("click", (e) => {
      if (e.placeId && e.stop) e.stop();
      if (!e.latLng) return;
      hooks.click(e.latLng.lat(), e.latLng.lng());
    });
    map.addListener("heading_changed", rotateCar);

    return {
      kind: "google",
      setCar(c) {
        if (!c) { if (car) { car.remove(); car = null; } return; }
        carHeading = c.heading;
        const pos = { lat: c.lat, lng: c.lon };
        if (!car) {
          car = makeMarker(pos, carElement(), carIcon(c.heading), 1000);
          car.setTitle("Your car");
          lastIconHeading = NaN;
        } else car.set(pos);
        rotateCar();
      },
      setDest(d) { dest = setPin(dest, d, "dest-pin", "#ff5d5d", 1.6, 900); },
      setSearchPin(p) { pin = setPin(pin, p, "search-pin", "#f0b429", 1.1, 800); },
      setRoute(points) {
        if (!points.length) {
          if (routeLine) routeLine.setMap(null);
          if (routeCasing) routeCasing.setMap(null);
          return;
        }
        const path = points.map((q) => ({ lat: q[0], lng: q[1] }));
        if (!routeLine) {
          routeCasing = new google.maps.Polyline({ map: map, path: path, strokeColor: "#0b3558", strokeOpacity: 0.9,
            strokeWeight: 9, clickable: false, zIndex: 4 });
          routeLine = new google.maps.Polyline({ map: map, path: path, strokeColor: "#3fa7ff", strokeOpacity: 1,
            strokeWeight: 5, clickable: false, zIndex: 5 });
        } else {
          routeCasing.setPath(path); routeCasing.setMap(map);
          routeLine.setPath(path); routeLine.setMap(map);
        }
      },
      openMenu(lat, lon, content, abovePin) {
        infoWin.setContent(content);
        infoWin.setOptions({ pixelOffset: new google.maps.Size(0, abovePin ? -30 : 0) });
        infoWin.setPosition({ lat: lat, lng: lon });
        infoWin.open({ map: map });
      },
      closeMenu() { infoWin.close(); },
      centre(lat, lon) { map.setCenter({ lat: lat, lng: lon }); },
      panTo(lat, lon) { map.panTo({ lat: lat, lng: lon }); },
      getView() {
        try {
          const c = map.getCenter();
          if (c) last = { lat: c.lat(), lon: c.lng(), zoom: map.getZoom() };
        } catch (e) { /* torn down by Google */ }
        return last;
      },
      setView(v) { map.setCenter({ lat: v.lat, lng: v.lon }); map.setZoom(Math.round(v.zoom)); },
      follow() { /* a setCenter does not stop Google's own zooming */ },
      // dead: Google tore the map down (a refused key), nothing of it may be touched
      destroy(dead) {
        lastAt = this.getView();
        if (!dead) {
          try {
            [car, dest, pin].forEach((m) => { if (m) m.remove(); });
            if (routeLine) routeLine.setMap(null);
            if (routeCasing) routeCasing.setMap(null);
            infoWin.close();
            google.maps.event.clearInstanceListeners(map);
          } catch (e) { console.warn("Google Maps", e); }
        }
        box.remove();
      },
    };
  }

  // ------------------------------------------------------------------------------------------ the stream
  let es = null;                  // the EventSource (null until the first state arrived)
  let streamSeq = 0;              // bumped by every open / stop: late events and checks of an older stream are dropped
  let retryTimer = 0;
  function openStream() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    if (expired) return;
    if (es) es.close();
    const seq = ++streamSeq;
    const s = es = new EventSource(apiUrl("/api/events"));
    triedStream = true;
    s.onopen = () => {
      if (seq !== streamSeq) return;
      streamUp = true;
      unreachable = false;
      clearTimeout(retryTimer);
      retryTimer = 0;
      setStatus();
    };
    s.addEventListener("state", (e) => {
      if (seq !== streamSeq) return;
      streamUp = true;
      let st = null;
      try { st = JSON.parse(e.data); } catch (err) { return; }
      applyState(st);
    });
    s.addEventListener("route", (e) => {
      if (seq !== streamSeq) return;
      let r = null;
      try { r = JSON.parse(e.data); } catch (err) { return; }
      onRoute(r);
    });
    s.onerror = () => {
      if (seq !== streamSeq) return;
      streamUp = false;
      setStatus();
      // A network error: the browser reconnects by itself (readyState CONNECTING). An HTTP error (403 when the link
      // expired, 503 with too many pages open) closes the stream for good. EventSource sees no status codes, so
      // /api/state is asked either way: it tells an expired link (403) from a PC out of reach (no answer).
      if (s.readyState === EventSource.CLOSED) s.close();
      if (!retryTimer) retryLater(RETRY_MS);
    };
  }

  function stopStream() {
    streamSeq++;
    clearTimeout(retryTimer);
    retryTimer = 0;
    if (es) es.close();
    streamUp = false;
  }

  function retryLater(ms) {
    clearTimeout(retryTimer);
    const seq = streamSeq;
    retryTimer = setTimeout(() => recheck(seq), ms);
  }

  async function recheck(seq) {
    retryTimer = 0;
    const r = await getJSON("/api/state");
    if (seq !== streamSeq || expired || streamUp) return;     // reopened meanwhile, given up, or back by itself
    unreachable = r.status === 0;
    if (r.status === 403) { linkExpired(); return; }
    if (r.status === 200 && r.data) { applyState(r.data); openStream(); return; }
    setStatus();
    retryLater(r.status === 429 ? BUSY_MS : r.status === 503 ? 2 * RETRY_MS : RETRY_MS);
  }

  // A phone sleeps, changes Wi-Fi, freezes the tab: the stream is let go while hidden (the PC's count of phones stays
  // true and none of the server's 8 streams is held by a pocket) and reopened at once when the page is seen again,
  // without waiting for the browser's own retry.
  function wireLifecycle() {
    document.addEventListener("visibilitychange", () => {
      if (!es || expired) return;
      if (document.visibilityState === "hidden") { if (PHONE) stopStream(); return; }
      if (PHONE || !streamUp) openStream();
    });
    window.addEventListener("online", () => { if (es && !expired) openStream(); });
    window.addEventListener("pageshow", (e) => { if (e.persisted && es && !expired) openStream(); });
  }

  // ------------------------------------------------------------------------------------------ the phone box (PC only)
  // The Phone button: sharing over the local network turned on (POST /api/lan) and the phone URL as a QR code.
  // Close only hides the box (the phones keep their map); Stop sharing turns it off; New code = off and on again.
  let lan = null;                 // the last /api/lan answer: {on, url, ip, phones, error}
  let lanBusy = "";               // the text shown while a POST /api/lan runs
  let lanFetching = false;
  let lanTimer = 0;
  let qrUrl = "";                 // the URL the QR code was drawn for
  let qrLib = null;               // the import("./qrcode.js") promise

  function lanOpen() { return !$("lanBox").hidden; }

  function phonesText(n) {
    n = num(n) ? n : 0;
    return n === 0 ? "No phone connected yet" : n === 1 ? "1 phone connected" : n + " phones connected";
  }

  // state.lan ({on, phones}, live): the button, the box's count, and a change made elsewhere (the game's Phone dialog)
  function renderLanState() {
    const s = state && state.lan;
    const on = !!(s && s.on);
    const b = $("phoneBtn");
    b.classList.toggle("on", on);
    b.textContent = on && num(s.phones) && s.phones > 0 ? "Phone · " + s.phones : "Phone";
    b.title = on ? "Sharing to phones is on: show the QR code" : "Open this map on your phone (a QR code)";
    if (!lanOpen()) return;
    renderLanInfo();
    if (s && lan && !lanBusy && on !== !!lan.on) refreshLan();
  }

  function renderLanInfo() {
    const s = state && state.lan;
    let text = lanBusy;
    if (!text && lan && lan.on) text = phonesText(s && num(s.phones) ? s.phones : lan.phones);
    else if (!text && lan && !lan.error) text = "Sharing is off";
    $("lanInfo").textContent = text;
  }

  function lanError(text) {
    const e = $("lanError");
    e.textContent = text || "";
    e.hidden = !text;
  }

  function renderLan(d) {
    lan = d && typeof d === "object" ? d : null;
    const on = !!(lan && lan.on && typeof lan.url === "string" && lan.url);
    lanError(on || !lan || !lan.error ? "" : "Could not share to phones: " + capital(lan.error));
    $("lanUrl").textContent = on ? lan.url : "";
    $("lanUrl").hidden = !on;
    if (!on) { qrUrl = ""; $("lanQr").textContent = ""; $("lanQr").hidden = true; }
    else if (lan.url !== qrUrl) drawQr(lan.url);
    $("lanRenew").textContent = on ? "New code" : "Turn on";
    $("lanRenew").disabled = false;
    $("lanStop").disabled = !on;
    // the phone's address differs from the PC's: a Google key's website restriction must allow it too
    let site = "";
    if (on) { try { site = "http://" + new URL(lan.url).host + "/*"; } catch (e) { /* not a URL: no hint */ } }
    $("lanSite").textContent = site;
    $("lanKeyHint").hidden = !site || !keyStored;
    renderLanInfo();
  }

  async function drawQr(url) {
    qrUrl = url;
    let lib = null;
    try {
      if (!qrLib) qrLib = import("./qrcode.js");      // the mod's encoder, served by the server as an ES module
      lib = await qrLib;
    } catch (e) {
      console.warn("qrcode.js", e);
      qrLib = null;
    }
    if (qrUrl !== url) return;                          // a newer code meanwhile
    const box = $("lanQr");
    box.textContent = "";
    box.hidden = false;
    const code = lib ? lib.encode(url, "M") : null;
    if (!code) {
      if (!lib) qrUrl = "";                             // drawn again on the next answer
      box.append(el("div", "error", lib
        ? "The address is too long for a QR code: type it into the phone's browser."
        : "The QR code could not be drawn: type the address below into the phone's browser."));
      return;
    }
    const border = 4;                                   // the quiet zone, in modules (the standard's 4)
    const n = code.size + 2 * border;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + n + " " + n);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR code of the phone link");
    const bg = document.createElementNS(ns, "rect");
    bg.setAttribute("width", String(n));
    bg.setAttribute("height", String(n));
    bg.setAttribute("fill", "#ffffff");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", lib.svgPath(code, border));
    path.setAttribute("fill", "#000000");
    svg.append(bg, path);
    box.append(svg);
  }

  // -> the answer, or null (the error is shown)
  async function lanPost(body, busyText) {
    lanBusy = busyText;
    $("lanRenew").disabled = $("lanStop").disabled = true;
    lanError("");
    renderLanInfo();
    const r = await post("/api/lan", body);
    lanBusy = "";
    if (!r.ok) {
      $("lanRenew").disabled = false;
      $("lanStop").disabled = !(lan && lan.on);
      lanError(r.error);
      renderLanInfo();
      return null;
    }
    renderLan(r.data);
    return r.data;
  }

  async function refreshLan() {
    if (lanFetching || lanBusy || expired) return;
    lanFetching = true;
    const r = await getJSON("/api/lan");
    lanFetching = false;
    if (r.status === 403) { linkExpired(); return; }
    if (r.status === 200 && r.data && lanOpen() && !lanBusy) renderLan(r.data);
  }

  function openLanBox() {
    $("lanBox").hidden = false;
    $("lanClose").focus();
    clearInterval(lanTimer);
    lanTimer = setInterval(refreshLan, LAN_POLL_MS);
    lanPost({ on: true }, "Turning on…");             // idempotent while on
  }

  function closeLanBox() {
    $("lanBox").hidden = true;
    clearInterval(lanTimer);
    lanTimer = 0;
  }

  function wireLanBox() {
    $("phoneBtn").hidden = false;
    $("phoneBtn").addEventListener("click", () => { if (lanOpen()) closeLanBox(); else openLanBox(); });
    $("lanClose").addEventListener("click", closeLanBox);
    $("lanRenew").addEventListener("click", async () => {
      const wasOn = !!(lan && lan.on);
      const d = await lanPost(wasOn ? { renew: true } : { on: true }, wasOn ? "Making a new code…" : "Turning on…");
      if (d && d.on && wasOn) toast("New code: the old one no longer works");
    });
    $("lanStop").addEventListener("click", async () => {
      const d = await lanPost({ on: false }, "Stopping…");
      if (d && !d.on) { closeLanBox(); toast("Sharing to phones stopped"); }
    });
  }

  // ------------------------------------------------------------------------------------------ start
  // a phone: the touch layout (style.css, html.phone) and the buttons below the map
  function setupPhone() {
    document.documentElement.classList.add("phone");
    // no page zoom: a pinch that starts on the bar would zoom the page, not the map (which zooms itself, greedy)
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover");
    $("main").after($("actions"));
  }

  function wireButtons() {
    $("unitsBtn").addEventListener("click", () => {
      units = units === "imperial" ? "metric" : "imperial";
      saveUnits();
      renderBar();
    });
    $("followBtn").addEventListener("click", () => setFollow(!follow));
    $("centreBtn").addEventListener("click", () => {
      setFollow(true);
      if (!shown) toast("The car's position is not known yet");
    });
    $("clearBtn").addEventListener("click", (e) => cmd({ action: "clear_gps" }, "GPS cleared", [e.currentTarget]));
    $("autodriveBtn").addEventListener("click", (e) => {
      const g = state && state.gps;
      if (!g) return;
      cmd({ action: "autodrive", on: !g.autodrive }, g.autodrive ? "Autodrive off" : "Autodrive on", [e.currentTarget]);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (pickerOpen()) { closePicker(); $("baseBtn").focus(); return; }   // the open list first,
      if (!PHONE && lanOpen()) { closeLanBox(); return; }                   // then the box, then the click menu
      closeMenu();
    });
  }

  async function firstState() {
    for (;;) {
      const r = await getJSON("/api/state");
      if (r.status === 403) { linkExpired(); return null; }
      if (r.status === 200 && r.data) return r.data;
      triedStream = true;          // shows "Reconnecting…" / "World server not reachable"
      unreachable = r.status === 0;
      setStatus();
      await new Promise((res) => setTimeout(res, r.status === 429 ? BUSY_MS : RETRY_MS));
    }
  }

  async function start() {
    if (PHONE) setupPhone();
    renderBar();
    if (!TOKEN) {
      showMessage(PHONE ? "Scan the QR code on the PC (world map > Phone) to open this page" : "Open this page from the game (world map > Live map)");
      document.querySelectorAll("button, input").forEach((b) => { b.disabled = true; });
      return;
    }
    wireButtons();
    wireSearch();
    wireKeyPanel();
    wirePicker();
    if (!PHONE) wireLanBox();
    wireLifecycle();
    const s = await firstState();
    if (!s) return;
    triedStream = false;
    unreachable = false;
    applyState(s);
    setupKeyPanel(typeof s.apiKey === "string" && KEY_RE.test(s.apiKey) ? s.apiKey : "");
    setBase(firstBase());
    openStream();
  }

  start();
})();

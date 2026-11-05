// BeamNG.Earth live map (phase 1 of the Google Maps integration; contract: docs/COMPANION.md).
// Plain JS, no build step. The only external script is Google's Maps JavaScript API, loaded with the player's own key.
// Everything that comes from the server or from Google is inserted as text (textContent), never as HTML.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TOKEN = new URLSearchParams(location.search).get("t") || "";
  const KEY_RE = /^[A-Za-z0-9_-]{20,80}$/;
  const UNITS_KEY = "bne.liveMap.units";
  const RETRY_MS = 3000;
  const JUMP_M = 2000;            // a move farther than this between two states is a teleport: no animation
  const FIRST_ZOOM = 16;
  const MSG_EXPIRED = "This link is no longer valid (the world server was restarted?). Open the Live map again from the game (world map > Live map).";
  const MSG_NO_GAME = "The game is not connected";
  const MSG_NO_SERVER = "World server not reachable";

  // ------------------------------------------------------------------------------------------ state
  let units = loadUnits();        // "metric" | "imperial"
  let state = null;               // the last state JSON
  let streamUp = false;           // the event stream is open
  let triedStream = false;
  let expired = false;
  let keyStored = "";

  let map = null;
  let useAdvanced = false;        // AdvancedMarkerElement (true) or the classic google.maps.Marker (fallback)
  let carMarker = null, destMarker = null, searchMarker = null, infoWin = null;
  let routeLine = null, routeCasing = null;
  let routeVersion = -1, routePoints = [];
  let hadGps = false;
  let follow = true;
  let menuOpen = false;           // the click menu holds the map still (follow mode would pan it away)

  let shown = null;               // the car as drawn: {lat, lon, heading}
  let anim = null;                // {from, to, start, dur}
  let animating = false;
  let lastPoseAt = 0;
  let lastIconHeading = NaN;

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
  function toast(text, bad) {
    const t = $("toast");
    t.textContent = text;
    t.className = bad ? "bad" : "";
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2500);
  }

  function showMessage(text, bad) {
    const m = $("message");
    m.textContent = text;
    m.className = "card" + (bad ? " bad" : "");
    m.hidden = false;
  }

  function setStatus() {
    const s = $("status");
    let text = "", cls = "";
    if (expired) { text = "Link expired"; cls = "bad"; }
    else if (triedStream && !streamUp) { text = MSG_NO_SERVER; cls = "bad"; }
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
    if (r.status === 403) { linkExpired(); return { ok: false, error: MSG_EXPIRED }; }
    if (!r.ok || !data || data.ok === false) {
      return { ok: false, error: data && data.error ? capital(data.error) : "Error " + r.status };
    }
    return { ok: true, data: data };
  }

  function linkExpired() {
    expired = true;
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
      info.textContent = "Click the map or search to set one";
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
    if (on) centreOnCar();
  }

  function centreOnCar() {
    if (map && shown) map.setCenter({ lat: shown.lat, lng: shown.lon });
  }

  // ------------------------------------------------------------------------------------------ state
  function applyState(s) {
    if (!s || typeof s !== "object") return;
    state = s;
    renderBar();
    setStatus();
    onPlayer(s.player);
    renderDest();
  }

  function renderDest() {
    const g = state && state.gps;
    if (!g) {
      if (hadGps) { routePoints = []; drawRoute(); }    // no destination: no route either
      hadGps = false;
      if (destMarker) { destMarker.remove(); destMarker = null; }
      return;
    }
    hadGps = true;
    if (!map || !num(g.lat) || !num(g.lon)) return;
    const pos = { lat: g.lat, lng: g.lon };
    if (destMarker) destMarker.set(pos);
    else destMarker = makeMarker(pos, pinElement("dest-pin", "#ff5d5d"), classicPin("#ff5d5d", 1.6), 900);
    destMarker.setTitle(g.name || "Destination");
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

  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function onPlayer(p) {
    if (!p || !num(p.lat) || !num(p.lon)) {
      if (carMarker) { carMarker.remove(); carMarker = null; }
      shown = null;
      return;
    }
    const heading = num(p.heading) ? p.heading : null;
    const now = performance.now();
    const gap = lastPoseAt ? now - lastPoseAt : 250;
    lastPoseAt = now;
    if (!shown) {
      shown = { lat: p.lat, lon: p.lon, heading: heading };
      if (map) {
        placeCar();
        if (follow && !menuOpen) {
          centreOnCar();
          if (map.getZoom() < 10) map.setZoom(FIRST_ZOOM);
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
    if (map) {
      placeCar();
      if (follow && !menuOpen) centreOnCar();
    }
    if (k < 1) requestAnimationFrame(frame);
    else animating = false;
  }

  function placeCar() {
    if (!map || !shown) return;
    const pos = { lat: shown.lat, lng: shown.lon };
    if (!carMarker) {
      carMarker = makeMarker(pos, carElement(), carIcon(shown.heading), 1000);
      carMarker.setTitle("Your car");
      lastIconHeading = NaN;
    } else carMarker.set(pos);
    rotateCar();
  }

  function rotateCar() {
    if (!carMarker || !shown) return;
    const h = shown.heading;
    if (useAdvanced) {
      carMarker.el.classList.toggle("noheading", h == null);
      // the arrow is in screen space: subtract the map's own rotation (vector maps can be rotated)
      if (h != null) carMarker.el.firstChild.style.transform = "rotate(" + (h - (map.getHeading() || 0)).toFixed(1) + "deg)";
    } else {
      // setIcon is not free: only when the heading changed visibly
      const hv = h == null ? -1 : Math.round(h);
      if (hv !== lastIconHeading) { lastIconHeading = hv; carMarker.m.setIcon(carIcon(h)); }
    }
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
    if (!map) return;
    if (!routePoints.length) {
      if (routeLine) routeLine.setMap(null);
      if (routeCasing) routeCasing.setMap(null);
      return;
    }
    const path = routePoints.map((q) => ({ lat: q[0], lng: q[1] }));
    if (!routeLine) {
      routeCasing = new google.maps.Polyline({ map: map, path: path, strokeColor: "#0b3558", strokeOpacity: 0.9,
        strokeWeight: 9, clickable: false, zIndex: 4 });
      routeLine = new google.maps.Polyline({ map: map, path: path, strokeColor: "#3fa7ff", strokeOpacity: 1,
        strokeWeight: 5, clickable: false, zIndex: 5 });
    } else {
      routeCasing.setPath(path); routeCasing.setMap(map);
      routeLine.setPath(path); routeLine.setMap(map);
    }
  }

  // ------------------------------------------------------------------------------------------ the menu
  function closeMenu() {
    menuOpen = false;
    if (infoWin) infoWin.close();
    if (searchMarker) { searchMarker.remove(); searchMarker = null; }
  }

  function openMenu(lat, lon, title, detail) {
    if (!map) return;
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
    infoWin.setContent(root);
    // above the search pin when there is one, else pointing at the clicked spot
    infoWin.setOptions({ pixelOffset: new google.maps.Size(0, searchMarker ? -30 : 0) });
    infoWin.setPosition({ lat: lat, lng: lon });
    infoWin.open({ map: map });
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
    if (!map) { toast("The map is not loaded", true); return; }
    setFollow(false);
    const pos = { lat: x.lat, lng: x.lon };
    map.panTo(pos);
    if (map.getZoom() < 14) map.setZoom(15);
    closeMenu();
    searchMarker = makeMarker(pos, pinElement("search-pin", "#f0b429"), classicPin("#f0b429", 1.1), 800);
    searchMarker.setTitle(x.name || "");
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
  function setupKeyPanel(key) {
    keyStored = key;
    $("keySite").textContent = location.origin + "/*";
    $("keyStored").hidden = !key;
    $("keyLead").textContent = key
      ? "Paste a new key to replace the stored one."
      : "Without a key Google shows a dimmed “for development purposes only” map, which is enough to try it. Paste your own key to get the full map.";
    showKeyPanel(!key);
  }
  function showKeyPanel(on) {
    $("keyPanel").hidden = !on;
    $("keyShow").hidden = on;
  }
  function keyError(text) {
    const e = $("keyError");
    e.textContent = text || "";
    e.hidden = !text;
  }
  function wireKeyPanel() {
    $("keyHide").addEventListener("click", () => showKeyPanel(false));
    $("keyShow").addEventListener("click", () => showKeyPanel(true));
    $("keyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const k = $("keyInput").value.trim();
      if (!KEY_RE.test(k)) { keyError("That does not look like an API key (20-80 letters, digits, - or _)."); return; }
      keyError("");
      const r = await post("/api/key", { key: k });
      if (r.ok) location.reload();
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

  // ------------------------------------------------------------------------------------------ Google Maps
  let mapsFailed = false;
  function mapFailed(text) {
    mapsFailed = true;
    showMessage(text, true);
  }

  function loadGoogle(key) {
    window.gm_authFailure = function () {
      // Google tears the map down: touching it again (setCenter, marker positions) throws inside its code
      map = null;
      carMarker = destMarker = searchMarker = infoWin = null;
      routeLine = routeCasing = null;
      mapFailed("Google did not accept the API key. In Google Cloud check that the key may use the Maps JavaScript API, " +
        "that billing is enabled, and that its website restriction allows " + location.origin + "/* . " +
        "Replace or remove the key below.");
      showKeyPanel(true);
    };
    window.__bneMapsReady = function () {
      initMap().catch((e) => {
        console.error(e);
        mapFailed("Google Maps failed to start: " + (e && e.message ? e.message : e));
      });
    };
    const p = new URLSearchParams();
    if (key) p.set("key", key);
    p.set("callback", "__bneMapsReady");
    p.set("loading", "async");
    p.set("v", "weekly");
    p.set("libraries", "marker");
    const s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?" + p.toString();
    s.async = true;
    s.onerror = () => mapFailed("Could not load Google Maps. Is the computer online? (An ad or script blocker can also stop it.)");
    document.head.append(s);
    setTimeout(() => {
      if (!map && !mapsFailed) mapFailed("Google Maps did not load (timed out). Reload the page to try again.");
    }, 30000);
  }

  async function initMap() {
    const mapsLib = await google.maps.importLibrary("maps");
    let markerLib = null;
    try { markerLib = await google.maps.importLibrary("marker"); } catch (e) { console.warn("marker library", e); }
    // ?classic=1 forces the fallback (classic markers, no map ID) for testing
    useAdvanced = !!(markerLib && markerLib.AdvancedMarkerElement) && !new URLSearchParams(location.search).has("classic");
    const p = state && state.player;
    const opts = {
      center: p && num(p.lat) ? { lat: p.lat, lng: p.lon } : { lat: 30, lng: 0 },
      zoom: p && num(p.lat) ? FIRST_ZOOM : 3,
      gestureHandling: "greedy",
      clickableIcons: false,          // Google's own places stay out of it: a click is always "here"
      streetViewControl: false,
      mapTypeControl: true,
      fullscreenControl: true,
      colorScheme: "DARK",
    };
    if (useAdvanced) opts.mapId = "DEMO_MAP_ID";      // AdvancedMarkerElement needs a map ID
    map = new mapsLib.Map($("map"), opts);
    infoWin = new mapsLib.InfoWindow({ headerDisabled: true });
    infoWin.addListener("closeclick", closeMenu);

    map.addListener("dragstart", () => { if (follow) setFollow(false); });
    map.addListener("click", (e) => {
      if (e.placeId && e.stop) e.stop();
      if (!e.latLng) return;
      hideResults();
      if (searchMarker) { searchMarker.remove(); searchMarker = null; }
      openMenu(e.latLng.lat(), e.latLng.lng(), null, null);
    });
    map.addListener("heading_changed", rotateCar);

    if (shown) placeCar();
    renderDest();
    drawRoute();
  }

  // ------------------------------------------------------------------------------------------ the stream
  let es = null;
  function openStream() {
    if (es) es.close();
    es = new EventSource(apiUrl("/api/events"));
    triedStream = true;
    es.onopen = () => { streamUp = true; setStatus(); };
    es.addEventListener("state", (e) => {
      streamUp = true;
      let s = null;
      try { s = JSON.parse(e.data); } catch (err) { return; }
      applyState(s);
    });
    es.addEventListener("route", (e) => {
      let r = null;
      try { r = JSON.parse(e.data); } catch (err) { return; }
      onRoute(r);
    });
    es.onerror = () => {
      streamUp = false;
      setStatus();
      // a network error: the browser reconnects by itself (readyState CONNECTING). An HTTP error (403 after an
      // earthd restart, 503 with too many pages open) closes the stream for good: find out why and reopen.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        setTimeout(recheck, RETRY_MS);
      }
    };
  }

  async function recheck() {
    const r = await getJSON("/api/state");
    if (r.status === 403) { linkExpired(); return; }
    if (r.status === 200 && r.data) { applyState(r.data); openStream(); return; }
    setStatus();
    setTimeout(recheck, r.status === 503 ? 2 * RETRY_MS : RETRY_MS);
  }

  // ------------------------------------------------------------------------------------------ start
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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  }

  async function firstState() {
    for (;;) {
      const r = await getJSON("/api/state");
      if (r.status === 403) { linkExpired(); return null; }
      if (r.status === 200 && r.data) return r.data;
      triedStream = true;          // shows "World server not reachable"
      setStatus();
      await new Promise((res) => setTimeout(res, RETRY_MS));
    }
  }

  async function start() {
    renderBar();
    if (!TOKEN) {
      showMessage("Open this page from the game (world map > Live map)");
      document.querySelectorAll("button, input").forEach((b) => { b.disabled = true; });
      return;
    }
    wireButtons();
    wireSearch();
    wireKeyPanel();
    const s = await firstState();
    if (!s) return;
    triedStream = false;
    applyState(s);
    setupKeyPanel(typeof s.apiKey === "string" ? s.apiKey : "");
    loadGoogle(KEY_RE.test(s.apiKey || "") ? s.apiKey : "");
    openStream();
  }

  start();
})();

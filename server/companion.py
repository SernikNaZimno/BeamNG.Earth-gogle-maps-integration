"""The live map in the browser (the fork's Google Maps integration, phase 1; the contract: docs/COMPANION.md).

A small HTTP endpoint on 127.0.0.1 (as maptiles.py's: asyncio.start_server, one request per connection, the request
parsed by hand, no new dependencies) serves a page (server/companion_web/) that shows the player's car on a Google map
in the player's own browser (a second monitor), with the GPS destination and the planned route, and sends the game
commands back (set / clear the destination, teleport, autodrive). earthd feeds it (update_pose, set_gps, set_route,
set_connected) and gives it send_cmd(dict) -> bool, which passes a command to the game's connection (remote_cmd).

HTTP (GET unless said; every answer Cache-Control: no-store, never any CORS header):
  /, /index.html, /app.js, /style.css   the page's files from web_dir (404 for anything else, or while missing)
  /api/state?t=                         the state (state()) as JSON
  /api/events?t=                        text/event-stream: "state" (at once, then on a change, at most 4 a second:
                                        changes in between are coalesced into the next one), "route" (at once when
                                        there is one, then on every new one), ": ping" every 15 s; 8 streams at most
  POST /api/cmd                         {"action": "gps" | "clear_gps" | "teleport" | "autodrive", ...} -> the game
  POST /api/key                         the player's Maps JavaScript API key, stored in <user dir>/google_maps_key.txt
  /api/search?t=&q=                     Photon's results (geocode.search, biased to the player)

Checks, in this order: the Host header must be 127.0.0.1:<port> or localhost:<port> (421 otherwise: a page on another
site that rebinds its name to 127.0.0.1 would send its own name), every /api/ request must carry the token (?t= on GET:
EventSource cannot set headers; the X-BNE-Token header on POST: a custom header no cross-site page can send without a
CORS preflight, which is never answered) (403), a POST body is 4 KB at most (413). The page's files need no token
(nothing secret in them); the token only lives in the page's URL (earthd opens it in the browser: open_companion).

Everything runs on earthd's event loop (the feeds are called from the connection's message dispatch, send_cmd writes
to the game's connection directly); only the search runs in an executor (it blocks on Photon).
"""
import asyncio
import json
import logging
import math
import os
import re
import secrets
import time
from urllib.parse import parse_qs, urlsplit

log = logging.getLogger("earthd.companion")

DEFAULT_PORT = 47616            # --companion-port (0 = off); the Google Cloud key's website restriction names it
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "companion_web")
KEY_FILE = "google_maps_key.txt"    # in the game's user folder (the player's own key: never in the repo or the log)
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}
MAX_REQUEST = 8192              # bytes of request head accepted
MAX_BODY = 4096                 # bytes of a POST body accepted (413 beyond)
READ_TIMEOUT_S = 10
MAX_STREAMS = 8                 # /api/events at once (503 beyond: a stuck tab reloaded in a loop cannot pile them up)
STATE_GAP_S = 0.25              # a stream's state events at most this often (the poses come ~10 a second)
PING_S = 15.0                   # a ": ping" comment when nothing else was sent for this long (proxies, dead peers)
HEADING_MIN_MS = 1.0            # slower than this the heading is the last one (a parked car's velocity is noise)
NAME_MAX = 120                  # a command's destination name, characters
Q_MIN, Q_MAX = 3, 200           # a search's query, characters
SEARCH_MAX = 20                 # results passed on
KEY_RE = re.compile(r"[A-Za-z0-9_-]{20,80}")
ACTIONS = ("gps", "clear_gps", "teleport", "autodrive")
REASONS = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
           409: "Conflict", 411: "Length Required", 413: "Payload Too Large", 421: "Misdirected Request",
           500: "Internal Server Error", 503: "Service Unavailable"}


class BadRequest(ValueError):
    """A request body or query that does not follow the contract (400, its text in "error")."""


class SearchError(Exception):
    """A search that failed with a text for the page (earthd's search callback: geocode.error_text)."""


# --- pure helpers (unit-tested without sockets) -----------------------------------------------------------------
def _finite(v):
    """v as a float when it is a finite JSON number (not a bool), else None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    v = float(v)
    return v if math.isfinite(v) else None


def heading_of(vx, vy, last=None, min_ms=HEADING_MIN_MS):
    """The compass heading (degrees, 0 = north, clockwise) of a velocity vx (east), vy (north) m/s while faster than
    min_ms, else last (a car standing still keeps the way it faced; None if it never moved)."""
    vx, vy = _finite(vx), _finite(vy)
    if vx is None or vy is None or math.hypot(vx, vy) <= min_ms:
        return last
    return math.degrees(math.atan2(vx, vy)) % 360.0


def check_host(host, port):
    """Is the Host header ours (127.0.0.1:<port> or localhost:<port>, any case)? A name of another site that resolves
    to 127.0.0.1 (DNS rebinding) is not."""
    if not isinstance(host, str) or port is None:
        return False
    return host.strip().lower() in (f"127.0.0.1:{port}", f"localhost:{port}")


def check_cmd(body):
    """A command from the page (its parsed JSON body) -> the remote_cmd fields (unknown ones dropped); BadRequest when
    it does not follow the contract (lat -90..90, lon -180..180, name a string up to NAME_MAX, on a bool)."""
    if not isinstance(body, dict):
        raise BadRequest("the body must be a JSON object")
    action = body.get("action")
    if action not in ACTIONS:
        raise BadRequest(f"action must be one of {', '.join(ACTIONS)}")
    out = {"action": action}
    if action in ("gps", "teleport"):
        lat, lon = _finite(body.get("lat")), _finite(body.get("lon"))
        if lat is None or not -90.0 <= lat <= 90.0:
            raise BadRequest("lat must be a number in -90..90")
        if lon is None or not -180.0 <= lon <= 180.0:
            raise BadRequest("lon must be a number in -180..180")
        out["lat"], out["lon"] = lat, lon
    if action == "gps" and body.get("name") is not None:
        name = body["name"]
        if not isinstance(name, str) or len(name) > NAME_MAX:
            raise BadRequest(f"name must be a string of at most {NAME_MAX} characters")
        if name:
            out["name"] = name
    if action == "autodrive":
        if not isinstance(body.get("on"), bool):
            raise BadRequest("on must be true or false")
        out["on"] = body["on"]
    return out


def check_key(body):
    """POST /api/key's body -> the key to store ("" to delete it); BadRequest for anything else."""
    if not isinstance(body, dict) or not isinstance(body.get("key"), str):
        raise BadRequest('the body must be {"key": "..."}')
    key = body["key"].strip()
    if key and not KEY_RE.fullmatch(key):
        raise BadRequest("not a Google Maps API key (20-80 letters, digits, _ or -)")
    return key


def gps_of(msg):
    """The state's "gps" from a gps_state message (or None): None without an active destination (or without its
    lat / lon); remaining / eta None when unknown, name "" and autodrive false when left out."""
    if not isinstance(msg, dict) or msg.get("active") is not True:
        return None
    lat, lon = _finite(msg.get("lat")), _finite(msg.get("lon"))
    if lat is None or lon is None:
        return None
    name = msg.get("name")
    rem, eta = _finite(msg.get("remaining")), _finite(msg.get("eta"))
    return {"lat": lat, "lon": lon, "name": name[:NAME_MAX] if isinstance(name, str) else "",
            "autodrive": msg.get("autodrive") is True,
            "remaining": rem if rem is None or rem >= 0 else None, "eta": eta if eta is None or eta >= 0 else None}


def route_of(points):
    """A route's points as [[lat, lon], ...] (6 decimals, ~0.1 m), anything that is not a point dropped."""
    out = []
    for p in points or ():
        try:
            lat, lon = _finite(p[0]), _finite(p[1])
        except (TypeError, IndexError, KeyError):
            continue
        if lat is not None and lon is not None:
            out.append([round(lat, 6), round(lon, 6)])
    return out


def sse(event, data):
    """One server-sent event: `event: <name>`, `data: <JSON on one line>`, a blank line."""
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode("utf-8")


def parse_head(head):
    """A request head (bytes up to the blank line) -> (method, target, {lower-case header: value}); ValueError for a
    head that is not HTTP."""
    lines = head.decode("latin-1").split("\r\n")
    method, target, version = lines[0].split(" ", 2)
    if not version.startswith("HTTP/") or not target.startswith("/"):
        raise ValueError("not an HTTP request")
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        k, sep, v = line.partition(":")
        if not sep:
            raise ValueError("bad header line")
        headers[k.strip().lower()] = v.strip()
    return method, target, headers


def response(status, ctype, body, extra=()):
    """The bytes of a whole answer (Connection: close: one request per connection)."""
    hdr = [f"HTTP/1.1 {status} {REASONS.get(status, '')}", f"Content-Type: {ctype}", f"Content-Length: {len(body)}",
           "Cache-Control: no-store", "X-Content-Type-Options: nosniff", *extra, "Connection: close", "", ""]
    return "\r\n".join(hdr).encode("latin-1") + body


def _json(status, obj):
    return status, "application/json; charset=utf-8", json.dumps(obj, separators=(",", ":")).encode("utf-8")


class _Stream:
    """An /api/events stream's pending work: what changed since it last wrote (flags), and the event that wakes it."""

    def __init__(self, route):
        self.state = True           # the state at once ...
        self.route = route          # ... and the route when there is one
        self.wake = asyncio.Event()


class Companion:
    """The live map's HTTP endpoint and its state (module docstring). send_cmd(dict) -> bool passes a command to the
    game (False: no game connected, 409); search(q, lat, lon) -> [{"name", "detail", "lat", "lon", ...}] blocks (run
    in executor, None: the loop's default) and raises on failure (SearchError: its text is the page's)."""

    def __init__(self, user_dir, web_dir=WEB_DIR, token=None, search=None, send_cmd=None, executor=None,
                 clock=time.monotonic, wall=time.time):
        self.user_dir = user_dir
        self.web_dir = web_dir
        self.token = token or secrets.token_urlsafe(18)
        self.search = search
        self.send_cmd = send_cmd
        self.executor = executor
        self.clock, self.wall = clock, wall
        self.port = None
        self.state_gap_s, self.ping_s = STATE_GAP_S, PING_S
        self.connected = False
        self.player = None          # {"lat", "lon", "heading", "speed", "t"} of the last pose
        self.heading = None         # the last heading (heading_of: kept while the car is slow)
        self.gps = None             # gps_of(the last gps_state)
        self.route_version = 0
        self.route = []
        self.api_key = self._read_key()
        self._streams = set()
        self._closed = False

    @property
    def url(self):
        """The page with its token (what open_companion opens)."""
        return f"http://127.0.0.1:{self.port}/?t={self.token}"

    @property
    def key_path(self):
        return os.path.join(self.user_dir, KEY_FILE)

    def _read_key(self):
        try:
            with open(self.key_path, encoding="utf-8") as f:
                key = f.read().strip()
        except OSError:
            return ""
        return key if KEY_RE.fullmatch(key) else ""

    # --- the feeds (earthd) ---------------------------------------------------------------------------------------
    def state(self):
        """The state snapshot (/api/state, the "state" event; docs/COMPANION.md "State")."""
        return {"v": 1, "connected": self.connected, "player": self.player, "gps": self.gps,
                "routeVersion": self.route_version, "apiKey": self.api_key}

    def route_event(self):
        return {"version": self.route_version, "points": self.route}

    def _changed(self, route=False):
        for st in self._streams:
            st.state = True
            st.route = st.route or route
            st.wake.set()

    def update_pose(self, lat, lon, vx, vy, speed=None):
        """The game's pose: its position (degrees), velocity east / north (m/s) and speed (m/s; the velocity's when
        left out). A pose without a finite position is ignored."""
        lat, lon = _finite(lat), _finite(lon)
        if lat is None or lon is None or not -90.0 <= lat <= 90.0:
            return
        self.heading = heading_of(vx, vy, self.heading)
        sp = _finite(speed)
        if sp is None:
            fx, fy = _finite(vx), _finite(vy)
            sp = math.hypot(fx, fy) if fx is not None and fy is not None else 0.0
        self.player = {"lat": round(lat, 7), "lon": round(lon, 7),
                       "heading": None if self.heading is None else round(self.heading, 1),
                       "speed": round(abs(sp), 2), "t": round(self.wall(), 3)}
        self._changed()

    def set_gps(self, msg):
        """The game's gps_state message (None / active false: no destination)."""
        gps = gps_of(msg)
        if gps != self.gps:
            self.gps = gps
            self._changed()

    def set_route(self, points):
        """The game connection's newly planned route ([[lat, lon], ...]; [] cleared): routeVersion + 1 and a "route"
        event (nothing when it was empty and still is)."""
        pts = route_of(points)
        if not pts and not self.route:
            return
        self.route = pts
        self.route_version += 1
        self._changed(route=True)

    def set_connected(self, on):
        """A game connection came (a gps_state) or went: gone, its destination and route go too (a new game sends its
        own gps_state after hello); the car's last position stays."""
        on = bool(on)
        if on == self.connected:
            return
        self.connected = on
        if not on:
            self.gps = None
            if self.route:
                self.route = []
                self.route_version += 1
                self._changed(route=True)
        self._changed()

    # --- requests ---------------------------------------------------------------------------------------------------
    def _token_ok(self, method, query, headers):
        got = headers.get("x-bne-token") if method == "POST" else (query.get("t") or [""])[0]
        return isinstance(got, str) and secrets.compare_digest(got.encode("utf-8", "replace"),
                                                               self.token.encode("utf-8"))

    def static(self, path):
        """(status, content type, body) of one of the page's files."""
        name, ctype = STATIC[path]
        try:
            with open(os.path.join(self.web_dir, name), "rb") as f:
                body = f.read()
        except OSError:                 # (the page not there yet: a checkout without it, a packaging mistake)
            return 404, "text/plain; charset=utf-8", b"not found"
        return 200, ctype, body

    async def respond(self, method, target, headers, body=b""):
        """(status, content type, body) for one request other than /api/events (no sockets: the tests call it)."""
        parts = urlsplit(target)
        path, query = parts.path, parse_qs(parts.query)
        if not check_host(headers.get("host"), self.port):
            return 421, "text/plain; charset=utf-8", b"wrong host"
        if path in STATIC:
            if method not in ("GET", "HEAD"):
                return 405, "text/plain; charset=utf-8", b"GET only"
            return self.static(path)
        if not path.startswith("/api/"):
            return 404, "text/plain; charset=utf-8", b"not found"
        if not self._token_ok(method, query, headers):
            return _json(403, {"ok": False, "error": "wrong or missing token"})
        want = {"/api/state": "GET", "/api/events": "GET", "/api/search": "GET", "/api/cmd": "POST",
                "/api/key": "POST"}.get(path)
        if want is None:
            return 404, "text/plain; charset=utf-8", b"not found"
        if method != want and not (want == "GET" and method == "HEAD"):
            return _json(405, {"ok": False, "error": f"{want} only"})
        if path == "/api/state":
            return _json(200, self.state())
        if path == "/api/events":       # (a GET with the right host and token never gets here: handle() streams it)
            return _json(400, {"ok": False, "error": "an event stream: GET it"})
        if path == "/api/search":
            return await self._search((query.get("q") or [""])[0])
        try:
            data = json.loads(body.decode("utf-8")) if body else None
        except (UnicodeDecodeError, ValueError):
            return _json(400, {"ok": False, "error": "the body is not JSON"})
        try:
            if path == "/api/cmd":
                cmd = check_cmd(data)
            else:
                key = check_key(data)
        except BadRequest as e:
            return _json(400, {"ok": False, "error": str(e)})
        if path == "/api/cmd":
            ok = False
            if self.connected and self.send_cmd is not None:
                try:
                    ok = bool(self.send_cmd(cmd))
                except Exception as e:      # (the connection closing under it)
                    log.debug("live map command %s: %s", cmd, e)
            if not ok:
                return _json(409, {"ok": False, "error": "the game is not connected"})
            return _json(200, {"ok": True})
        return self._store_key(key)

    def _store_key(self, key):
        try:
            if key:
                tmp = self.key_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(key + "\n")
                os.replace(tmp, self.key_path)
            else:
                try:
                    os.remove(self.key_path)
                except FileNotFoundError:
                    pass
        except OSError as e:
            log.warning("live map: the Google Maps key: %s", e)
            return _json(500, {"ok": False, "error": f"cannot store the key: {e.strerror or e}"})
        log.info("live map: Google Maps key %s", "stored" if key else "deleted")     # (never the key itself)
        if key != self.api_key:
            self.api_key = key
            self._changed()
        return _json(200, {"ok": True})

    async def _search(self, q):
        q = q.strip()
        if not Q_MIN <= len(q) <= Q_MAX:
            return _json(400, {"results": [], "error": f"q must be {Q_MIN}-{Q_MAX} characters"})
        if self.search is None:
            return _json(200, {"results": [], "error": "search is not available"})
        lat, lon = (self.player["lat"], self.player["lon"]) if self.player else (None, None)
        try:
            got = await asyncio.get_running_loop().run_in_executor(self.executor, self.search, q, lat, lon)
        except SearchError as e:
            return _json(200, {"results": [], "error": str(e)[:200]})
        except Exception as e:          # offline, rate limited, a bad answer
            return _json(200, {"results": [], "error": f"{type(e).__name__}: {e}"[:200]})
        out = []
        for r in got or ():
            if not isinstance(r, dict):
                continue
            lat, lon = _finite(r.get("lat")), _finite(r.get("lon"))
            if lat is None or lon is None:
                continue
            out.append({"name": str(r.get("name") or ""), "detail": str(r.get("detail") or ""), "lat": lat,
                        "lon": lon})
            if len(out) >= SEARCH_MAX:
                break
        return _json(200, {"results": out})

    # --- the socket side --------------------------------------------------------------------------------------------
    async def handle(self, reader, writer):
        try:
            try:
                head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), READ_TIMEOUT_S)
            except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
                return
            try:
                method, target, headers = parse_head(head[:-4])
            except ValueError:
                return await self._write(writer, response(400, "text/plain; charset=utf-8", b"bad request"))
            body = b""
            if method == "POST":
                try:
                    n = int(headers.get("content-length", ""))
                except ValueError:
                    n = -1
                if "transfer-encoding" in headers or n < 0:
                    return await self._write(writer, response(411, "text/plain; charset=utf-8", b"length required"))
                if n > MAX_BODY:
                    return await self._write(writer, response(*_json(413, {"ok": False, "error": "body too large"})))
                try:
                    body = await asyncio.wait_for(reader.readexactly(n), READ_TIMEOUT_S) if n else b""
                except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError):
                    return
            if urlsplit(target).path == "/api/events" and method == "GET" and check_host(headers.get("host"),
                                                                                         self.port):
                if self._token_ok(method, parse_qs(urlsplit(target).query), headers):
                    return await self._events(reader, writer)
            try:
                status, ctype, out = await self.respond(method, target, headers, body)
            except Exception as e:      # never take the endpoint down for one request
                log.exception("live map %s %s failed", method, urlsplit(target).path)
                status, ctype, out = 500, "text/plain; charset=utf-8", str(e).encode("utf-8", "replace")
            extra = ("Referrer-Policy: strict-origin-when-cross-origin",) if ctype.startswith("text/html") else ()
            data = response(status, ctype, out, extra)
            if method == "HEAD":
                data = data[:len(data) - len(out)]
            await self._write(writer, data)
        finally:
            writer.close()

    @staticmethod
    async def _write(writer, data):
        try:
            writer.write(data)
            await writer.drain()
        except ConnectionError:
            pass

    async def _events(self, reader, writer):
        """One /api/events stream until the browser goes (its socket's end) or close()."""
        if len(self._streams) >= MAX_STREAMS or self._closed:
            return await self._write(writer, response(*_json(503, {"ok": False, "error": "too many live maps open"})))
        st = _Stream(self.route_version > 0)
        self._streams.add(st)
        eof = asyncio.ensure_future(reader.read(1))     # the browser closed the page (or sent more: not HTTP/1.1 here)
        try:
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\n"
                         b"Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
                         b"retry: 2000\n\n")
            await writer.drain()
            last_state, last_write = -1e18, self.clock()
            while not eof.done() and not self._closed:
                now = self.clock()
                state_due = st.state and now - last_state >= self.state_gap_s
                ping_due = now - last_write >= self.ping_s
                if not (st.route or state_due or ping_due):
                    timeout = self.ping_s - (now - last_write)
                    if st.state:            # changed within the gap: sent at its end (coalesced)
                        timeout = min(timeout, self.state_gap_s - (now - last_state))
                    st.wake.clear()         # (no await since the flags were read: no change can be missed)
                    waiter = asyncio.ensure_future(st.wake.wait())
                    try:
                        await asyncio.wait({waiter, eof}, timeout=max(0.0, timeout),
                                           return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        waiter.cancel()
                    continue
                parts = []
                if st.route:
                    st.route = False
                    parts.append(sse("route", self.route_event()))
                if state_due:
                    st.state, last_state = False, now
                    parts.append(sse("state", self.state()))
                writer.write(b"".join(parts) or b": ping\n\n")
                await writer.drain()
                last_write = self.clock()
        except ConnectionError:
            pass
        finally:
            self._streams.discard(st)
            eof.cancel()

    def streams(self):
        """The /api/events streams open now."""
        return len(self._streams)

    async def start(self, port=DEFAULT_PORT, host="127.0.0.1"):
        """The HTTP server on host:port (0: any free port); returns (asyncio server, port)."""
        srv = await asyncio.start_server(self.handle, host, port, limit=MAX_REQUEST)
        self.port = srv.sockets[0].getsockname()[1]
        return srv, self.port

    def close(self):
        """Ends the open streams (the server's own close() does not end its handlers)."""
        self._closed = True
        for st in self._streams:
            st.wake.set()

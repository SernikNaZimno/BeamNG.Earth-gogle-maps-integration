# Live map in the browser and on a phone (the fork's Google Maps integration, phases 1 to 3)

A web page served by the world server (earthd) shows the player's car live on a Google map (Maps JavaScript API with
the player's own key): where the car is and which way it drives, its speed, the GPS destination and the planned route.
Clicking the map sets the GPS destination or teleports there; the page can turn Autodrive on and off and search for
places (Photon, as the in-game map). It is opened from the game (the world map's **Live map** button) in the player's
browser; a second monitor is the use case. Phase 2 opens the same page on a phone over the local network, paired by a
QR code ("Phone over the local network" below).

Only our own data (the car, the destination, the OSRM route, Photon's results) is drawn on Google's map; nothing of
Google's (Places, Directions, Routes) is used, so the EEA terms' "Google Maps Content with any map" rule is not touched.

## Pieces

| Piece | Where | What |
|---|---|---|
| HTTP endpoint | `server/companion.py` | static page, state snapshot, live events (SSE), commands, key storage, search |
| earthd glue | `server/earthd.py` | starts it, feeds poses / GPS state / routes in, sends commands to the game |
| the page | `server/companion_web/` (`index.html`, `app.js`, `style.css`) | the Google map, markers, route, controls |
| the mod | `gps.lua`, `core.lua`, `EarthMap.vue` | sends `gps_state`, runs `remote_cmd`, the **Live map** button (`open_companion`) |

## HTTP (127.0.0.1 only in phase 1)

`--companion-port N` (default **47616**; `0` = off). Bound to `127.0.0.1`. Every response has
`Cache-Control: no-store` (map tiles excepted: phase 3); no CORS headers are ever sent.

**Token:** earthd makes a random token at start (`secrets.token_urlsafe(18)`). The page is opened at
`http://127.0.0.1:<port>/?t=<token>`; every `/api/` request must carry it: `?t=` on GET (EventSource cannot set
headers), the `X-BNE-Token` header on POST (a custom header: a cross-site page cannot send it without a CORS preflight,
which is never answered). A wrong or missing token: `403`. **Host check:** a `Host` header other than
`127.0.0.1:<port>` or `localhost:<port>`: `421` (DNS rebinding). Static files need no token (they hold no secrets).

| Request | Answer |
|---|---|
| `GET /`, `/index.html`, `/app.js`, `/style.css` | the files from `server/companion_web/` (text/html, text/javascript, text/css; utf-8) |
| `GET /api/state?t=` | the state (below) as JSON |
| `GET /api/events?t=` | `text/event-stream`: `event: state` + `data: <state JSON>` at once and on every change (at most 4 a second); `event: route` + `data: {"version": n, "points": [[lat, lon], ...]}` at once if there is a route and whenever a new one is planned (`points: []` when cleared); a `: ping` comment every 15 s. At most 8 streams at once (`503` beyond). |
| `POST /api/cmd` (`X-BNE-Token`, JSON body) | `{"action": "gps", "lat", "lon", "name"?}`, `{"action": "clear_gps"}`, `{"action": "teleport", "lat", "lon"}`, `{"action": "autodrive", "on": bool}` -> `200 {"ok": true}`; `400 {"ok": false, "error"}` for a bad body (lat -90..90, lon -180..180, name a string up to 120 chars); `409 {"ok": false, "error": "the game is not connected"}` with no game connected. Body at most 4 KB. |
| `POST /api/key` (`X-BNE-Token`, JSON body) | `{"key": "AIza..."}` (`[A-Za-z0-9_-]{20,80}`) stores the player's Maps JavaScript API key in `<user dir>/google_maps_key.txt`; `{"key": ""}` deletes it -> `{"ok": true}` (`400` for a bad key) |
| `GET /api/search?t=&q=` | `{"results": [{"name", "detail", "lat", "lon"}, ...]}` from `geocode.search` (Photon, biased to the player), `{"results": [], "error"}` on failure; `q` 3-200 chars |

**State** (`/api/state`, the `state` event):

```json
{"v": 1, "connected": true,
 "player": {"lat": 50.06, "lon": 19.94, "heading": 87.5, "speed": 13.4, "t": 1793900000.0},
 "gps": {"lat": 52.23, "lon": 21.01, "name": "Warsaw", "autodrive": false, "remaining": 254000.0, "eta": 9800.0},
 "routeVersion": 3, "apiKey": "AIza..."}
```

`connected`: a game is connected (a connection that sent `gps_state`). `player`: null before the first pose; `heading`
in compass degrees (0 = north, clockwise) from the pose's `vx`, `vy` (east, north m/s) while faster than 1 m/s, else
the last one (null if never); `speed` m/s. `gps`: null without a destination; `remaining` (m) / `eta` (s) null when
unknown. `routeVersion`: increases with every planned route (0: none). `apiKey`: the stored key or `""`.

## Messages (protocol 4, additive)

| Direction | Message | Notes |
|---|---|---|
| mod -> server | `{"type": "gps_state", "active": bool, "lat"?, "lon"?, "name"?, "autodrive"?, "remaining"?, "eta"?}` | after every `hello`, whenever the destination, its name or autodrive changes, and every 2 s while active (remaining / eta). `active: false`: no destination (the other fields left out). Marks the connection as the game's. |
| mod -> server | `{"type": "open_companion"}` | the world map's **Live map** button: the server opens `http://127.0.0.1:<port>/?t=<token>` in the player's browser (as `open_page` does). |
| server -> mod | `{"type": "remote_cmd", "action": "gps" \| "clear_gps" \| "teleport" \| "autodrive", "lat"?, "lon"?, "name"?, "on"?}` | a command from the page, to the most recent connection that sent `gps_state`. The mod runs it as the world map would (`gps.setDestination`, `gps.clear`, `places.goTo`, `gps.setAutodrive`); a teleport it cannot do now (places.cannotGo) is dropped with a log line. |
| server -> mod | `{"type": "companion", "port": n}` | after `hello` when the endpoint is on: the mod shows the **Live map** button only then. |

The route: earthd keeps each connection's last planned route (`Connection.route_points`, from `route_result`); the
game connection's new route becomes the page's `route` event (its version +1).

## Google Maps key

The page loads `https://maps.googleapis.com/maps/api/js?key=<key>&callback=...&loading=async&v=weekly`. Without a
key it shows a box to paste one (stored with `POST /api/key`, then the page reloads); Google draws its own "for
development purposes only" map without a key, which is enough to try it. The key should be restricted to the
**Maps JavaScript API** and to the website `http://127.0.0.1:47616/*` in Google Cloud.

## Phone over the local network (phase 2)

Off by default; nothing listens beyond 127.0.0.1 until the player asks. Turned on from the game (the world map's
**Phone** button next to **Live map**) or from the PC's page (its **Phone** button); both show a QR code of the phone
URL, scanned with the phone's camera (Android and iPhone alike: any browser, nothing installed).

**Turning it on** (`Companion.set_lan(True)`, a coroutine; idempotent while on):
- The LAN address: `--companion-lan-ip A` if given, else the IPv4 address of the interface with the default route (a
  UDP socket `connect(("10.255.255.255", 1))` + `getsockname()`, no packet is sent), else the first private address of
  `getaddrinfo(gethostname())`. It must be private IPv4 (10/8, 172.16/12, 192.168/16); anything else (none found, a
  public or loopback address) is an error: `"no local network address found"` (or the address and why).
- A second `asyncio.start_server` on `<lan ip>:<port>` (the same port as the loopback one). A bind error (port taken
  on that address, the address gone) is an error with its text.
- A new **phone token** (`secrets.token_urlsafe(18)`), separate from the PC token. The phone URL:
  `http://<lan ip>:<port>/?t=<phone token>`.

**Turning it off** (`set_lan(False)`): the LAN listener closes, the phone streams end, the phone token is dropped
(an old QR code is dead). **New code** = off then on: a new token, every phone disconnected. The server stopping turns
it off; it is never remembered across starts.

**Requests on the LAN listener** (checked before anything else, in this order):
1. The peer must be a private IPv4 address (as above) or the connection is closed without an answer.
2. More than 20 requests with a wrong token from one peer in 60 s: `429` for that peer for the next 60 s.
3. The Host header must be `<lan ip>:<port>`: `421` otherwise.
4. `/api/` needs the **phone token** (the PC token is not accepted here, and the phone token is not accepted on the
   loopback listener): `403`.
5. `POST /api/key` and `/api/lan`: `403 {"ok": false, "error": "only on the PC"}`. Everything else (state, events,
   search, cmd) as on the PC.

**New endpoint (loopback listener only, PC token):**

| Request | Answer |
|---|---|
| `GET /api/lan?t=` | `{"on": bool, "url": "http://192.168.1.23:47616/?t=..." \| null, "ip": "192.168.1.23" \| null, "phones": n, "error": null \| "..."}` (`error`: why the last try to turn it on failed) |
| `POST /api/lan` (`X-BNE-Token`, JSON) | `{"on": true}`, `{"on": false}` or `{"renew": true}` (a new code) -> the same object as GET (`200`; `error` set and `on: false` when turning it on failed) |

**State** (`/api/state`, the `state` event) gets `"lan": {"on": bool, "phones": n}` for everyone (no URL, no token);
`phones` = the phone event streams open now. A change of either is a state change (pushed as usual).

**Messages** (protocol 4, additive):

| Direction | Message | Notes |
|---|---|---|
| mod -> server | `{"type": "companion_lan", "on": bool, "renew"?: true}` | the world map's Phone dialog: on when it opens (if off), renew for **New code**, off for **Stop** |
| server -> mod | `{"type": "companion_lan_state", "on": bool, "url": str \| null, "phones": n, "error": str \| null}` | the answer to every `companion_lan`, and whenever `on` or `phones` changes (turned on or off from the page, a phone connecting or leaving); to the game connection (the one that sent `gps_state`, else the asker) |

**The page on a phone** (the same files; `location.hostname` is not `127.0.0.1` / `localhost`):
- Layout for a narrow touch screen: big buttons, one-finger panning (`gestureHandling: "greedy"`), the safe areas
  (`viewport-fit=cover`, `env(safe-area-inset-*)`), no page zoom fighting the map.
- No key form (the key is set on the PC): without a key the panel says so. With or without a key it tells the player to
  allow `http://<location.host>/*` among the key's website restrictions (the phone's address differs from the PC's).
- When the event stream drops (the phone slept, Wi-Fi changed) a "Reconnecting..." strip; on `visibilitychange` back
  to visible the stream is reopened at once; a `403` means the code was renewed or sharing stopped: "This link has
  expired: scan the new QR code on the PC" and no more retries.
- The screen-wake lock needs a secure context (https), which a LAN page is not: not used.

**The PC page:** a **Phone** button (loopback only) opens a box: the QR code (`/qrcode.js`, a byte-identical copy of
the mod's `ui-vue/mods/beamngEarth/qrcode.js`, loaded with `import()`), the URL as text, "N phones connected",
**New code**, **Stop sharing**, **Close**, and the hints below.

**Hints shown with every QR code** (game and PC page): the phone must be on the same Wi-Fi / network as this PC;
Windows may ask to allow the app through the firewall the first time (allow it on **private** networks; a network set
to **Public** blocks phones); the link is plain HTTP on your own network: use it at home, not on public Wi-Fi.

## The map without a key (phase 3)

The page works with no Google key: its default renderer is **MapLibre GL JS 4.7.1** (BSD-3, bundled, nothing loaded
from a CDN) with keyless base maps. Google Maps stays an option for a player who pastes their own key.

**Bundled files** (static, no token): `/vendor/maplibre-gl/maplibre-gl.js`, `/vendor/maplibre-gl/maplibre-gl.css`,
`/vendor/maplibre-gl/LICENSE.txt` (`server/companion_web/vendor/maplibre-gl/`, copied unchanged from the npm package
`maplibre-gl@4.7.1` `dist/`).

**Base maps** (a picker on the page; the choice remembered per browser in `localStorage`, wrapped in try/catch):

| Id | What | From |
|---|---|---|
| `streets` (default) | OpenFreeMap "liberty": an OpenStreetMap street map, vector, sharp at every zoom | `https://tiles.openfreemap.org/styles/liberty`, fetched by the browser itself (the PC's or the phone's; no key, no account) |
| `satellite` | the world server's imagery (the in-game map's "sat") with its "labels" overlay | `/api/tiles/sat/{z}/{x}/{y}?t=` + `/api/tiles/labels/{z}/{x}/{y}?t=` |
| `terrain` | the in-game map's "map" layer (EOX terrain-light) with the labels | `/api/tiles/map/...` + `/api/tiles/labels/...` |
| `google` | Google Maps (the phase 1 renderer) | only listed when a key is stored |

- When `streets` cannot load (offline, OpenFreeMap down: the style or its first tiles fail) the page switches to
  `satellite` by itself (not remembered) and says "Street map unavailable (offline?): showing the world server's
  satellite map". `satellite` / `terrain` are not listed when `state.tiles` is false.
- Attribution always shown: MapLibre's attribution control (compact: its (i) button) with OpenFreeMap's own
  (© OpenMapTiles, © OpenStreetMap contributors, OpenFreeMap) for `streets`, EOX's for the terrain and labels layers;
  for `satellite` a strip with only the imagery sources the view shows (`/api/attribution`'s `areas`, as the in-game
  map does; two lines, the whole text on a click).
- The overlays (the car with its heading, the destination, the route, the click menu, the search pin) look and work
  the same on every base map; switching keeps the view (centre, zoom) and the overlays; follow mode as before.
- The key panel no longer opens by itself: the picker has "Google Maps (your own key)..." which opens it (PC only; the
  phone's says the key is set on the PC). With a key stored, `google` is the default until the player picks another.

**Server** (`server/companion.py`; the same checks as every `/api/` request: Host, token per listener, the 429 rule):

| Request | Answer |
|---|---|
| `GET /api/tiles/{layer}/{z}/{x}/{y}?t=` | `layer` in `sat`, `map`, `labels`; `z`/`x`/`y` checked with `maptiles.check_tile`. `image/jpeg` (`image/png` for `labels`) from `MapTiles.layer_tile` (run in the executor, at most 6 at once; more wait), `Cache-Control: private, max-age=3600` (tiles only; everything else stays `no-store`). `404` where there is no tile or the server has no map tiles (`--map-tiles` off / no imagery), `503` when fetching failed (retry later). |
| `GET /api/attribution?t=` | `{"attribution": "...", "areas": [[credit, w, s, e, n] or [credit], ...]}` (`MapTiles.attribution()`, `imagery.credits_by_area()`; `""` / `[]` without map tiles) |

**State** gets `"tiles": bool` (the server has map tiles). earthd hands its `MapTiles` (`server.map_tiles`) to the
companion.

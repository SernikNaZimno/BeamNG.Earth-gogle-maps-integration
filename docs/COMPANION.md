# Live map in the browser (the fork's Google Maps integration, phase 1)

A web page served by the world server (earthd) shows the player's car live on a Google map (Maps JavaScript API with
the player's own key): where the car is and which way it drives, its speed, the GPS destination and the planned route.
Clicking the map sets the GPS destination or teleports there; the page can turn Autodrive on and off and search for
places (Photon, as the in-game map). It is opened from the game (the world map's **Live map** button) in the player's
browser; a second monitor is the use case. Phase 2 (planned) opens the same page on a phone over the local network.

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
`Cache-Control: no-store`; no CORS headers are ever sent.

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

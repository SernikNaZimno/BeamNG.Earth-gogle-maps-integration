"""companion: the live map in the browser (docs/COMPANION.md): the pure parts (heading, checks, state, framing), the
request handler without sockets, the real endpoint over sockets (the event stream: framing, coalescing, pings, the
stream cap, clean-up), the phone over the local network (the LAN address, the LAN listener's checks in order, the
429 rule, the tokens kept apart, /api/lan, state.lan, on / off / renew, its listener on a socket, qrcode.js the mod's
copy) and earthd's glue (gps_state marks the game's connection, its poses / routes reach the state, the page's
commands reach the mod as remote_cmd, hello is followed by "companion", companion_lan -> companion_lan_state)."""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import companion  # noqa: E402

PORT = 47616
TOKEN = "tok_" + "x" * 20
KEY = "AIza" + "B" * 35
HOST = {"host": f"127.0.0.1:{PORT}"}


def run(coro):
    return asyncio.run(coro)


def make(tmp, **kw):
    """A Companion on the temp dir (web files under tmp/web), its port set as start() would."""
    c = companion.Companion(tmp, os.path.join(tmp, "web"), token=TOKEN, **kw)
    c.port = PORT
    return c


def body_of(answer):
    return json.loads(answer[2].decode("utf-8"))


class HeadingTest(unittest.TestCase):
    def test_compass(self):
        h = companion.heading_of
        self.assertAlmostEqual(h(0, 5), 0.0)
        self.assertAlmostEqual(h(5, 0), 90.0)
        self.assertAlmostEqual(h(0, -5), 180.0)
        self.assertAlmostEqual(h(-5, 0), 270.0)
        self.assertAlmostEqual(h(3, 3), 45.0)
        self.assertAlmostEqual(h(-3, 3), 315.0)

    def test_slow_keeps_the_last(self):
        h = companion.heading_of
        self.assertIsNone(h(0.5, 0.5))                 # never moved: none
        self.assertEqual(h(0.5, 0.2, 123.0), 123.0)    # slow: the last
        self.assertEqual(h(0.6, 0.8, 7.0), 7.0)        # exactly 1 m/s: still the last
        self.assertEqual(h(float("nan"), 9, 7.0), 7.0)
        self.assertEqual(h(True, 9, 7.0), 7.0)          # (a bool is not a number)


class PureChecksTest(unittest.TestCase):
    def test_host(self):
        ok = companion.check_host
        self.assertTrue(ok("127.0.0.1:47616", 47616))
        self.assertTrue(ok("LOCALHOST:47616", 47616))
        for bad in (None, "", "127.0.0.1", "127.0.0.1:1", "evil.example:47616", "localhost.evil.example:47616",
                    "127.0.0.1:47616.evil"):
            self.assertFalse(ok(bad, 47616), bad)
        self.assertFalse(ok("127.0.0.1:47616", None))

    def test_cmd(self):
        c = companion.check_cmd
        self.assertEqual(c({"action": "gps", "lat": 50, "lon": 19.5, "name": "Kraków", "junk": 1}),
                         {"action": "gps", "lat": 50.0, "lon": 19.5, "name": "Kraków"})
        self.assertEqual(c({"action": "gps", "lat": 50, "lon": 19.5, "name": ""}),
                         {"action": "gps", "lat": 50.0, "lon": 19.5})
        self.assertEqual(c({"action": "clear_gps", "lat": 1}), {"action": "clear_gps"})
        self.assertEqual(c({"action": "teleport", "lat": -90, "lon": 180}),
                         {"action": "teleport", "lat": -90.0, "lon": 180.0})
        self.assertEqual(c({"action": "autodrive", "on": False}), {"action": "autodrive", "on": False})
        for bad in (None, [], "gps", {}, {"action": "fly"}, {"action": "gps", "lat": 91, "lon": 0},
                    {"action": "gps", "lat": 0, "lon": -180.5}, {"action": "gps", "lat": "1", "lon": 0},
                    {"action": "teleport", "lat": True, "lon": 0}, {"action": "teleport", "lat": 1},
                    {"action": "gps", "lat": 0, "lon": 0, "name": "x" * 121},
                    {"action": "gps", "lat": 0, "lon": 0, "name": 5},
                    {"action": "autodrive"}, {"action": "autodrive", "on": 1},
                    {"action": "gps", "lat": float("inf"), "lon": 0}):
            with self.assertRaises(companion.BadRequest, msg=bad):
                c(bad)

    def test_key(self):
        self.assertEqual(companion.check_key({"key": KEY}), KEY)
        self.assertEqual(companion.check_key({"key": " " + KEY + "\n"}), KEY)
        self.assertEqual(companion.check_key({"key": ""}), "")
        for bad in (None, {}, {"key": None}, {"key": "short"}, {"key": "A" * 81}, {"key": "AIza" + "x" * 20 + "!"},
                    {"key": "AIza" + "x" * 20 + " y"}):
            with self.assertRaises(companion.BadRequest, msg=bad):
                companion.check_key(bad)

    def test_gps_of(self):
        self.assertIsNone(companion.gps_of(None))
        self.assertIsNone(companion.gps_of({"type": "gps_state", "active": False}))
        self.assertIsNone(companion.gps_of({"active": True}))          # (no position: no destination)
        self.assertEqual(companion.gps_of({"active": True, "lat": 52.23, "lon": 21.01, "name": "Warsaw",
                                           "autodrive": True, "remaining": 254000, "eta": 9800}),
                         {"lat": 52.23, "lon": 21.01, "name": "Warsaw", "autodrive": True, "remaining": 254000.0,
                          "eta": 9800.0})
        self.assertEqual(companion.gps_of({"active": True, "lat": 1, "lon": 2, "eta": -1}),
                         {"lat": 1.0, "lon": 2.0, "name": "", "autodrive": False, "remaining": None, "eta": None})

    def test_route_of(self):
        self.assertEqual(companion.route_of([[50.1234567, 19.7654321], [1, 2, 3], "x", [None, 1], [5]]),
                         [[50.123457, 19.765432], [1, 2]])
        self.assertEqual(companion.route_of(None), [])

    def test_sse_and_head(self):
        self.assertEqual(companion.sse("route", {"version": 1, "points": []}),
                         b'event: route\ndata: {"version":1,"points":[]}\n\n')
        m, t, h = companion.parse_head(b"GET /api/state?t=a HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-BNE-Token:  q ")
        self.assertEqual((m, t, h), ("GET", "/api/state?t=a", {"host": "127.0.0.1:1", "x-bne-token": "q"}))
        for bad in (b"GET", b"GET x HTTP/1.1", b"GET / FTP/1", b"GET / HTTP/1.1\r\nnocolon"):
            with self.assertRaises(ValueError):
                companion.parse_head(bad)


class FeedsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.c = make(self.tmp.name, wall=lambda: 1793900000.0)

    def tearDown(self):
        self.tmp.cleanup()

    def test_state_shape(self):
        c = self.c
        self.assertEqual(c.state(), {"v": 1, "connected": False, "player": None, "gps": None, "routeVersion": 0,
                                     "apiKey": "", "lan": {"on": False, "phones": 0}})
        c.set_connected(True)
        c.update_pose(50.06, 19.94, 13.4, 0.0, 13.4)
        c.set_gps({"active": True, "lat": 52.23, "lon": 21.01, "name": "Warsaw", "autodrive": False,
                   "remaining": 254000.0, "eta": 9800.0})
        c.set_route([[50.06, 19.94], [52.23, 21.01]])
        s = json.loads(json.dumps(c.state()))
        self.assertEqual(s, {"v": 1, "connected": True,
                             "player": {"lat": 50.06, "lon": 19.94, "heading": 90.0, "speed": 13.4, "t": 1793900000.0},
                             "gps": {"lat": 52.23, "lon": 21.01, "name": "Warsaw", "autodrive": False,
                                     "remaining": 254000.0, "eta": 9800.0},
                             "routeVersion": 1, "apiKey": "", "lan": {"on": False, "phones": 0}})
        self.assertEqual(c.url, f"http://127.0.0.1:{PORT}/?t={TOKEN}")

    def test_pose(self):
        c = self.c
        c.update_pose(1, 2, 0.1, 0.1)
        self.assertIsNone(c.player["heading"])          # never fast: no heading yet
        self.assertAlmostEqual(c.player["speed"], 0.14, places=2)      # (the velocity's without a speed)
        c.update_pose(1, 2, 0, -10, 10)
        self.assertEqual(c.player["heading"], 180.0)
        c.update_pose(1, 2.001, 0.2, 0.1, 0.2)
        self.assertEqual(c.player["heading"], 180.0)    # slowed down: kept
        self.assertEqual(c.player["lon"], 2.001)
        c.update_pose(None, 2, 0, 1)                    # no position: ignored
        c.update_pose(95, 2, 0, 1)
        self.assertEqual(c.player["lat"], 1)

    def test_route_versions_and_disconnect(self):
        c = self.c
        c.set_route([])                                 # nothing to clear: no new version
        self.assertEqual(c.route_version, 0)
        c.set_route([[1, 2], [3, 4]])
        c.set_route([[1, 2], [5, 6]])
        self.assertEqual((c.route_version, c.route_event()), (2, {"version": 2, "points": [[1, 2], [5, 6]]}))
        c.set_connected(True)
        c.set_gps({"active": True, "lat": 1, "lon": 2})
        c.update_pose(1, 2, 0, 5)
        c.set_connected(False)                          # the game went: destination and route go, the car stays
        self.assertEqual((c.gps, c.route, c.route_version, c.connected), (None, [], 3, False))
        self.assertIsNotNone(c.player)


class RespondTest(unittest.TestCase):
    """Companion.respond: everything but the event stream, without sockets."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sent = []
        self.searched = []

        def search(q, lat, lon):
            self.searched.append((q, lat, lon))
            return [{"name": "Warsaw", "detail": "Poland", "kind": "city", "lat": 52.23, "lon": 21.01},
                    {"name": "no position"}, "junk"]
        self.c = make(self.tmp.name, search=search, send_cmd=lambda cmd: self.sent.append(cmd) or True)

    def tearDown(self):
        self.tmp.cleanup()

    def get(self, target, headers=HOST):
        return run(self.c.respond("GET", target, dict(headers)))

    def post(self, path, obj, token=TOKEN, raw=None):
        h = dict(HOST)
        if token is not None:
            h["x-bne-token"] = token
        return run(self.c.respond("POST", path, h, raw if raw is not None else json.dumps(obj).encode()))

    def test_host_check(self):
        for host in ({"host": "evil.example:47616"}, {}, {"host": "127.0.0.1:47617"}):
            self.assertEqual(self.get(f"/api/state?t={TOKEN}", host)[0], 421, host)
            self.assertEqual(self.get("/", host)[0], 421, host)      # (static files too)
        self.assertEqual(self.get(f"/api/state?t={TOKEN}", {"host": f"localhost:{PORT}"})[0], 200)

    def test_token(self):
        self.assertEqual(self.get("/api/state")[0], 403)
        self.assertEqual(self.get("/api/state?t=wrong")[0], 403)
        self.assertEqual(self.get("/api/state", dict(HOST, **{"x-bne-token": TOKEN}))[0], 403)   # GET: ?t= only
        self.assertEqual(self.get(f"/api/events?t=nope")[0], 403)
        self.assertEqual(self.get(f"/api/search?q=abc")[0], 403)
        self.assertEqual(self.post("/api/cmd", {"action": "clear_gps"}, token=None)[0], 403)
        self.assertEqual(self.post("/api/cmd", {"action": "clear_gps"}, token="wrong")[0], 403)
        # POST: the header only (a cross-site form could put ?t= in a URL, never a custom header)
        h = dict(HOST)
        self.assertEqual(run(self.c.respond("POST", f"/api/cmd?t={TOKEN}", h, b'{"action":"clear_gps"}'))[0], 403)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.get(f"/api/nothing?t={TOKEN}")[0], 404)
        self.assertEqual(self.get(f"/api/cmd?t={TOKEN}")[0], 405)
        self.assertEqual(self.post("/api/state", {})[0], 405)

    def test_state(self):
        st, ctype, body = self.get(f"/api/state?t={TOKEN}")
        self.assertEqual((st, ctype), (200, "application/json; charset=utf-8"))
        self.assertEqual(json.loads(body), self.c.state())

    def test_cmd_forwarded_and_409(self):
        self.assertEqual(self.post("/api/cmd", {"action": "clear_gps"})[:2],
                         (409, "application/json; charset=utf-8"))          # no game connected
        self.assertEqual(body_of(self.post("/api/cmd", {"action": "clear_gps"})),
                         {"ok": False, "error": "the game is not connected"})
        self.c.set_connected(True)
        r = self.post("/api/cmd", {"action": "gps", "lat": 52.2, "lon": 21.0, "name": "Warsaw"})
        self.assertEqual((r[0], body_of(r)), (200, {"ok": True}))
        self.assertEqual(self.sent, [{"action": "gps", "lat": 52.2, "lon": 21.0, "name": "Warsaw"}])
        r = self.post("/api/cmd", {"action": "teleport", "lat": 99, "lon": 0})
        self.assertEqual(r[0], 400)
        self.assertFalse(body_of(r)["ok"])
        self.assertIn("lat", body_of(r)["error"])
        self.assertEqual(self.post("/api/cmd", None, raw=b"{not json")[0], 400)
        self.assertEqual(self.post("/api/cmd", None, raw=b"\xff\xfe")[0], 400)
        self.assertEqual(len(self.sent), 1)
        self.c.send_cmd = lambda cmd: False             # the game's connection closing
        self.assertEqual(self.post("/api/cmd", {"action": "autodrive", "on": True})[0], 409)

        def boom(cmd):
            raise ConnectionResetError("gone")
        self.c.send_cmd = boom
        self.assertEqual(self.post("/api/cmd", {"action": "autodrive", "on": True})[0], 409)

    def test_key(self):
        path = os.path.join(self.tmp.name, "google_maps_key.txt")
        r = self.post("/api/key", {"key": KEY})
        self.assertEqual((r[0], body_of(r)), (200, {"ok": True}))
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), KEY)
        self.assertEqual(self.c.state()["apiKey"], KEY)
        self.assertEqual(make(self.tmp.name).api_key, KEY)        # read back at the next start
        self.assertEqual(self.post("/api/key", {"key": "not a key"})[0], 400)
        self.assertEqual(self.post("/api/key", {"nokey": 1})[0], 400)
        self.assertEqual(self.c.api_key, KEY)
        self.assertEqual(self.post("/api/key", {"key": ""})[0], 200)
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self.c.state()["apiKey"], "")
        self.assertEqual(self.post("/api/key", {"key": ""})[0], 200)        # (already gone: fine)
        with open(path, "w", encoding="utf-8") as f:
            f.write("garbage!\n")
        self.assertEqual(make(self.tmp.name).api_key, "")         # a damaged file: no key

    def test_search(self):
        r = self.get(f"/api/search?t={TOKEN}&q=Warsaw")
        self.assertEqual((r[0], body_of(r)),
                         (200, {"results": [{"name": "Warsaw", "detail": "Poland", "lat": 52.23, "lon": 21.01}]}))
        self.assertEqual(self.searched, [("Warsaw", None, None)])  # no pose yet: no bias
        self.c.update_pose(50.06, 19.94, 0, 0)
        self.get(f"/api/search?t={TOKEN}&q=%20Krak%C3%B3w%20")
        self.assertEqual(self.searched[-1], ("Kraków", 50.06, 19.94))   # biased to the car
        for q in ("ab", "x" * 201, ""):
            r = self.get(f"/api/search?t={TOKEN}&q={q}")
            self.assertEqual((r[0], body_of(r)["results"]), (400, []), q)
        self.assertEqual(len(self.searched), 2)

        def fail(q, lat, lon):
            raise companion.SearchError("Address search busy (too many requests): try again in a minute")
        self.c.search = fail
        self.assertEqual(body_of(self.get(f"/api/search?t={TOKEN}&q=abc")),
                         {"results": [], "error": "Address search busy (too many requests): try again in a minute"})

        def crash(q, lat, lon):
            raise OSError("down")
        self.c.search = crash
        self.assertEqual(body_of(self.get(f"/api/search?t={TOKEN}&q=abc")), {"results": [], "error": "OSError: down"})
        self.c.search = None
        self.assertEqual(body_of(self.get(f"/api/search?t={TOKEN}&q=abc"))["results"], [])

    def test_static(self):
        self.assertEqual(self.get("/")[0], 404)                     # the page not there yet
        web = os.path.join(self.tmp.name, "web")
        os.makedirs(web)
        for name, text in (("index.html", "<!doctype html>"), ("app.js", "1;"), ("style.css", "a{}"),
                           ("qrcode.js", "2;")):
            with open(os.path.join(web, name), "w", encoding="utf-8") as f:
                f.write(text)
        with open(os.path.join(web, "secret.txt"), "w", encoding="utf-8") as f:
            f.write("no")
        for path, ctype, text in (("/", "text/html", "<!doctype html>"), ("/index.html", "text/html", "<!doctype html>"),
                                  ("/?t=" + TOKEN, "text/html", "<!doctype html>"),
                                  ("/app.js", "text/javascript", "1;"), ("/style.css", "text/css", "a{}"),
                                  ("/qrcode.js", "text/javascript", "2;")):
            st, got_type, body = self.get(path)
            self.assertEqual((st, got_type, body.decode()), (200, ctype + "; charset=utf-8", text), path)
        for path in ("/secret.txt", "/../companion.py", "/web/app.js", "/favicon.ico", "/APP.JS"):
            self.assertEqual(self.get(path)[0], 404, path)
        self.assertEqual(run(self.c.respond("POST", "/", dict(HOST), b""))[0], 405)
        os.remove(os.path.join(web, "app.js"))
        self.assertEqual(self.get("/app.js")[0], 404)


LAN_IP = "192.168.1.23"
LAN_HOST = {"host": f"{LAN_IP}:{PORT}"}
PHONE = "192.168.1.50"                      # a phone's address on the same network


class FakeSocketModule:
    """socket's parts lan_address uses: the default route's UDP trick (route: its address, or an OSError) and the host
    name's addresses (hostaddrs, or an OSError)."""
    AF_INET, SOCK_DGRAM = companion.socket.AF_INET, companion.socket.SOCK_DGRAM

    def __init__(self, route=None, hostaddrs=()):
        self.route, self.hostaddrs = route, hostaddrs
        self.connected, self.closed = [], 0

    def socket(self, family, kind):
        mod = self

        class Udp:
            def connect(self, addr):
                mod.connected.append((family, kind, addr))
                if isinstance(mod.route, OSError):
                    raise mod.route

            def getsockname(self):
                return (mod.route, 54321)

            def close(self):
                mod.closed += 1
        return Udp()

    def gethostname(self):
        return "gaming-pc"

    def getaddrinfo(self, host, port, family):
        assert (host, family) == ("gaming-pc", self.AF_INET)
        if isinstance(self.hostaddrs, OSError):
            raise self.hostaddrs
        return [(family, 1, 6, "", (ip, 0)) for ip in self.hostaddrs]


class LanAddressTest(unittest.TestCase):
    def test_private_only(self):
        for ip in ("10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.1", "192.168.0.1", "192.168.255.254"):
            self.assertTrue(companion.is_lan(ip), ip)
        for ip, why in (("127.0.0.1", "loopback"), ("169.254.3.4", "link-local"), ("8.8.8.8", "public"),
                        ("172.32.0.1", "public"), ("172.15.255.1", "public"), ("0.0.0.0", "no address"),
                        ("100.64.0.1", ""), ("::1", "not an IPv4"), ("fe80::1", "not an IPv4"),
                        ("192.168.1", "not an IPv4"), ("", "not an IPv4"), (None, "not an IPv4"),
                        ("224.0.0.1", "")):
            self.assertFalse(companion.is_lan(ip), ip)
            self.assertIn(why, companion.why_not_lan(ip), ip)

    def test_default_route_first(self):
        fake = FakeSocketModule("192.168.1.23", ["10.0.0.5"])
        self.assertEqual(companion.lan_address(sock=fake), "192.168.1.23")
        self.assertEqual(fake.connected, [(fake.AF_INET, fake.SOCK_DGRAM, ("10.255.255.255", 1))])
        self.assertEqual(fake.closed, 1)

    def test_host_name_fallback(self):
        # the default route's address public (a PC straight on the modem): the host name's first private one
        fake = FakeSocketModule("85.1.2.3", ["127.0.1.1", "169.254.1.1", "10.0.0.5", "192.168.1.9"])
        self.assertEqual(companion.lan_address(sock=fake), "10.0.0.5")
        fake = FakeSocketModule(OSError("network is unreachable"), ["172.20.1.2"])     # (no default route)
        self.assertEqual(companion.lan_address(sock=fake), "172.20.1.2")
        self.assertEqual(fake.closed, 1)                # (closed after a failed connect too)

    def test_none_found(self):
        with self.assertRaises(companion.LanError) as cm:
            companion.lan_address(sock=FakeSocketModule(OSError("unreachable"), OSError("no name")))
        self.assertEqual(str(cm.exception), "no local network address found")
        with self.assertRaises(companion.LanError) as cm:
            companion.lan_address(sock=FakeSocketModule("85.1.2.3", []))
        self.assertEqual(str(cm.exception), "no local network address found (85.1.2.3 is a public address)")
        with self.assertRaises(companion.LanError) as cm:
            companion.lan_address(sock=FakeSocketModule("0.0.0.0", ["127.0.0.1"]))
        self.assertEqual(str(cm.exception), "no local network address found (127.0.0.1 is a loopback address)")

    def test_override(self):
        fake = FakeSocketModule(OSError("must not be asked"), OSError("must not be asked"))
        self.assertEqual(companion.lan_address("192.168.50.2", sock=fake), "192.168.50.2")
        self.assertEqual(fake.connected, [])
        for bad, why in (("8.8.8.8", "a public address"), ("127.0.0.1", "a loopback address"),
                         ("my-pc", "not an IPv4 address")):
            with self.assertRaises(companion.LanError) as cm:
                companion.lan_address(bad, sock=fake)
            self.assertEqual(str(cm.exception), f"--companion-lan-ip {bad}: {why}")

    def test_check_lan(self):
        self.assertIs(companion.check_lan({"on": True}), True)
        self.assertIs(companion.check_lan({"on": False}), False)
        self.assertEqual(companion.check_lan({"renew": True}), "renew")
        for bad in (None, [], {}, {"on": 1}, {"on": "true"}, {"renew": 1}, {"renew": False}):
            with self.assertRaises(companion.BadRequest, msg=bad):
                companion.check_lan(bad)


class FakeServer:
    """What asyncio.start_server returns, as far as the phone sharing uses it."""

    def __init__(self, host, port):
        self.host, self.port, self.closed = host, port, False

    def close(self):
        self.closed = True


class LanRespondTest(unittest.TestCase):
    """The phone sharing without sockets: set_lan / renew_lan (asyncio.start_server faked), the LAN listener's checks
    through respond(lan=True, peer=...) in the contract's order, the 429 rule on a fake clock, /api/lan, state.lan."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = 1000.0
        self.sent, self.told, self.servers = [], [], []
        self.c = make(self.tmp.name, clock=lambda: self.now, send_cmd=lambda cmd: self.sent.append(cmd) or True,
                      search=lambda q, lat, lon: [{"name": "A", "lat": 1, "lon": 2}],
                      on_lan_change=lambda: self.told.append(self.c.lan_info()))
        self.c.lan_address = lambda: LAN_IP

        async def start_server(handler, host, port, limit=None):
            self.servers.append(FakeServer(host, port))
            return self.servers[-1]
        patcher = mock.patch.object(companion.asyncio, "start_server", start_server)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def on(self):
        info = run(self.c.set_lan(True))
        self.assertTrue(info["on"], info)
        return self.c.lan_token

    def lan(self, method, target, token=None, peer=PHONE, headers=LAN_HOST, body=b""):
        h = dict(headers)
        if token is not None:
            h["x-bne-token"] = token
        return run(self.c.respond(method, target, h, body, lan=True, peer=peer))

    def pc_post(self, path, obj):
        return run(self.c.respond("POST", path, dict(HOST, **{"x-bne-token": TOKEN}), json.dumps(obj).encode()))

    def test_on_off_renew(self):
        c = self.c
        self.assertEqual(c.lan_info(), {"on": False, "url": None, "ip": None, "phones": 0, "error": None})
        token = self.on()
        self.assertNotEqual(token, TOKEN)
        self.assertGreaterEqual(len(token), 24)
        self.assertEqual(c.lan_info(), {"on": True, "url": f"http://{LAN_IP}:{PORT}/?t={token}", "ip": LAN_IP,
                                        "phones": 0, "error": None})
        self.assertEqual((self.servers[0].host, self.servers[0].port), (LAN_IP, PORT))    # the same port
        self.assertEqual(c.state()["lan"], {"on": True, "phones": 0})          # (no URL, no token in the state)
        self.assertNotIn(token, json.dumps(c.state()))
        self.assertEqual(len(self.told), 1)
        self.assertEqual(run(c.set_lan(True))["url"], c.lan_url)               # idempotent: the same code
        self.assertEqual((len(self.servers), c.lan_token, len(self.told)), (1, token, 1))
        info = run(c.renew_lan())                                              # a new code: off then on
        self.assertNotEqual(c.lan_token, token)
        self.assertTrue(self.servers[0].closed)
        self.assertEqual((len(self.servers), info["url"], len(self.told)), (2, c.lan_url, 2))   # (told once)
        self.assertEqual(self.lan("GET", f"/api/state?t={token}")[0], 403)    # the old QR code is dead
        self.assertEqual(self.lan("GET", f"/api/state?t={c.lan_token}")[0], 200)
        info = run(c.set_lan(False))
        self.assertEqual(info, {"on": False, "url": None, "ip": None, "phones": 0, "error": None})
        self.assertTrue(self.servers[1].closed)
        self.assertIsNone(c.lan_token)
        self.assertEqual(len(self.told), 3)
        self.assertEqual(self.told[-1]["on"], False)
        run(c.set_lan(False))                                                  # (already off: nothing told)
        self.assertEqual(len(self.told), 3)
        self.assertEqual(self.lan("GET", "/")[0], 421)                         # off: nothing is ours any more

    def test_on_fails(self):
        c = self.c

        def none():
            raise companion.LanError("no local network address found")
        c.lan_address = none
        info = run(c.set_lan(True))
        self.assertEqual(info, {"on": False, "url": None, "ip": None, "phones": 0,
                                "error": "no local network address found"})
        self.assertEqual((self.servers, self.told), ([], []))
        c.lan_address = lambda: "127.0.0.1"         # (an injected address still has to be private)
        self.assertIn("127.0.0.1 is a loopback address", run(c.set_lan(True))["error"])

        async def taken(handler, host, port, limit=None):
            raise OSError(10048, "Only one usage of each socket address is normally permitted")
        c.lan_address = lambda: LAN_IP
        with mock.patch.object(companion.asyncio, "start_server", taken):
            info = run(c.set_lan(True))
        self.assertEqual((info["on"], info["error"]),
                         (False, f"cannot listen on {LAN_IP}:{PORT}: Only one usage of each socket address is "
                                 "normally permitted"))
        self.assertTrue(self.on())
        self.assertIsNone(c.lan_info()["error"])    # (cleared once it worked)
        c.port = None                               # (the live map itself not started: nothing to share)
        c._lan_off()
        self.assertEqual(run(c.set_lan(True))["error"], "the live map is off")

    def test_close_turns_it_off(self):
        self.on()
        self.c.close()
        self.assertTrue(self.servers[0].closed)
        self.assertEqual(self.c.lan_info()["on"], False)
        self.assertIn("off", run(self.c.set_lan(True))["error"])     # (the server stopping: never on again)

    def test_peer_must_be_private(self):
        token = self.on()
        for peer in ("8.8.8.8", "127.0.0.1", "169.254.9.9", "::1", None, "100.64.1.1"):
            self.assertIs(self.lan("GET", f"/api/state?t={token}", peer=peer), companion.CLOSED, peer)
            self.assertIs(self.lan("GET", "/", peer=peer), companion.CLOSED, peer)
        for peer in ("192.168.1.50", "10.1.2.3", "172.16.4.4", LAN_IP):    # (the PC itself over its LAN address)
            self.assertEqual(self.lan("GET", f"/api/state?t={token}", peer=peer)[0], 200, peer)

    def test_host(self):
        token = self.on()
        for host in (HOST, {"host": f"localhost:{PORT}"}, {"host": f"{LAN_IP}:1"}, {"host": "evil.example:47616"},
                     {}, {"host": f"192.168.1.24:{PORT}"}):
            self.assertEqual(self.lan("GET", f"/api/state?t={token}", headers=host)[0], 421, host)
            self.assertEqual(self.lan("GET", "/", headers=host)[0], 421, host)
        self.assertEqual(run(self.c.respond("GET", f"/api/state?t={TOKEN}", dict(LAN_HOST)))[0], 421)  # (loopback)

    def test_tokens_kept_apart(self):
        token = self.on()
        self.assertEqual(self.lan("GET", f"/api/state?t={token}")[0], 200)
        self.assertEqual(self.lan("GET", f"/api/state?t={TOKEN}")[0], 403)                 # the PC's: not here
        self.assertEqual(run(self.c.respond("GET", f"/api/state?t={token}", dict(HOST)))[0], 403)   # nor there
        self.assertEqual(run(self.c.respond("GET", f"/api/state?t={TOKEN}", dict(HOST)))[0], 200)
        self.assertEqual(self.lan("POST", "/api/cmd", TOKEN, body=b'{"action":"clear_gps"}')[0], 403)
        self.c.set_connected(True)
        r = self.lan("POST", "/api/cmd", token, body=b'{"action":"autodrive","on":true}')     # the phone drives
        self.assertEqual((r[0], body_of(r)), (200, {"ok": True}))
        self.assertEqual(self.sent, [{"action": "autodrive", "on": True}])
        self.assertEqual(self.lan("POST", f"/api/cmd?t={token}", body=b'{"action":"clear_gps"}')[0], 403)
        self.assertEqual(self.lan("GET", f"/api/search?t={token}&q=abc")[0], 200)
        self.assertEqual(self.lan("GET", "/index.html")[0], 404)       # the page's files need no token (none here)

    def test_pc_only(self):
        token = self.on()
        for method, path, body in (("POST", "/api/key", json.dumps({"key": KEY}).encode()),
                                   ("GET", f"/api/key?t={token}", b""), ("GET", f"/api/lan?t={token}", b""),
                                   ("POST", "/api/lan", b'{"on": false}'), ("POST", "/api/lan", b'{"renew": true}')):
            r = self.lan(method, path, token if method == "POST" else None, body=body)
            self.assertEqual((r[0], body_of(r)), (403, {"ok": False, "error": "only on the PC"}), path)
        self.assertEqual((self.c.api_key, self.c.lan_token), ("", token))       # nothing stored, nothing renewed
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "google_maps_key.txt")))
        r = self.lan("POST", "/api/key", TOKEN, body=json.dumps({"key": KEY}).encode())    # (the token first)
        self.assertEqual(body_of(r)["error"], "wrong or missing token")

    def test_wrong_tokens_429(self):
        c = self.c
        token = self.on()
        for i in range(20):                                 # 20 wrong ones in 60 s: still only 403s
            self.assertEqual(self.lan("GET", f"/api/state?t=guess{i}")[0], 403, i)
            self.now += 2.9
        r = self.lan("GET", "/api/state?t=guess21")         # the 21st within 60 s: blocked
        self.assertEqual((r[0], body_of(r)["ok"]), (429, False))
        self.assertEqual(self.lan("GET", f"/api/state?t={token}")[0], 429)     # everything, the right code too
        self.assertEqual(self.lan("GET", "/")[0], 429)
        self.assertEqual(self.lan("GET", f"/api/state?t={token}", peer="192.168.1.51")[0], 200)  # (only that peer)
        self.assertEqual(run(c.respond("GET", f"/api/state?t={TOKEN}", dict(HOST)))[0], 200)  # (and not the PC)
        self.now += 59.0
        self.assertEqual(self.lan("GET", f"/api/state?t={token}")[0], 429)
        self.now += 1.01                                    # 60 s on: served again, counting from nothing
        self.assertEqual(self.lan("GET", f"/api/state?t={token}")[0], 200)
        self.assertEqual(self.lan("GET", "/api/state?t=again")[0], 403)
        self.assertEqual((c._blocked, list(c._wrong)), ({}, [PHONE]))           # (the old block forgotten)
        # spread out: 20 a minute for ever never blocks (the window slides)
        for i in range(60):
            self.now += 3.01
            self.assertEqual(self.lan("GET", f"/api/state?t=slow{i}", peer="10.0.0.9")[0], 403, i)
        # the wrong-token table is bounded (many peers on a /8)
        with mock.patch.object(companion, "WRONG_PEERS_MAX", 5):
            for i in range(9):
                self.lan("GET", "/api/state?t=x", peer=f"10.9.0.{i}")
            self.assertLessEqual(len(c._wrong), 5)
        # the static files and wrong hosts do not count, only wrong tokens
        for _ in range(30):
            self.lan("GET", "/app.js")
            self.lan("GET", f"/api/state?t={token}", headers={"host": "x:1"}, peer="10.0.0.77")
        self.assertEqual(self.lan("GET", f"/api/state?t={token}")[0], 200)
        self.assertEqual(self.lan("GET", f"/api/state?t={token}", peer="10.0.0.77")[0], 200)

    def test_api_lan_on_the_pc(self):
        c = self.c
        r = run(c.respond("GET", f"/api/lan?t={TOKEN}", dict(HOST)))
        self.assertEqual((r[0], body_of(r)), (200, {"on": False, "url": None, "ip": None, "phones": 0, "error": None}))
        self.assertEqual(run(c.respond("GET", "/api/lan?t=wrong", dict(HOST)))[0], 403)
        r = self.pc_post("/api/lan", {"on": True})
        self.assertEqual((r[0], body_of(r)), (200, c.lan_info()))
        self.assertTrue(body_of(r)["url"].startswith(f"http://{LAN_IP}:{PORT}/?t="))
        self.assertEqual(c.state()["lan"]["on"], True)
        old = c.lan_token
        r = self.pc_post("/api/lan", {"renew": True})
        self.assertEqual((r[0], body_of(r)["on"]), (200, True))
        self.assertNotEqual(c.lan_token, old)
        self.assertEqual(body_of(r)["url"], c.lan_url)
        for bad in ({}, {"on": "yes"}, {"renew": 1}, None):
            self.assertEqual(self.pc_post("/api/lan", bad)[0], 400, bad)
        r = self.pc_post("/api/lan", {"on": False})
        self.assertEqual((r[0], body_of(r)["on"], c.state()["lan"]), (200, False, {"on": False, "phones": 0}))
        self.assertEqual([t["on"] for t in self.told], [True, True, False])    # on, renewed, off
        h = dict(HOST)                                      # POST: the header token only (as /api/cmd)
        self.assertEqual(run(c.respond("POST", f"/api/lan?t={TOKEN}", h, b'{"on": true}'))[0], 403)
        self.assertFalse(c.lan_on)

    def test_phones_count_and_end(self):
        """A phone's event stream counts in state.lan.phones (and is told); turning it off ends it at once."""
        c = self.c
        self.on()
        changes = len(self.told)

        async def body():
            pc, phone = companion._Stream(False), companion._Stream(False, phone=True)
            c._streams |= {pc, phone}
            c._lan_changed()
            self.assertEqual(c.state()["lan"], {"on": True, "phones": 1})
            self.assertEqual(self.told[-1]["phones"], 1)
            self.assertTrue(pc.state and pc.wake.is_set())   # (the PC's page shows the count: a state change)
            c._lan_changed()                                 # (nothing new: not told again)
            self.assertEqual(len(self.told), changes + 1)
            await c.set_lan(False)
            self.assertTrue(phone.ended and phone.wake.is_set())
            self.assertFalse(pc.ended)
            self.assertEqual((c.phones(), c.streams()), (0, 1))
            self.assertEqual((self.told[-1]["on"], self.told[-1]["phones"]), (False, 0))
            self.assertEqual(len(self.told), changes + 2)    # (one change: off and the phones gone together)
        run(body())

    def test_on_lan_change_failure_is_logged(self):
        def boom():
            raise ConnectionResetError("gone")
        self.c.on_lan_change = boom
        with self.assertLogs("earthd.companion", "ERROR"):
            self.assertTrue(run(self.c.set_lan(True))["on"])


class QrCodeCopyTest(unittest.TestCase):
    def test_byte_identical_to_the_mods(self):
        root = Path(__file__).resolve().parents[2]
        ours = (root / "server" / "companion_web" / "qrcode.js").read_bytes()
        mods = (root / "mod" / "beamng_earth" / "ui" / "ui-vue" / "mods" / "beamngEarth" / "qrcode.js").read_bytes()
        self.assertEqual(ours, mods, "server/companion_web/qrcode.js must be a byte-identical copy of the mod's")
        self.assertEqual(companion.STATIC["/qrcode.js"], ("qrcode.js", "text/javascript; charset=utf-8"))
        c = companion.Companion(tempfile.gettempdir(), token=TOKEN)
        c.port = PORT
        st, ctype, body = run(c.respond("GET", "/qrcode.js", dict(HOST)))
        self.assertEqual((st, ctype, body), (200, "text/javascript; charset=utf-8", ours))


class Http:
    """A raw HTTP/1.1 client over asyncio streams (one request per connection, as the endpoint)."""

    def __init__(self, port):
        self.port = port

    async def request(self, method, target, headers=None, body=b"", host=None):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        h = {"Host": host or f"127.0.0.1:{self.port}", **(headers or {})}
        if method == "POST":
            h.setdefault("Content-Length", str(len(body)))
        w.write((f"{method} {target} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in h.items()) + "\r\n")
                .encode() + body)
        await w.drain()
        data = await asyncio.wait_for(r.read(), 10)
        w.close()
        head, _, rest = data.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        hdrs = {k.lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:])}
        return int(lines[0].split()[1]), hdrs, rest

    async def stream(self, token=TOKEN):
        """An open /api/events stream: (reader, writer, status line)."""
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(f"GET /api/events?t={token} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        await w.drain()
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 5)
        return r, w, head.decode("latin-1")


async def read_events(reader, until_s):
    """The events of a stream for until_s seconds: [(event name or ": ping", data)]."""
    out, buf = [], b""
    end = time.monotonic() + until_s
    while time.monotonic() < end:
        try:
            buf += await asyncio.wait_for(reader.read(65536), max(0.01, end - time.monotonic()))
        except asyncio.TimeoutError:
            break
        while b"\n\n" in buf:
            block, buf = buf.split(b"\n\n", 1)
            lines = block.decode("utf-8").split("\n")
            if lines[0].startswith(":"):
                out.append((lines[0], None))
                continue
            ev = dict(ln.split(": ", 1) for ln in lines if ": " in ln)
            if "event" in ev:
                out.append((ev["event"], json.loads(ev["data"])))
    return out


class SocketTest(unittest.TestCase):
    """The endpoint on a real socket (any free port)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sent = []

    def tearDown(self):
        self.tmp.cleanup()

    def serve(self, body):
        """Run body(companion, Http) against a started endpoint."""
        async def main():
            c = companion.Companion(self.tmp.name, os.path.join(self.tmp.name, "web"), token=TOKEN,
                                    send_cmd=lambda cmd: self.sent.append(cmd) or True)
            srv, port = await c.start(0)
            self.assertEqual(port, c.port)
            try:
                return await body(c, Http(port))
            finally:
                c.close()
                srv.close()
                await asyncio.sleep(0.05)
        return run(main())

    def test_requests(self):
        async def body(c, http):
            st, h, data = await http.request("GET", f"/api/state?t={TOKEN}")
            self.assertEqual(st, 200)
            self.assertEqual(json.loads(data), c.state())
            self.assertEqual(h["cache-control"], "no-store")
            self.assertEqual(h["content-length"], str(len(data)))
            self.assertFalse([k for k in h if k.startswith("access-control")])
            st, h, _ = await http.request("GET", "/index.html")
            self.assertEqual((st, h["cache-control"]), (404, "no-store"))
            self.assertEqual((await http.request("GET", f"/api/state?t={TOKEN}", host="rebound.example:1"))[0], 421)
            self.assertEqual((await http.request("GET", "/api/state?t=bad"))[0], 403)
            big = b'{"action": "clear_gps", "pad": "' + b"x" * 5000 + b'"}'
            self.assertEqual((await http.request("POST", "/api/cmd", {"X-BNE-Token": TOKEN}, big))[0], 413)
            self.assertEqual((await http.request("POST", "/api/cmd", {"X-BNE-Token": TOKEN, "Transfer-Encoding":
                                                                      "chunked"}, b""))[0], 411)
            c.set_connected(True)
            st, _, data = await http.request("POST", "/api/cmd", {"X-BNE-Token": TOKEN},
                                             b'{"action": "autodrive", "on": true}')
            self.assertEqual((st, json.loads(data)), (200, {"ok": True}))
            self.assertEqual(self.sent, [{"action": "autodrive", "on": True}])
            st, h, data = await http.request("HEAD", f"/api/state?t={TOKEN}")
            self.assertEqual((st, data), (200, b""))
            # not HTTP at all: 400, the endpoint keeps serving
            r, w = await asyncio.open_connection("127.0.0.1", c.port)
            w.write(b"hello there\r\n\r\n")
            self.assertTrue((await asyncio.wait_for(r.read(), 5)).startswith(b"HTTP/1.1 400"))
            w.close()
            self.assertEqual((await http.request("GET", f"/api/state?t={TOKEN}"))[0], 200)
        self.serve(body)

    def test_events_framing_route_and_coalescing(self):
        async def body(c, http):
            c.set_route([[50, 19], [50.1, 19.1]])
            r, w, head = await http.stream()
            self.assertTrue(head.startswith("HTTP/1.1 200 OK\r\n"), head)
            self.assertIn("Content-Type: text/event-stream; charset=utf-8\r\n", head)
            self.assertIn("Cache-Control: no-store\r\n", head)
            self.assertNotIn("Access-Control", head)
            first = await read_events(r, 0.3)
            self.assertEqual([e for e, _ in first], ["route", "state"])        # at once: the route and the state
            self.assertEqual(first[0][1], {"version": 1, "points": [[50, 19], [50.1, 19.1]]})
            self.assertEqual(first[1][1], c.state())
            self.assertEqual(c.streams(), 1)
            # 40 poses in ~0.4 s: at most ~4 state events a second, the last one the newest pose
            t0 = time.monotonic()
            for i in range(40):
                c.update_pose(50 + i * 1e-4, 19, 0, 10, 10)
                await asyncio.sleep(0.01)
            got = await read_events(r, 0.6)
            states = [d for e, d in got if e == "state"]
            span = time.monotonic() - t0
            self.assertGreaterEqual(len(states), 1)
            self.assertLessEqual(len(states), int(span / companion.STATE_GAP_S) + 2, (len(states), span))
            self.assertAlmostEqual(states[-1]["player"]["lat"], 50 + 39e-4, places=6)
            self.assertEqual(states[-1]["player"]["heading"], 0.0)
            c.set_route([])                             # cleared: points []
            got = await read_events(r, 0.4)
            self.assertIn(("route", {"version": 2, "points": []}), got)
            self.assertEqual([d["routeVersion"] for e, d in got if e == "state"][-1:], [2])
            w.close()
            for _ in range(50):                         # the browser went: the stream is gone
                if c.streams() == 0:
                    break
                await asyncio.sleep(0.02)
            self.assertEqual(c.streams(), 0)
        self.serve(body)

    def test_events_ping_no_route_and_cap(self):
        async def body(c, http):
            c.ping_s = 0.2
            r, w, _ = await http.stream()
            got = await read_events(r, 0.75)
            self.assertEqual(got[0][0], "state")                    # (no route: no route event)
            self.assertNotIn("route", [e for e, _ in got])
            self.assertGreaterEqual(sum(1 for e, _ in got if e == ": ping"), 2)
            more = [await http.stream() for _ in range(companion.MAX_STREAMS - 1)]
            self.assertEqual(c.streams(), companion.MAX_STREAMS)
            st, _, data = await http.request("GET", f"/api/events?t={TOKEN}")
            self.assertEqual(st, 503)
            self.assertFalse(json.loads(data)["ok"])
            st, _, _ = await http.request("GET", "/api/events?t=bad")
            self.assertEqual(st, 403)
            for _, w2, _ in more:
                w2.close()
            w.close()
            for _ in range(50):
                if c.streams() == 0:
                    break
                await asyncio.sleep(0.02)
            self.assertEqual(c.streams(), 0)
            r, w, head = await http.stream()                        # room again
            self.assertIn(" 200 ", head.split("\r\n")[0])
            c.close()                                               # the server's end: the stream ends
            await asyncio.wait_for(r.read(), 5)                     # (to its end: no timeout)
            w.close()
        self.serve(body)

    def test_port_in_use(self):
        async def main():
            a = companion.Companion(self.tmp.name)
            srv, port = await a.start(0)
            try:
                with self.assertRaises(OSError):
                    await companion.Companion(self.tmp.name).start(port)
            finally:
                srv.close()
        run(main())


def free_port():
    with companion.socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LanSocketTest(unittest.TestCase):
    """The phone sharing's listener on a real socket. The private-only rule refuses 127.0.0.1 (as the LAN address and
    as a peer), so these tests serve the "LAN" on 127.0.0.1 through the test hook (Companion.is_lan) and without the
    loopback listener (the same port on the same address would collide); the rule itself is tried at the end."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_listener(self):
        async def main():
            told = []
            c = companion.Companion(self.tmp.name, os.path.join(self.tmp.name, "web"), token=TOKEN,
                                    on_lan_change=lambda: told.append(c.lan_info()))
            c.port = free_port()
            c.lan_address = lambda: "127.0.0.1"
            c.is_lan = lambda ip: True
            http = Http(c.port)
            try:
                info = await c.set_lan(True)
                self.assertTrue(info["on"], info)
                self.assertEqual(info["url"], f"http://127.0.0.1:{c.port}/?t={c.lan_token}")
                token = c.lan_token
                st, _, data = await http.request("GET", f"/api/state?t={token}")
                self.assertEqual((st, json.loads(data)["lan"]), (200, {"on": True, "phones": 0}))
                self.assertEqual((await http.request("GET", f"/api/state?t={TOKEN}"))[0], 403)     # (the PC's)
                st, _, data = await http.request("POST", "/api/key", {"X-BNE-Token": token}, b'{"key": ""}')
                self.assertEqual((st, json.loads(data)["error"]), (403, "only on the PC"))
                # a phone's event stream: counted, told, in every state
                r, w, head = await http.stream(token)
                self.assertIn(" 200 ", head.split("\r\n")[0])
                first = await read_events(r, 0.3)
                self.assertEqual(first[-1], ("state", c.state()))
                self.assertEqual(c.state()["lan"], {"on": True, "phones": 1})
                self.assertEqual((told[-1]["on"], told[-1]["phones"]), (True, 1))
                # Stop sharing: the stream ends, nothing listens, the code is dead
                lan_srv = c._lan_srv
                await c.set_lan(False)
                await asyncio.wait_for(r.read(), 5)     # the stream ends (read to its end: no timeout)
                w.close()
                self.assertEqual((told[-1]["on"], told[-1]["phones"], c.phones()), (False, 0, 0))
                self.assertFalse(lan_srv.is_serving())
                # on again: a new code; the old one is refused
                await c.set_lan(True)
                self.assertNotEqual(c.lan_token, token)
                self.assertEqual((await http.request("GET", f"/api/state?t={token}"))[0], 403)
                self.assertEqual((await http.request("GET", f"/api/state?t={c.lan_token}"))[0], 200)
                # the rule for real: a loopback peer is not on the local network: closed without an answer
                c.is_lan = companion.is_lan
                rr, ww = await asyncio.open_connection("127.0.0.1", c.port)
                ww.write(f"GET /api/state?t={c.lan_token} HTTP/1.1\r\nHost: 127.0.0.1:{c.port}\r\n\r\n".encode())
                await ww.drain()
                try:
                    got = await asyncio.wait_for(rr.read(), 5)
                except ConnectionResetError:        # (Windows: the unread request makes the close a reset)
                    got = b""
                self.assertEqual(got, b"")
                ww.close()
                await c.set_lan(False)
                info = await c.set_lan(True)            # ... nor a LAN address to serve on
                self.assertEqual((info["on"], info["error"]),
                                 (False, "no local network address found (127.0.0.1 is a loopback address)"))
            finally:
                c.close()
                await asyncio.sleep(0.05)
        run(main())

    def test_port_taken_on_that_address(self):
        async def main():
            c = companion.Companion(self.tmp.name, token=TOKEN)
            srv, port = await c.start(0)                # (127.0.0.1:port is taken: by the loopback listener)
            c.lan_address = lambda: "127.0.0.1"
            c.is_lan = lambda ip: True
            try:
                info = await c.set_lan(True)
                self.assertFalse(info["on"])
                self.assertTrue(info["error"].startswith(f"cannot listen on 127.0.0.1:{port}: "), info["error"])
                self.assertNotIn("attempting to bind", info["error"])
                self.assertIsNone(c.lan_token)
            finally:
                c.close()
                srv.close()
        run(main())


try:
    import test_server
except ImportError as e:                            # (the server's packages missing: the glue cannot be tried)
    test_server = None
    _why = str(e)


@unittest.skipIf(test_server is None, "earthd not importable")
class EarthdGlueTest(test_server.ServerHarness if test_server is not None else unittest.TestCase):
    """earthd with a Companion: gps_state marks the game's connection, its poses / routes / going reach the state,
    a command from the page reaches the mod as remote_cmd, hello is followed by companion {port}, companion_lan is
    answered with companion_lan_state (and a change goes to the game's connection)."""

    def setUp(self):
        super().setUp()
        import earthd
        self.earthd = earthd
        self.comp = companion.Companion(self.tmp.name, search=self.server.companion_search,
                                        send_cmd=self.server.companion_cmd,
                                        on_lan_change=self.server.companion_lan_push)
        self.comp.port = 47699
        self.server.companion = self.comp

    def wait(self, pred, timeout=5):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if pred():
                return True
            time.sleep(0.02)
        return pred()

    def on_loop(self, fn, *a):
        return asyncio.run_coroutine_threadsafe(self._call(fn, *a), self.loop).result(5)

    @staticmethod
    async def _call(fn, *a):
        return fn(*a)

    def test_glue(self):
        self.c.send({"type": "hello", "protocol": 4, "format": self.MOD_FORMAT, "modVersion": "0.4.0"})
        m, seen = self.c.until(lambda m: m["type"] == "companion", 10)
        self.assertEqual(m, {"type": "companion", "port": 47699})
        self.assertIn("hello", [x["type"] for x in seen])
        # no gps_state yet: not the game's, no command goes anywhere
        self.assertFalse(self.on_loop(self.server.companion_cmd, {"action": "clear_gps"}))
        self.c.send({"type": "pose", "anchorId": 99, "x": 0, "y": 0, "z": 0, "vx": 0, "vy": 0, "lat": 1.0,
                     "lon": 2.0, "speed": 0})
        self.c.send({"type": "gps_state", "active": True, "lat": 52.23, "lon": 21.01, "name": "Warsaw",
                     "autodrive": False, "remaining": 1000, "eta": 60})
        self.assertTrue(self.wait(lambda: self.comp.connected))
        self.assertIs(self.server.companion_conn, self.conn())
        self.assertIsNone(self.comp.player)             # (the pose before it: not the game's yet)
        self.assertEqual(self.comp.gps["name"], "Warsaw")
        self.c.send({"type": "pose", "anchorId": 99, "x": 0, "y": 0, "z": 0, "vx": 5.0, "vy": 0, "lat": 50.06,
                     "lon": 19.94, "speed": 5.0})
        self.assertTrue(self.wait(lambda: self.comp.player is not None))
        self.assertEqual((self.comp.player["lat"], self.comp.player["heading"], self.comp.player["speed"]),
                         (50.06, 90.0, 5.0))
        # a command from the page
        self.assertTrue(self.on_loop(self.server.companion_cmd, {"action": "teleport", "lat": 1.5, "lon": 2.5}))
        m, _ = self.c.until(lambda m: m["type"] == "remote_cmd", 5)
        self.assertEqual(m, {"type": "remote_cmd", "action": "teleport", "lat": 1.5, "lon": 2.5})
        # a planned route becomes the page's
        plan = {"points": [[50.06, 19.94], [52.23, 21.01]], "dist": 250000.0, "dur": 9000.0}
        with mock.patch.object(self.earthd.routingmod, "plan", return_value=plan):
            self.c.send({"type": "route", "id": 1, "lat0": 50.06, "lon0": 19.94, "lat1": 52.23, "lon1": 21.01,
                         "download": "off"})
            self.c.until(lambda m: m["type"] == "route_result", 10)
        self.assertTrue(self.wait(lambda: self.comp.route_version == 1))
        self.assertEqual(self.comp.route, [[50.06, 19.94], [52.23, 21.01]])
        self.c.send({"type": "gps_state", "active": False})
        self.assertTrue(self.wait(lambda: self.comp.gps is None))
        # the Live map button: the page's URL (with its token) in the browser
        with mock.patch.object(self.earthd.updatesmod, "open_companion", return_value=True) as opened:
            self.c.send({"type": "open_companion"})
            self.assertTrue(self.wait(lambda: opened.called))
        opened.assert_called_once_with(self.comp.url)
        # the game goes
        self.c.close()
        self.assertTrue(self.wait(lambda: not self.comp.connected))
        self.assertIsNone(self.server.companion_conn)
        self.assertEqual((self.comp.route, self.comp.gps), ([], None))
        self.assertFalse(self.on_loop(self.server.companion_cmd, {"action": "clear_gps"}))
        self.c = test_server.Client(self.srv.sockets[0].getsockname()[1])     # (tearDown closes one)

    def test_lan(self):
        """companion_lan (the world map's Phone dialog) is answered with companion_lan_state; a change made elsewhere
        (the PC's page) goes to the game's connection; without the live map the answer says so."""
        comp = self.comp
        comp.port = free_port()
        comp.lan_address = lambda: "127.0.0.1"          # (LanSocketTest: the "LAN" on 127.0.0.1 via the test hook)
        comp.is_lan = lambda ip: True
        self.c.send({"type": "hello", "protocol": 4, "format": self.MOD_FORMAT, "modVersion": "0.4.0"})
        self.c.until(lambda m: m["type"] == "companion", 10)
        try:
            self.c.send({"type": "companion_lan", "on": True})
            m, _ = self.c.until(lambda m: m["type"] == "companion_lan_state", 10)
            self.assertEqual(m, {"type": "companion_lan_state", "on": True, "url": comp.lan_url, "phones": 0,
                                 "error": None})
            old = m["url"]
            self.assertTrue(old.startswith(f"http://127.0.0.1:{comp.port}/?t="))
            self.c.send({"type": "companion_lan", "on": True, "renew": True})          # New code
            m, _ = self.c.until(lambda m: m["type"] == "companion_lan_state", 10)
            self.assertEqual((m["on"], m["url"]), (True, comp.lan_url))
            self.assertNotEqual(m["url"], old)
            # the game's connection (gps_state) is told when the PC's page stops the sharing
            self.c.send({"type": "gps_state", "active": False})
            self.assertTrue(self.wait(lambda: self.server.companion_conn is self.conn()))
            asyncio.run_coroutine_threadsafe(comp.set_lan(False), self.loop).result(5)
            m, _ = self.c.until(lambda m: m["type"] == "companion_lan_state", 10)
            self.assertEqual(m, {"type": "companion_lan_state", "on": False, "url": None, "phones": 0,
                                 "error": None})
            self.c.send({"type": "companion_lan", "on": False})                         # Stop (already off)
            m, _ = self.c.until(lambda m: m["type"] == "companion_lan_state", 10)
            self.assertFalse(m["on"])
        finally:
            asyncio.run_coroutine_threadsafe(comp.set_lan(False), self.loop).result(5)
        self.server.companion = None                    # --companion-port 0
        self.c.send({"type": "companion_lan", "on": True})
        m, _ = self.c.until(lambda m: m["type"] == "companion_lan_state", 10)
        self.assertEqual(m, {"type": "companion_lan_state", "on": False, "url": None, "phones": 0,
                             "error": "the live map is off (--companion-port 0)"})

    def test_search_callback(self):
        got = []

        def search(q, lat, lon, net, country):
            got.append((q, lat, lon, country))
            return [{"name": "A", "detail": "", "lat": 1, "lon": 2}]
        with mock.patch.object(self.earthd.geocodemod, "search", search), \
                mock.patch.object(self.server, "country_at", lambda lat, lon: "PL"):
            self.assertEqual(self.server.companion_search("abc", 50.0, 19.0)[0]["name"], "A")
            self.server.companion_search("abc", None, None)
        self.assertEqual(got, [("abc", 50.0, 19.0, "PL"), ("abc", None, None, None)])

        def offline(*a):
            raise self.earthd.netfetch.Offline("offline")
        with mock.patch.object(self.earthd.geocodemod, "search", offline):
            with self.assertRaises(companion.SearchError) as cm:
                self.server.companion_search("abc", 1, 2)
        self.assertIn("offline", str(cm.exception))


class OpenCompanionTest(unittest.TestCase):
    """updates.open_companion: the live map's own URL only, launched as open_page launches its pages."""

    def test_only_our_page(self):
        import updates
        calls = []
        url = f"http://127.0.0.1:{PORT}/?t={TOKEN}"
        with mock.patch.object(updates.os, "startfile", create=True) as startfile:
            self.assertTrue(updates.open_companion(url, popen=lambda *a, **k: calls.append(a)))
            if updates.sys.platform == "win32":
                startfile.assert_called_once_with(url)
            for bad in (None, "", f"http://localhost:{PORT}/?t={TOKEN}", f"https://127.0.0.1:{PORT}/?t={TOKEN}",
                        f"http://127.0.0.1:{PORT}/?t={TOKEN}&x=1", f"http://127.0.0.1:{PORT}/?t=a b",
                        f"http://127.0.0.1:{PORT}/evil?t={TOKEN}", f"http://127.0.0.1.evil.example/?t={TOKEN}",
                        f"http://127.0.0.1:{PORT}/?t={TOKEN}\n"):
                self.assertFalse(updates.open_companion(bad, popen=lambda *a, **k: calls.append(a)), bad)
            if updates.sys.platform == "win32":
                self.assertEqual(startfile.call_count, 1)
        if updates.sys.platform != "win32":
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0][-1], url)
        self.assertFalse(updates.open_page(url))        # (open_page's allowlist is unchanged)


if __name__ == "__main__":
    unittest.main()

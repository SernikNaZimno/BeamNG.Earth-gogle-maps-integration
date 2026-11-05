"""maplinks: Google Maps share links (maps.app.goo.gl) resolved to the long link the map reads its point from."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import maplinks  # noqa: E402
import netfetch  # noqa: E402
import updates  # noqa: E402

LONG = "https://www.google.com/maps/place/Stonehenge/@51.1788823,-1.8284037,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d51.1788823!4d-1.8262150"


class Transport:
    """Answers per exact URL (status, headers, body); logs the URLs asked."""

    def __init__(self, answers):
        self.answers, self.urls = answers, []

    def request(self, url, headers, timeout):
        self.urls.append(url)
        return self.answers.get(url, (404, {}, b""))


class Clock:
    """A fake clock (the short hosts' token bucket waits on it, not in real time)."""
    now = 1.8e9

    def __call__(self):
        return self.now

    def sleep(self, s):
        self.now += max(0.0, s)


def fetcher(answers):
    tr, clock = Transport(answers), Clock()
    return netfetch.Fetcher(transport=tr, clock=clock, sleep=clock.sleep, wall=clock), tr


class KindsTest(unittest.TestCase):
    def test_short(self):
        for u in ("https://maps.app.goo.gl/AbCd123", "https://maps.app.goo.gl/AbCd123?g_st=ic",
                  "https://goo.gl/maps/xyz", " https://maps.app.goo.gl/AbCd123 "):
            self.assertTrue(maplinks.is_short(u), u)
        for u in ("https://maps.app.goo.gl/", "https://goo.gl/xyz", "https://goo.gl/maps/", "ftp://maps.app.goo.gl/x",
                  "https://maps.app.goo.gl.evil.example/x", "https://evil.example/maps.app.goo.gl/x",
                  'https://maps.app.goo.gl/x"y', None, 5, "https://maps.app.goo.gl/" + "a" * 3000,
                  "http://maps.app.goo.gl/AbCd123?g_st=ic", "http://goo.gl/maps/xyz", "https://maps.app.goo.gl:443/x",
                  "https://maps.app.goo.gl:8443/x", "https://goo.gl:99999/maps/x", "https://maps.app.goo.gl:x/y"):
            self.assertFalse(maplinks.is_short(u), u)

    def test_long(self):
        for u in (LONG, "https://www.google.com/maps/@40.55,-105.07,15z", "https://maps.google.com/?q=63.768,-18.133",
                  "https://www.google.pl/maps/place/Krak%C3%B3w", "https://google.co.uk/maps/search/x",
                  "https://www.google.com.au/maps", "https://www.google.com/maps?q=Big+Ben&ftid=0x1:0x2"):
            self.assertTrue(maplinks.is_long(u), u)
        for u in ("https://www.google.com/search?q=maps", "https://www.google.evil.example/maps/x",
                  "https://evilgoogle.com/maps/x", "https://www.google.com/mapsx", "https://maps.app.goo.gl/x",
                  "https://www.google.com:8080/maps/x", "https://www.google.com:bad/maps/x"):
            self.assertFalse(maplinks.is_long(u), u)
        self.assertTrue(maplinks.is_long("http://www.google.com/maps/@1,2,3z"), "only read, never fetched")


class ResolveTest(unittest.TestCase):
    def test_one_redirect(self):
        net, tr = fetcher({"https://maps.app.goo.gl/AbCd": (302, {"Location": LONG}, b"")})
        self.assertEqual(maplinks.resolve("https://maps.app.goo.gl/AbCd", net), LONG)
        self.assertEqual(tr.urls, ["https://maps.app.goo.gl/AbCd"], "the long link itself is not fetched")

    def test_chain_and_consent(self):
        consent = "https://consent.google.com/ml?continue=" + LONG.replace(":", "%3A").replace("/", "%2F") + "&gl=PL"
        net, tr = fetcher({"https://goo.gl/maps/old": (301, {"Location": "https://maps.app.goo.gl/New"}, b""),
                           "https://maps.app.goo.gl/New": (302, {"Location": consent}, b"")})
        self.assertEqual(maplinks.resolve("https://goo.gl/maps/old", net), LONG)
        self.assertEqual(len(tr.urls), 2, "consent.google.com is read, not asked")

    def test_a_long_link_comes_back(self):
        net, tr = fetcher({})
        self.assertEqual(maplinks.resolve(LONG, net), LONG)
        self.assertEqual(tr.urls, [])

    def test_refused(self):
        net, tr = fetcher({"https://maps.app.goo.gl/Loop": (302, {"Location": "https://maps.app.goo.gl/Loop"}, b""),
                           "https://maps.app.goo.gl/Away": (302, {"Location": "https://evil.example/"}, b""),
                           "https://maps.app.goo.gl/Page": (200, {}, b"<html></html>")})
        for u in ("https://evil.example/x", "https://maps.app.goo.gl/Loop", "https://maps.app.goo.gl/Away",
                  "https://maps.app.goo.gl/Page"):
            with self.assertRaises(maplinks.LinkError, msg=u):
                maplinks.resolve(u, net)
        self.assertNotIn("https://evil.example/", tr.urls, "a redirect off the short hosts is never followed")
        with self.assertRaises(netfetch.NotFound):
            maplinks.resolve("https://maps.app.goo.gl/Gone", net)

    def test_hop_limit(self):
        chain = {f"https://maps.app.goo.gl/H{i}": (302, {"Location": f"https://maps.app.goo.gl/H{i + 1}"}, b"")
                 for i in range(5)}
        chain["https://maps.app.goo.gl/H5"] = (302, {"Location": LONG}, b"")
        net, tr = fetcher(chain)
        with self.assertRaises(maplinks.LinkError):
            maplinks.resolve("https://maps.app.goo.gl/H0", net)
        self.assertEqual(tr.urls, [f"https://maps.app.goo.gl/H{i}" for i in range(maplinks.MAX_HOPS)])
        # four GETs are enough, a consent link between them not counted
        consent = "https://consent.google.com/ml?continue=https%3A%2F%2Fmaps.app.goo.gl%2FH2"
        chain["https://maps.app.goo.gl/H1"] = (302, {"Location": consent}, b"")
        chain["https://maps.app.goo.gl/H3"] = (302, {"Location": LONG}, b"")
        net, tr = fetcher(chain)
        self.assertEqual(maplinks.resolve("https://maps.app.goo.gl/H0", net), LONG)
        self.assertEqual(len(tr.urls), 4)

    def test_http_and_ports_not_asked(self):
        net, tr = fetcher({})
        for u in ("http://maps.app.goo.gl/AbCd123?g_st=ic", "http://goo.gl/maps/xyz", "https://maps.app.goo.gl:443/x",
                  "https://maps.app.goo.gl:8443/x", "https://maps.app.goo.gl:x/y"):
            with self.assertRaises(maplinks.LinkError, msg=u):
                maplinks.resolve(u, net)
        net, tr2 = fetcher({"https://maps.app.goo.gl/Down": (302, {"Location": "http://maps.app.goo.gl/Plain"}, b"")})
        with self.assertRaises(maplinks.LinkError):
            maplinks.resolve("https://maps.app.goo.gl/Down", net)
        self.assertEqual(tr.urls, [])
        self.assertEqual(tr2.urls, ["https://maps.app.goo.gl/Down"], "a redirect to http:// is not followed")

    def test_deadline(self):
        t = Clock()

        class Slow(Transport):
            def request(self, url, headers, timeout):
                t.sleep(maplinks.RESOLVE_S / 2 + 1)
                return super().request(url, headers, timeout)

        tr, nclock = Slow({"https://maps.app.goo.gl/A": (302, {"Location": "https://maps.app.goo.gl/B"}, b""),
                           "https://maps.app.goo.gl/B": (302, {"Location": "https://maps.app.goo.gl/C"}, b""),
                           "https://maps.app.goo.gl/C": (302, {"Location": LONG}, b"")}), Clock()
        net = netfetch.Fetcher(transport=tr, clock=nclock, sleep=nclock.sleep, wall=nclock)
        with self.assertRaisesRegex(maplinks.LinkError, "too long"):
            maplinks.resolve("https://maps.app.goo.gl/A", net, clock=t)
        self.assertEqual(tr.urls, ["https://maps.app.goo.gl/A", "https://maps.app.goo.gl/B"])

    def test_messages(self):
        self.assertIn("not found", maplinks.error_text(netfetch.NotFound("x")))
        self.assertIn("offline", maplinks.error_text(netfetch.Offline("x")))
        self.assertIn("not a Google Maps link", maplinks.error_text(maplinks.LinkError("not a Google Maps link")))

    def test_the_short_hosts_have_their_policy(self):
        for h in maplinks.SHORT_HOSTS:
            p = netfetch.POLICIES[h]
            self.assertTrue(p.redirect_ok and p.optional and p.daily_hard)
            self.assertEqual(p.max_attempts, 1)


class OpenPageTest(unittest.TestCase):
    """The map's Google Maps buttons: the server opens Google's Maps URLs (gmaps.lua) as well as the project's pages."""

    def test_maps_urls(self):
        calls = []
        ok = [u for u in ("https://www.google.com/maps/search/?api=1&query=51.178882%2C-1.826215",
                          "https://www.google.com/maps/dir/?api=1&origin=1%2C2&destination=3%2C4&travelmode=driving",
                          "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=51.1788%2C-1.8262&heading=-45")]
        bad = ("https://www.google.com/search?q=x", "https://www.google.com/maps/place/x", "https://www.google.com.evil/maps/",
               "https://www.google.com/maps/search/?api=1&query=1 2", 'https://www.google.com/maps/@?api=1&x="',
               "https://www.google.com/maps/search/?api=1&query=1\t2", "https://www.google.com/maps/dir/?api=1&origin=1\x002",
               "https://www.google.com/maps/@?api=1&viewpoint=1\x1b2", "https://www.google.com/maps/@?api=1&x=1\x7f",
               "https://www.google.com/maps/search/?api=1&query=1#frag", "https://www.google.com/maps/search/?api=1&q=a;b",
               "https://www.google.com/maps/search/?api=1&query=/x", "https://www.google.com/maps/dir/?api=1&x=\u00e9",
               "https://www.google.com/maps/search/?api=1&query=1@evil.example",
               updates.OPEN_PREFIX + "releases\tx", updates.OPEN_PREFIX + "releases\x01")
        if updates.sys.platform == "win32":
            import unittest.mock as mock
            with mock.patch.object(updates.os, "startfile", create=True):
                self.assertTrue(all(updates.open_page(u) for u in ok))
        else:
            self.assertTrue(all(updates.open_page(u, popen=lambda *a, **k: calls.append(a)) for u in ok))
        for u in bad:
            self.assertFalse(updates.open_page(u, popen=lambda *a, **k: calls.append(a)), u)


if __name__ == "__main__":
    unittest.main()

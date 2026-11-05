"""Google Maps share links for the world map's search box and Go box (the fork's Google Maps integration, phase 0).

A phone's "Share" in the Google Maps app gives a short link (https://maps.app.goo.gl/<id>, older ones
https://goo.gl/maps/<id>) that holds no coordinates: only its redirect does. The mod cannot reach the internet, so it
sends the link here (map_link) and gets the long link back (map_link_result); places.lua reads the point from it
(parseMapLink) or, when the long link names a place without coordinates (?q=Place+Name&ftid=...), the map searches
for that name instead.

Only the short-link hosts are ever asked, one GET a hop without following the redirect (netfetch's transport never
follows), at most MAX_HOPS; the long Google Maps link at the end is not fetched (no request goes to google.com, so no
consent page and nothing scraped). An EU consent page in the chain (consent.google.com/?continue=<link>) is read for
its continue link.
"""
import re
import urllib.parse

import netfetch

SHORT_HOSTS = ("maps.app.goo.gl", "goo.gl")
MAX_HOPS = 4
MAX_URL = 2048          # Google's own limit for Maps URLs
# www.google.com, maps.google.com, google.pl, www.google.co.uk, google.com.au ...
_GOOGLE_HOST = re.compile(r"^(www\.|maps\.)?google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$")
_BAD_CHARS = set(' "\'<>`\\\n\r\t')


class LinkError(ValueError):
    """Not a Google Maps link, or its redirect chain did not end at one."""


def _split(url):
    url = url.strip() if isinstance(url, str) else None
    if not url or len(url) > MAX_URL or any(c in _BAD_CHARS for c in url):
        return None
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    return p


def is_short(url):
    """A Google Maps short link (maps.app.goo.gl/<id>, goo.gl/maps/<id>). Pure."""
    p = _split(url)
    if p is None or p.hostname not in SHORT_HOSTS:
        return False
    path = p.path.strip("/")
    if p.hostname == "goo.gl":
        return path.startswith("maps/") and len(path) > len("maps/")
    return bool(path)


def is_long(url):
    """A full Google Maps link (google.<tld>/maps..., maps.google.<tld>/...). Pure."""
    p = _split(url)
    if p is None or not _GOOGLE_HOST.match(p.hostname or ""):
        return False
    return p.hostname.startswith("maps.") or p.path == "/maps" or p.path.startswith("/maps/")


def _consent_continue(url):
    """consent.google.com/...?continue=<link>: the link, else None. Pure."""
    p = _split(url)
    if p is None or p.hostname != "consent.google.com":
        return None
    got = urllib.parse.parse_qs(p.query).get("continue")
    return got[0] if got else None


def resolve(url, net, max_hops=MAX_HOPS):
    """The long Google Maps link a short link leads to (a long link comes back as it is). net: a netfetch.Fetcher
    (the short-link hosts' policy has redirect_ok). Raises LinkError, or netfetch's errors (offline, rate limited)."""
    cur = url.strip() if isinstance(url, str) else url
    for _ in range(max_hops + 1):
        if is_long(cur):
            return cur
        nxt = _consent_continue(cur)
        if nxt is not None:
            cur = nxt
            continue
        if not is_short(cur):
            raise LinkError("not a Google Maps link")
        res = net.get(cur, kind="demand")
        loc = res.headers.get("location") if 300 <= res.status < 400 else None
        if not loc:
            raise LinkError("the short link did not lead anywhere")
        cur = urllib.parse.urljoin(cur, loc)
    raise LinkError("too many redirects")


def error_text(e):
    """The map's message for a failed resolve (e: the exception)."""
    if isinstance(e, LinkError):
        return f"Google Maps link: {e}"
    if isinstance(e, netfetch.NotFound):
        return "Google Maps link not found (expired or mistyped?)"
    if isinstance(e, (netfetch.Offline, netfetch.HostUnavailable)):
        return "Cannot open the Google Maps link (offline?)"
    return "Cannot open the Google Maps link"

-- luajit mod/tests/test_gmaps.lua  (Google Maps from the world map, gmaps.lua; the settings bridge's uiGoogleMaps,
-- uiMapParse's short links and uiMapLink / uiMapLinkResult through core's map_link round trip)
local dir = (arg[0]:match('^(.*)[/\\]') or '.')
local T = dofile(dir .. '/testlib.lua')
dofile(dir .. '/stubs.lua')
local net = require('beamngEarth/net')
local gmaps = require('beamngEarth/gmaps')
local settings = require('beamngEarth/settings')

-- the links: Google's Maps URLs, the comma escaped, six decimals
T.check(gmaps.placeUrl(51.1788823, -1.826215) == 'https://www.google.com/maps/search/?api=1&query=51.178882%2C-1.826215',
  'place: a pin at the point')
T.check(gmaps.streetViewUrl(51.1788, -1.8262) ==
  'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=51.178800%2C-1.826200', 'street view: no heading')
T.check(gmaps.streetViewUrl(51.1788, -1.8262, -90.4):match('&heading=270$'), 'street view: heading 0..359')
T.check(gmaps.streetViewUrl(51.1788, -1.8262, 359.7):match('&heading=0$'), 'street view: heading rounds to 0')
T.check(gmaps.directionsUrl(50.06, 19.94, 52.23, 21.01) == 'https://www.google.com/maps/dir/?api=1&origin=50.060000%2C' ..
  '19.940000&destination=52.230000%2C21.010000&travelmode=driving', 'directions: from the start')
T.check(gmaps.directionsUrl(nil, nil, 52.23, 21.01) ==
  'https://www.google.com/maps/dir/?api=1&destination=52.230000%2C21.010000&travelmode=driving', 'directions: no start')
for _, bad in ipairs({ { 91, 0 }, { 0, 181 }, { 'x', 1 }, { 0 / 0, 1 } }) do
  T.check(gmaps.placeUrl(bad[1], bad[2]) == nil and gmaps.streetViewUrl(bad[1], bad[2]) == nil, 'no link off the globe')
end
T.check(gmaps.directionsUrl(1, 2, nil, 3) == nil, 'directions: no destination, no link')
T.check(gmaps.url('place', 1, 2) == gmaps.placeUrl(1, 2) and gmaps.url('streetview', 1, 2, 3) == gmaps.streetViewUrl(1, 2, 3)
  and gmaps.url('directions', 1, 2, 3, 4) == gmaps.directionsUrl(1, 2, 3, 4) and gmaps.url('evil', 1, 2) == nil, 'url(kind)')

-- the phone's share links
T.check(gmaps.shortLink('https://maps.app.goo.gl/AbCd12_x-Y') == 'https://maps.app.goo.gl/AbCd12_x-Y', 'short link')
T.check(gmaps.shortLink('Stonehenge\nhttps://maps.app.goo.gl/AbCd12?g_st=ic') == 'https://maps.app.goo.gl/AbCd12?g_st=ic',
  'short link inside the shared text')
T.check(gmaps.shortLink('https://goo.gl/maps/Xyz123') == 'https://goo.gl/maps/Xyz123', 'old goo.gl/maps link')
for _, bad in ipairs({ 'https://goo.gl/Xyz', 'https://maps.app.goo.gl/', '51.1, -1.8', 'https://www.google.com/maps/@1,2,3z', 5 }) do
  T.check(gmaps.shortLink(bad) == nil, 'not a short link: ' .. tostring(bad))
end
T.check(gmaps.placeName('https://www.google.com/maps?q=Big+Ben,+London&ftid=0x1:0x2') == 'Big Ben, London', 'name: ?q=')
T.check(gmaps.placeName('https://www.google.com/maps/place/Krak%C3%B3w/data=!4m2') == 'Kraków', 'name: /maps/place/')
T.check(gmaps.placeName('https://www.google.com/maps/@1,2,3z') == nil, 'name: none')

-- opening: through the server while connected (it opens only these prefixes), the game's call without one
local sent = {}
net.send = function(m) sent[#sent + 1] = m; return true end
local browser = {}
function openWebBrowser(u) browser[#browser + 1] = u end
T.check(gmaps.open(gmaps.placeUrl(1, 2)) and #browser == 1 and #sent == 0, 'open: the game\'s browser call offline')
net.isConnected = function() return true end
T.check(gmaps.open(gmaps.placeUrl(1, 2)) and #sent == 1 and sent[1].type == 'open_page' and sent[1].url == gmaps.placeUrl(1, 2),
  'open: the server opens it')
T.check(not gmaps.open('https://evil.example/') and not gmaps.open('https://www.google.com/maps/place/x') and #sent == 1,
  'open: only the links built here')

-- the settings bridge
local r = settings.uiGoogleMaps('place', 1, 2, nil, nil, false)
T.check(r.url == gmaps.placeUrl(1, 2) and r.opened == false and #sent == 1, 'uiGoogleMaps: the link alone (QR)')
r = settings.uiGoogleMaps('streetview', 1, 2, 90, nil, true)
T.check(r.opened and sent[#sent].url == gmaps.streetViewUrl(1, 2, 90), 'uiGoogleMaps: opened')
beamngEarth_core = { _state = function() return { player = { lat = 50.06, lon = 19.94 } } end }
r = settings.uiGoogleMaps('directions', 'here', nil, 52.23, 21.01, false)
T.check(r.url == gmaps.directionsUrl(50.06, 19.94, 52.23, 21.01), 'uiGoogleMaps: directions from the player')
T.check(settings.uiGoogleMaps('evil', 1, 2).error, 'uiGoogleMaps: unknown kind')

T.check(settings.uiMapParse('see https://maps.app.goo.gl/AbC').shortLink == 'https://maps.app.goo.gl/AbC',
  'uiMapParse: a short link to resolve')
T.check(settings.uiMapParse('https://www.google.com/maps/@40.553176,-105.079734,15z').lat == 40.553176,
  'uiMapParse: a long link as before')
T.check(settings.uiMapParse('nowhere').error, 'uiMapParse: an error as before')

-- the round trip: the mod asks (map_link), the server's map_link_result is kept by core until the map polls
local core = dofile(dir .. '/../beamng_earth/lua/ge/extensions/beamngEarth/core.lua')
beamngEarth_core = core
T.check(settings.uiMapLink('51.1, -1.8').error, 'uiMapLink: not a short link')
local a = settings.uiMapLink('Stonehenge https://maps.app.goo.gl/AbC')
local m = sent[#sent]
T.check(a.id and m.type == 'map_link' and m.id == a.id and m.url == 'https://maps.app.goo.gl/AbC', 'uiMapLink: map_link sent')
T.check(settings.uiMapLinkResult(a.id) == nil, 'uiMapLinkResult: nil while waiting')
core._mapLinks[a.id] = { url = 'https://www.google.com/maps/place/Stonehenge/@51.17,-1.82,17z/data=!3d51.1788823!4d-1.826215' }
r = settings.uiMapLinkResult(a.id)
T.check(r and math.abs(r.lat - 51.1788823) < 1e-9 and math.abs(r.lon + 1.826215) < 1e-9, 'uiMapLinkResult: the place\'s point')
T.check(settings.uiMapLinkResult(a.id) == nil, 'uiMapLinkResult: taken once')
local b = settings.uiMapLink('https://maps.app.goo.gl/Q')
core._mapLinks[b.id] = { url = 'https://www.google.com/maps?q=Big+Ben&ftid=0x1:0x2' }
T.check(settings.uiMapLinkResult(b.id).query == 'Big Ben', 'uiMapLinkResult: a name to search for')
local c = settings.uiMapLink('https://maps.app.goo.gl/Gone')
core._mapLinks[c.id] = { error = 'NotFound: x', text = 'Google Maps link not found (expired or mistyped?)' }
T.check(settings.uiMapLinkResult(c.id).error:match('not found'), 'uiMapLinkResult: the server\'s message')
net.isConnected = function() return false end
T.check(settings.uiMapLink('https://maps.app.goo.gl/Q').error == 'Companion server not connected', 'uiMapLink: offline')

T.done('test_gmaps')

-- Google Maps from the world map (the fork's Google Maps integration, phase 0): a point, its Street View or the GPS
-- route opened in Google Maps in the player's browser, the same links as a QR code for a phone, and the phone's own
-- share links (maps.app.goo.gl) pasted into the map's search or Go box.
-- Only Google's Maps URLs (https://developers.google.com/maps/documentation/urls): no API key, no Google request
-- from the game or the server, nothing of Google's drawn on our map. The links are built here from numbers (the UI
-- passes back only the one it was given, for the QR box's "Open on this PC"; M.open takes nothing but these
-- prefixes), and the server opens only these prefixes (updates.open_page). A short link holds no
-- coordinates: the server reads where it leads (maplinks.py) and places.parseMapLink reads the point from that.
-- Pure apart from M.open.
local M = {}

local net = require('beamngEarth/net')

M.SEARCH = 'https://www.google.com/maps/search/?api=1&'
M.DIR = 'https://www.google.com/maps/dir/?api=1&'
M.PANO = 'https://www.google.com/maps/@?api=1&'

local function ll(lat, lon)
  lat, lon = tonumber(lat), tonumber(lon)
  if not lat or not lon or lat ~= lat or lon ~= lon or lat < -90 or lat > 90 or lon < -180 or lon > 180 then return nil end
  return string.format('%.6f%%2C%.6f', lat, lon)   -- "lat,lon", the comma escaped as Google's examples do
end

-- The point in Google Maps (a pin there).
function M.placeUrl(lat, lon)
  local p = ll(lat, lon)
  return p and (M.SEARCH .. 'query=' .. p) or nil
end

-- Street View nearest the point (Google picks the panorama), looking along heading (compass degrees) if given.
function M.streetViewUrl(lat, lon, heading)
  local p = ll(lat, lon)
  if not p then return nil end
  local u = M.PANO .. 'map_action=pano&viewpoint=' .. p
  heading = tonumber(heading)
  if heading and heading == heading then u = u .. string.format('&heading=%d', math.floor(heading % 360 + 0.5) % 360) end
  return u
end

-- Driving directions to (lat1, lon1), from (lat0, lon0) when given (else Google's own "your location").
function M.directionsUrl(lat0, lon0, lat1, lon1)
  local d = ll(lat1, lon1)
  if not d then return nil end
  local o = ll(lat0, lon0)
  return M.DIR .. (o and ('origin=' .. o .. '&') or '') .. 'destination=' .. d .. '&travelmode=driving'
end

-- The UI's one entry: kind 'place' / 'streetview' (a, b = lat, lon; c = heading) or 'directions' (a, b = the start,
-- c, d = the destination).
function M.url(kind, a, b, c, d)
  if kind == 'place' then return M.placeUrl(a, b) end
  if kind == 'streetview' then return M.streetViewUrl(a, b, c) end
  if kind == 'directions' then return M.directionsUrl(a, b, c, d) end
  return nil
end

-- A Google Maps short link in text (a phone's share: "Stonehenge\nhttps://maps.app.goo.gl/AbC12"), or nil; always
-- normalised: https://, the host in lower case, the id alone (no ?g_st=ic, no full stop after it). The scheme is
-- optional ("maps.app.goo.gl/AbC12": the map's search takes it as a link too) and the scheme and host any case; the
-- id is case-sensitive, so it is read from the text itself (ASCII lower keeps the byte positions).
local SHORT = { { host = 'maps%.app%.goo%.gl/', base = 'https://maps.app.goo.gl/' },
                { host = 'goo%.gl/maps/', base = 'https://goo.gl/maps/' } }
function M.shortLink(text)
  if type(text) ~= 'string' or #text > 2048 then return nil end
  local low = text:lower()
  for _, s in ipairs(SHORT) do
    local init = 1
    while true do
      local i, j = low:find(s.host, init)
      if not i then break end
      local before = i > 1 and low:sub(i - 1, i - 1) or ''
      local id = text:match('^[%w_%-]+', j + 1)
      -- the host at the start, after a space or "http(s)://" (not "evilmaps.app.goo.gl/", nor "x.goo.gl/maps/")
      if id and (before == '' or before == '/' and low:sub(1, i - 1):match('https?://$') or not before:match('[%w%.%-_/]')) then
        return s.base .. id
      end
      init = j + 1
    end
  end
  return nil
end

-- The place name of a long link with no coordinates (?q=Big+Ben&ftid=..., /maps/place/Big+Ben/...), for the map's
-- search instead; nil when none.
local function unescape(s)
  return (s:gsub('%+', ' '):gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end))
end
function M.placeName(url)
  if type(url) ~= 'string' then return nil end
  local q = url:match('[?&]q=([^&#]+)') or url:match('[?&]query=([^&#]+)') or url:match('/maps/place/([^/?#]+)')
  if not q then return nil end
  q = unescape(q):gsub('^%s+', ''):gsub('%s+$', '')
  if q == '' or #q > 200 then return nil end
  return q
end

-- Open one of these links in the player's browser: through the server (the game's openWebBrowser does nothing in
-- the native Linux build), the game's own call without one. Returns true if asked.
function M.open(url)
  if type(url) ~= 'string' then return false end
  if url:sub(1, #M.SEARCH) ~= M.SEARCH and url:sub(1, #M.DIR) ~= M.DIR and url:sub(1, #M.PANO) ~= M.PANO then
    return false
  end
  if net.isConnected() then
    net.send({ type = 'open_page', url = url })
    return true
  end
  local web = rawget(_G, 'openWebBrowser')
  if web then return (pcall(web, url)) end
  return false
end

return M

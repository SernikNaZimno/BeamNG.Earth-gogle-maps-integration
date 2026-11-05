-- The live map in the browser's commands (docs/COMPANION.md, the fork's Google Maps phase 1): the server's remote_cmd,
-- from a click or button on its page (server/companion.py's POST /api/cmd), run as the world map runs its own:
--   gps (lat, lon, name?)  -> gps.setDestination (settings.uiMapGps)
--   clear_gps              -> gps.clear
--   teleport (lat, lon)    -> places.goTo (settings.uiMapTeleport; it checks places.cannotGo: a teleport that cannot be
--                             done now, the level not loaded or the ground loading, is dropped with a 'W' log line)
--   autodrive (on)         -> gps.setAutodrive (settings.uiGpsAutodrive; on only with a destination, as the map's button)
-- Anything else is ignored: an unknown action, lat / lon not numbers in -90..90 / -180..180, on not a boolean (the
-- server checks the same, this is the mod's own guard). The name is cut to NAME_MAX (as the server's limit) on a UTF-8
-- boundary, control characters blanked. Pure but for the modules it calls: deps (tests) = { gps, places, log }.
local M = {}

M.NAME_MAX = 120

local function num(v, lo, hi)
  if type(v) ~= 'number' or v ~= v or v < lo or v > hi then return nil end
  return v
end

-- A destination's name: a non-empty string (else nil), control characters blanked, at most NAME_MAX bytes.
function M.cleanName(name)
  if type(name) ~= 'string' then return nil end
  local s = name:gsub('%c', ' '):gsub('^%s+', ''):gsub('%s+$', '')
  if s == '' then return nil end
  if #s > M.NAME_MAX then s = s:sub(1, M.NAME_MAX):gsub('[\128-\191]+$', ''):gsub('[\192-\255]$', '') end
  return s
end

-- msg: the remote_cmd. -> true when it was run, else false and why (logged for a refused teleport only).
function M.run(msg, deps)
  if type(msg) ~= 'table' then return false, 'not a command' end
  deps = deps or {}
  local gps = deps.gps or require('beamngEarth/gps')
  local a = msg.action
  if a == 'gps' or a == 'teleport' then
    local lat, lon = num(msg.lat, -90, 90), num(msg.lon, -180, 180)
    if not lat or not lon then return false, 'latitude must be -90..90 and longitude -180..180' end
    if a == 'gps' then
      if not gps.setDestination(lat, lon, M.cleanName(msg.name)) then return false, 'destination refused' end
      return true
    end
    local places = deps.places or require('beamngEarth/places')
    local ok, why = places.goTo(lat, lon)
    if not ok then
      local log = deps.log or rawget(_G, 'log')
      if log then pcall(log, 'W', 'beamngEarth', 'live map: teleport refused: ' .. tostring(why)) end
      return false, why
    end
    return true
  elseif a == 'clear_gps' then
    gps.clear()
    return true
  elseif a == 'autodrive' then
    if type(msg.on) ~= 'boolean' then return false, 'on must be true or false' end
    if msg.on and not gps.status() then return false, 'no destination' end
    gps.setAutodrive(msg.on)
    return true
  end
  return false, 'unknown action'
end

return M

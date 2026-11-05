-- luajit mod/tests/test_remote.lua  (the live map in the browser, docs/COMPANION.md: the server's remote_cmd run by
-- remote.lua, and gps.lua's gps_state: on a change, after a hello, every SHARE_S while a destination is set)
local T = dofile((arg[0]:match('^(.*)[/\\]') or '.') .. '/testlib.lua')
local R = require('beamngEarth/remote')

-- a fake gps / places / log: what was called
local calls = {}
local hasDest = false
local fgps = {
  setDestination = function(lat, lon, name) calls[#calls + 1] = { 'dest', lat, lon, name }; hasDest = true; return true end,
  clear = function() calls[#calls + 1] = { 'clear' }; hasDest = false end,
  setAutodrive = function(on) calls[#calls + 1] = { 'auto', on }; return on end,
  status = function() return hasDest and {} or nil end,
}
local refuse = nil
local fplaces = { goTo = function(lat, lon) calls[#calls + 1] = { 'go', lat, lon }; if refuse then return false, refuse end; return true end }
local logs = {}
local deps = { gps = fgps, places = fplaces, log = function(level, tag, text) logs[#logs + 1] = { level, tag, text } end }
local function run(msg) calls = {}; return R.run(msg, deps) end

T.check(run({ action = 'gps', lat = 50.06, lon = 19.94, name = 'Kraków' }) == true and #calls == 1
  and calls[1][1] == 'dest' and calls[1][2] == 50.06 and calls[1][3] == 19.94 and calls[1][4] == 'Kraków',
  'gps: the destination set with its name')
T.check(run({ action = 'gps', lat = 50, lon = 20 }) == true and calls[1][4] == nil, 'gps: no name')
T.check(run({ action = 'gps', lat = 50, lon = 20, name = '  ' }) == true and calls[1][4] == nil, 'gps: a blank name: none')
T.check(run({ action = 'gps', lat = 50, lon = 20, name = 7 }) == true and calls[1][4] == nil, 'gps: a name not a string: none')
T.check(run({ action = 'gps', lat = 50, lon = 20, name = 'a\nb' }) == true and calls[1][4] == 'a b', 'gps: control characters blanked')
run({ action = 'gps', lat = 50, lon = 20, name = string.rep('x', 119) .. 'é' })
T.check(calls[1][4] == string.rep('x', 119), 'gps: a long name cut to 120 bytes, not inside a UTF-8 character')
T.check(run({ action = 'gps', lat = 90, lon = -180 }) == true and run({ action = 'gps', lat = -90, lon = 180 }) == true,
  'gps: the edges of the range are fine')
for _, bad in ipairs({ { lat = 91, lon = 0 }, { lat = -90.5, lon = 0 }, { lat = 0, lon = 181 }, { lat = 0, lon = -180.1 },
                       { lat = '50', lon = 20 }, { lat = 50 }, { lon = 20 }, { lat = 0 / 0, lon = 0 }, { lat = 0, lon = math.huge } }) do
  bad.action = 'gps'
  local ok = run(bad)
  T.check(ok == false and #calls == 0, 'gps: a bad lat / lon ignored: ' .. tostring(bad.lat) .. ', ' .. tostring(bad.lon))
end
T.check(run({ action = 'clear_gps' }) == true and #calls == 1 and calls[1][1] == 'clear', 'clear_gps: cleared')

-- autodrive: on only with a destination (the map's button), off always; on must be a boolean
hasDest = false
T.check(run({ action = 'autodrive', on = true }) == false and #calls == 0, 'autodrive on without a destination: ignored')
hasDest = true
T.check(run({ action = 'autodrive', on = true }) == true and calls[1][1] == 'auto' and calls[1][2] == true, 'autodrive on')
T.check(run({ action = 'autodrive', on = false }) == true and calls[1][2] == false, 'autodrive off')
hasDest = false
T.check(run({ action = 'autodrive', on = false }) == true and calls[1][2] == false, 'autodrive off without a destination too')
T.check(run({ action = 'autodrive', on = 'yes' }) == false and run({ action = 'autodrive' }) == false and #calls == 0,
  'autodrive: on not a boolean: ignored')

-- teleport: places.goTo; refused (places.cannotGo): a 'W' log line, nothing else
T.check(run({ action = 'teleport', lat = 35.68, lon = 139.77 }) == true and #calls == 1 and calls[1][1] == 'go'
  and calls[1][2] == 35.68 and calls[1][3] == 139.77 and #logs == 0, 'teleport: places.goTo')
refuse = 'Loading the ground: wait a moment'
local ok, why = run({ action = 'teleport', lat = 35.68, lon = 139.77 })
T.check(ok == false and why == refuse and #calls == 1 and #logs == 1 and logs[1][1] == 'W'
  and logs[1][3]:find(refuse, 1, true), 'teleport refused: logged as a warning, nothing else done')
refuse = nil
T.check(run({ action = 'teleport', lat = -91, lon = 0 }) == false and #calls == 0 and #logs == 1, 'teleport: a bad lat ignored')

-- anything else
T.check(run({ action = 'nuke' }) == false and run({}) == false and R.run(nil, deps) == false and R.run('gps', deps) == false
  and #calls == 0, 'an unknown action / no command: ignored')

-- the real modules: a refused teleport through places.goTo (nothing loaded: cannotGo says so)
do
  local saved = rawget(_G, 'beamngEarth_core')
  beamngEarth_core = nil
  local seen = {}
  local ok2, why2 = R.run({ action = 'teleport', lat = 10, lon = 10 }, { log = function(l, _, t) seen[#seen + 1] = l .. t end })
  T.check(ok2 == false and why2 == 'BeamNG.Earth is not loaded' and seen[1] and seen[1]:find('^W'),
    'the real places.goTo: refused while BeamNG.Earth is not loaded, logged')
  beamngEarth_core = saved
end

------------------------------------------------------------------------------------------
-- gps_state (gps.lua share / shareState; core.sendGpsState sends it: faked here, connected or not)

local G = require('beamngEarth/gps')
local clock = 100
local realClock = os.clock
os.clock = function() return clock end
local sent, connected = {}, true
local savedCore = rawget(_G, 'beamngEarth_core')
beamngEarth_core = { sendGpsState = function(s) if not connected then return false end; sent[#sent + 1] = s; return true end }

T.check(G.share() == true and #sent == 1 and sent[1].active == false and next(sent[1], next(sent[1])) == nil,
  'nothing set: one gps_state active = false (only that field)')
T.check(G.share() == false and #sent == 1, '... and not again')
clock = clock + 10
T.check(G.share() == false and #sent == 1, 'inactive: no repeats every 2 s')
T.check(G.share(true) == true and #sent == 2 and sent[2].active == false, 'after a hello (force): sent again')

G.setDestination(52.23, 21.01, 'Warsaw')
T.check(G.share() == true and #sent == 3, 'a new destination: sent at once')
local s = sent[3]
T.check(s.active == true and s.lat == 52.23 and s.lon == 21.01 and s.name == 'Warsaw' and s.autodrive == false
  and s.remaining == nil and s.eta == nil, 'active: lat, lon, name, autodrive; remaining / eta unknown yet: left out')
T.check(G.share() == false and #sent == 3, 'unchanged: not again within 2 s')
clock = clock + 1.9
T.check(G.share() == false and #sent == 3, '... still not at 1.9 s')
clock = clock + 0.1
T.check(G.share() == true and #sent == 4, 'every 2 s while active')
-- the remaining distance after an update (no planned route: straight to the destination, 500 m)
do
  local savedGet = rawget(_G, 'getPlayerVehicle')
  getPlayerVehicle = function() return nil end
  local anchor = { geodeticToEnu = function() return 300, 400, 0 end }
  local ok3, err = pcall(G.update, anchor, { x = 0, y = 0, lat = 52, lon = 21 })
  T.check(ok3, 'gps.update ran: ' .. tostring(err))
  getPlayerVehicle = savedGet
end
clock = clock + 2
T.check(G.share() == true and math.abs((sent[#sent].remaining or 0) - 500) < 1e-6 and sent[#sent].eta == nil,
  'the remaining distance after an update (no route: no ETA)')
local n = #sent
G.setDestination(52.23, 21.01, 'Warszawa')
T.check(G.share() == true and #sent == n + 1 and sent[#sent].name == 'Warszawa', 'a new name: sent at once')
G.setDestination(52.23, 21.01, '')
T.check(G.share() == true and sent[#sent].name == nil, 'an empty name: left out')
G.setAutodrive(true)
T.check(G.share() == true and sent[#sent].autodrive == true, 'autodrive on: sent at once')
G.setAutodrive(false)
T.check(G.share() == true and sent[#sent].autodrive == false, 'autodrive off: sent at once')
n = #sent
T.check(G.share(true) == true and #sent == n + 1 and sent[#sent].active == true, 'after a hello: the destination again')

-- not connected: nothing goes out, the change is sent once connected
connected = false
G.clear()
T.check(G.share() == false and #sent == n + 1, 'cleared while not connected: nothing sent')
connected = true
T.check(G.share() == true and sent[#sent].active == false, 'connected again: the clear sent')
T.check(G.share() == false, '... once')

-- no core (BeamNG.Earth not loaded): nothing
beamngEarth_core = nil
T.check(G.share(true) == false, 'no core: nothing sent')

beamngEarth_core = savedCore
os.clock = realClock
T.done('test_remote')

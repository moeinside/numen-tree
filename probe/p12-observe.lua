local me = numen.status.self()
local w = numen.status.world()
local t = numen.task.status()
local function S(v) local s = tostring(v or ""):gsub('"', "'") return '"' .. s .. '"' end
local function N(v) return tostring(math.floor((tonumber(v) or 0) * 100 + 0.5) / 100) end
local function O(v) if v == nil then return 'null' end return '"' .. tostring(v) .. '"' end
local parts = {
  '{"hp":' .. N(me.hp),
  ',"hunger":' .. N(me.hunger),
  ',"x":' .. N(me.pos.x),
  ',"y":' .. N(me.pos.y),
  ',"z":' .. N(me.pos.z),
  ',"dim":' .. S(me.dimension),
  ',"game_time":' .. N(w.game_time),
  ',"task_id":' .. O(t.task_id),
  ',"task":' .. O(t.task),
  ',"task_state":' .. O(t.state),
  ',"elapsed_s":' .. O(t.elapsed_s),
  ',"budget_left_s":' .. O(t.budget_left_s),
}
return table.concat(parts) .. '}'

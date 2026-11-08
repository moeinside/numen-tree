-- P23 只读：活体字段枚举（self/world/owner/task/inv/entities/blocks/container）
local out = {}

local function short(v)
  local t = type(v)
  if t == "table" then
    local n = 0
    for _ in pairs(v) do n = n + 1 end
    if n <= 6 then
      local parts = {}
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = tostring(k) end
      table.sort(keys)
      for _, k in ipairs(keys) do parts[#parts + 1] = k .. "=" .. short(v[k]) end
      return "{" .. table.concat(parts, ",") .. "}"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    return "[" .. n .. ":" .. table.concat(keys, "|") .. "]"
  end
  return tostring(v)
end

local function dump(name, v)
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do parts[#parts + 1] = tostring(k) .. "=" .. short(v[k]) end
  return name .. ": " .. table.concat(parts, " ; ")
end

local ok, v
ok, v = pcall(numen.status.self); out.self = ok and dump("self", v) or ("ERR " .. tostring(v))
ok, v = pcall(numen.status.world); out.world = ok and dump("world", v) or ("ERR " .. tostring(v))
ok, v = pcall(numen.status.owner); out.owner = ok and dump("owner", v) or ("ERR " .. tostring(v))
ok, v = pcall(numen.task.status); out.task = ok and dump("task", v) or ("ERR " .. tostring(v))

ok, v = pcall(numen.inv.items)
if ok and type(v) == "table" then
  out.inv_items_n = tostring(#v)
  out.inv_items_1 = dump("item1", v[1] or {})
  out.inv_items_2 = dump("item2", v[2] or {})
else
  out.inv_items_err = tostring(v)
end

-- 手持 / 护甲相关函数是否存在（只查名字，不调用改变状态的东西）
local function exists(path)
  local parts = {}
  for part in path:gmatch("[^.]+") do
    parts[#parts + 1] = part
  end
  local t = numen
  for i = 2, #parts do
    if type(t) ~= "table" then
      return "no-parent"
    end
    local ok2, v = pcall(function() return t[parts[i]] end)
    if not ok2 then
      return "raised"
    end
    t = v
  end
  return type(t)
end
out.fns = {}
for _, p in ipairs({
  "numen.status.self", "numen.status.world", "numen.status.owner",
  "numen.gear.hold", "numen.gear.wear", "numen.gear.remove",
  "numen.inv.items", "numen.inv.count", "numen.inv.eat", "numen.inv.drop", "numen.inv.fetch",
  "numen.scan.entities", "numen.scan.blocks", "numen.scan.block", "numen.scan.container", "numen.scan.items",
  "numen.gui.view", "numen.gui.take", "numen.gui.quick", "numen.gui.close", "numen.gui.count",
  "numen.fight.attack", "numen.work.dig", "numen.work.mine", "numen.build.place",
  "numen.move.to", "numen.move.flee", "numen.move.explore", "numen.move.follow",
  "numen.task.status", "numen.task.stop", "numen.task.timer",
}) do
  out.fns[#out.fns + 1] = p .. "=" .. exists(p)
end
out.fns = table.concat(out.fns, " ")

return out

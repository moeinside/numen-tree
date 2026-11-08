-- P28 只读：scan.entities 过滤器 + 实体字段 + 容器扫描 + 函数存在性
local out = {}

local function short(v)
  local t = type(v)
  if t == "table" then
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    return "{" .. table.concat(keys, ",") .. "}"
  end
  return tostring(v)
end

local function dump1(e)
  if not e then return "nil" end
  local keys = {}
  for k in pairs(e) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do
    parts[#parts + 1] = tostring(k) .. "=" .. short(e[k])
  end
  return table.concat(parts, " ")
end

-- 各过滤器命中数 + 第一条实体全部字段
for _, f in ipairs({ "hostile", "passive", "player", "item", "all" }) do
  local ok, list = pcall(numen.scan.entities, f, { radius = 32 })
  if ok and type(list) == "table" then
    out["E:" .. f] = #list .. " | " .. dump1(list[1])
  else
    out["E:" .. f] = "ERR " .. tostring(list)
  end
end

-- 能否按具体类型扫
for _, f in ipairs({ "cow", "minecraft:cow", "animal", "mob" }) do
  local ok, v = pcall(numen.scan.entities, f, { radius = 16 })
  out["F:" .. f] = ok and ("ok " .. type(v) .. " n=" .. (type(v) == "table" and #v or "?")) or tostring(v)
end

-- 容器方块能否被 scan.blocks 扫到
for _, id in ipairs({ "minecraft:chest", "minecraft:barrel", "minecraft:crafting_table" }) do
  local ok, c = pcall(numen.scan.blocks, id, { radius = 32 })
  if ok and type(c) == "table" then
    local near = c[1] and c[1].nearest
    out["B:" .. id] = "n=" .. #c .. (near and (" nearest=" .. near.pos.x .. "," .. near.pos.y .. "," .. near.pos.z .. " id=" .. tostring(near.name or near.id)) or "")
  else
    out["B:" .. id] = "ERR " .. tostring(c)
  end
end

local ok, w = pcall(numen.status.self)
if ok then
  out.hands = "main=" .. short(w.hands and w.hands.mainhand or nil) .. " off=" .. short(w.hands and w.hands.offhand or nil)
  out.slots = "used=" .. tostring(w.backpack_slots and w.backpack_slots.used) .. " total=" .. tostring(w.backpack_slots and w.backpack_slots.total)
end

ok, v = pcall(numen.inv.items)
out.items = ok and ("n=" .. #v .. " first=" .. dump1(v[1])) or ("ERR " .. tostring(v))
return out

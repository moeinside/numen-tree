local function near(ids, r)
  local out = {}
  local c = numen.scan.blocks(ids, { radius = r })
  for i, x in ipairs(c or {}) do
    local p = x.nearest or (x.blocks and x.blocks[1])
    if p then
      local q = p.pos or p
      local nm = p.name or (x.blocks and x.blocks[1] and x.blocks[1].name) or "unknown"
      out[#out + 1] = { id = nm, x = q.x, y = q.y, z = q.z, d = p.distance, n = #(x.blocks or {}) }
    end
  end
  return out
end

local self = numen.status.self()
local p = { x = self.x, y = self.y, z = self.z }
local water = numen.scan.blocks({ "minecraft:water" }, { radius = 24 })
local animals = numen.scan.entities("passive", { radius = 48 })
local logs = near({ "minecraft:oak_log", "minecraft:birch_log", "minecraft:spruce_log", "minecraft:acacia_log", "minecraft:jungle_log", "minecraft:dark_oak_log" }, 48)
local ores = near({ "minecraft:iron_ore", "minecraft:coal_ore", "minecraft:copper_ore" }, 24)
return { pos = p, waterClusters = #(water or {}), passive = #(animals or {}), logs = logs, ores = ores }

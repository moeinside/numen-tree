local out = {}
local types = {"minecraft:oak_log","minecraft:birch_log","minecraft:spruce_log","minecraft:stone","minecraft:coal_ore"}
for _, t in ipairs(types) do
  local c = numen.scan.blocks(t, {radius = 64})
  out[t] = (c and #c) or 0
end
out.biome = numen.status.self().biome
out.pos = numen.status.self().pos
return out
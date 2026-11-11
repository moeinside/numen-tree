local ids = { "minecraft:grass_block", "minecraft:sand", "minecraft:dirt", "minecraft:stone", "minecraft:gravel", "minecraft:snow_block" }
local out = {}
for _, id in ipairs(ids) do
  local ok, list = pcall(numen.scan.blocks, id, { radius = 64 })
  if ok then
    for _, c in ipairs(list or {}) do
      local p = c.nearest or (c.blocks and c.blocks[1])
      if p then
        local q = p.pos or p
        out[#out + 1] = { id = id, x = q.x, y = q.y, z = q.z, d = p.distance }
      end
    end
  end
end
table.sort(out, function(a, b) return (a.d or 999) < (b.d or 999) end)
return { pos = numen.status.self().pos, shore = { out[1], out[2], out[3], out[4], out[5] } }

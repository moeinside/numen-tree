local m = numen.scan.map({ radius = 64 })
local c = m.center
local found = {}
for dz, row in ipairs(m.rows or {}) do
  for dx = 1, #row do
    local ch = row:sub(dx, dx)
    if ch ~= "~" and ch ~= " " and ch ~= "?" then
      found[#found + 1] = { ch = ch, x = c.x + dx - 1 - 64, z = c.z + dz - 1 - 64, dx = dx - 1 - 64, dz = dz - 1 - 64 }
    end
  end
end
table.sort(found, function(a, b) return (a.dx * a.dx + a.dz * a.dz) < (b.dx * b.dx + b.dz * b.dz) end)
local out = {}
for i = 1, math.min(10, #found) do out[i] = found[i] end
return { center = c, found = out, rows = #(m.rows or {}) }

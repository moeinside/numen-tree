local m = numen.scan.map({ radius = 24 })
local out = { center = m.center, rows = {} }
for i, r in ipairs(m.rows or {}) do
  out.rows[i] = r
end
return out

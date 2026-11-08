-- P43 只读：看 (-93,64,55) 附近 5x5 同层的空气/雪/固体分布
local out = { rows = {} }
for z = 53, 57 do
  local row = {}
  for x = -95, -91 do
    local here = numen.scan.block({ x = x, y = 64, z = z })
    local below = numen.scan.block({ x = x, y = 63, z = z })
    local h = "nil"
    if here then
      if here.is_air then h = "AIR"
      else
        local n = tostring(here.name):gsub("minecraft:", "")
        h = n
      end
    end
    local b = (below and below.is_solid) and "S" or "?"
    row[#row + 1] = string.format("%s/%s", h, b)
  end
  out.rows[#out.rows + 1] = string.format("z=%d: %s", z, table.concat(row, "  "))
end
return out

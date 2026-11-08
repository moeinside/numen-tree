-- P44 只读：沿 x=-93 / z=55 两条线看 y=64 的空气/雪分布（找连续可放格）
local out = { alongX = {}, alongZ = {} }
for z = 46, 62 do
  local here = numen.scan.block({ x = -93, y = 64, z = z })
  local below = numen.scan.block({ x = -93, y = 63, z = z })
  local h = "nil"
  if here then h = here.is_air and "AIR" or tostring(here.name):gsub("minecraft:", "") end
  local b = (below and below.is_solid) and "S" or "?"
  out.alongX[#out.alongX + 1] = string.format("z=%d %s/%s", z, h, b)
end
for x = -100, -88 do
  local here = numen.scan.block({ x = x, y = 64, z = 55 })
  local below = numen.scan.block({ x = x, y = 63, z = 55 })
  local h = "nil"
  if here then h = here.is_air and "AIR" or tostring(here.name):gsub("minecraft:", "") end
  local b = (below and below.is_solid) and "S" or "?"
  out.alongZ[#out.alongZ + 1] = string.format("x=%d %s/%s", x, h, b)
end
return out

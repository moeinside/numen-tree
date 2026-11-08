-- P41 只读：扫描脚的周围方块（诊断 place_block 为什么找不到格子）
local me = numen.status.self().pos
local x0, y0, z0 = math.floor(me.x), math.floor(me.y), math.floor(me.z)
local out = { pos = tostring(me.x) .. "," .. tostring(me.y) .. "," .. tostring(me.z), names = {}, count = 0 }
local function tag(b)
  if not b then return "nil" end
  return tostring(b.name) .. (b.is_air and ":air" or "") .. (b.is_solid and ":solid" or "")
end
-- 关心"脚边能放的格子"：同层 8 邻居 + 它们下方
local dirs = { {1,0}, {-1,0}, {0,1}, {0,-1}, {1,1}, {-1,1}, {1,-1}, {-1,-1} }
for _, d in ipairs(dirs) do
  local c = { x = x0 + d[1], y = y0, z = z0 + d[2] }
  local here = numen.scan.block(c)
  local below = numen.scan.block({ x = c.x, y = c.y - 1, z = c.z })
  out.names[#out.names + 1] = string.format("(%d,%d,%d) here=%s below=%s",
    c.x, c.y, c.z, tag(here), tag(below))
end
-- 脚下两块
out.names[#out.names + 1] = string.format("under(%d,%d,%d)=%s / %s",
  x0, y0 - 1, z0,
  tag(numen.scan.block({ x = x0, y = y0 - 1, z = z0 })),
  tag(numen.scan.block({ x = x0, y = y0 - 2, z = z0 })))
out.count = #out.names
return out

-- P42 只读：在脚附近找一个"空气 + 下方 solid"的格子（诊断/辅助 place_block 选点）
local me = numen.status.self().pos
local x0, y0, z0 = math.floor(me.x), math.floor(me.y), math.floor(me.z)
local out = { pos = tostring(me.x) .. "," .. tostring(me.y) .. "," .. tostring(me.z), cands = {} }
local dirs = {
  {1,0},{-1,0},{0,1},{0,-1},{1,1},{-1,1},{1,-1},{-1,-1},
}
for r = 1, 8 do
  for _, d in ipairs(dirs) do
    local c = { x = x0 + d[1] * r, y = y0, z = z0 + d[2] * r }
    local here = numen.scan.block(c)
    if here and here.is_air then
      local below = numen.scan.block({ x = c.x, y = c.y - 1, z = c.z })
      if below and below.is_solid then
        out.cands[#out.cands + 1] = string.format("(%d,%d,%d) r=%d below=%s", c.x, c.y, c.z, r, tostring(below.name))
        if #out.cands >= 6 then return out end
      end
    end
  end
end
return out

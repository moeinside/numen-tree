-- P32 只读：scan 帮助里的 Entity / Item 等类字段块（每行截断 200）
local ok, h = pcall(numen.api.help, "numen.scan")
if not ok then return { ERR = tostring(h) } end
h = tostring(h)
local want = { Entity = true, Item = true, Sight = true, GroundMap = true }
local out, cur, buf = {}, nil, nil
for line in (h .. "\n"):gmatch("(.-)\n") do
  local cls = line:match("^%-%-%-@class (%w+)")
  if cls then
    if cur and want[cur] then out[cur] = buf end
    cur = cls
    buf = {}
  end
  if cur and (line:find("^%-%-%-@field") or line:find("^%-%-%-@class")) then
    buf[#buf + 1] = line:sub(1, 200)
  end
end
if cur and want[cur] then out[cur] = buf end
return out

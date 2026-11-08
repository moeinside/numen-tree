-- P24 只读：numen.status 分组帮助（切片，每片 200 字符）
local function slices(s)
  s = tostring(s)
  local out = {}
  local i = 1
  while i <= #s do
    out[#out + 1] = s:sub(i, i + 199)
    i = i + 200
  end
  return out
end
local ok, h = pcall(numen.api.help, "numen.status")
if not ok then return { ERR = tostring(h) } end
return { status = slices(h) }

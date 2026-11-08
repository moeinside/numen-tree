-- P29 只读：numen.work + numen.use 分组帮助（切片）
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
local out = {}
for _, name in ipairs({ "numen.work", "numen.use" }) do
  local ok, h = pcall(numen.api.help, name)
  out[name] = ok and slices(h) or { "ERR: " .. tostring(h) }
end
return out

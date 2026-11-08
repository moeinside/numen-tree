-- P20 只读：numen.api.help() 总览 + 分组名，切成 <=200 字符片段返回
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
local ok, h = pcall(numen.api.help)
out["api.help() type"] = type(h)
if ok and type(h) == "table" then
  local keys = {}
  for k in pairs(h) do
    keys[#keys + 1] = tostring(k)
  end
  table.sort(keys)
  out["api.help() keys"] = keys
  out["api.help() count"] = #keys
elseif ok then
  out["api.help()"] = slices(h)
else
  out["api.help() ERR"] = tostring(h)
end

return out

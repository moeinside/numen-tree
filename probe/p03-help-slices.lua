-- P03 只读：把帮助文本切成 <=220 字符的片段返回，绕开单值截断
local function slices(s)
  local out = {}
  local i = 1
  while i <= #s do
    out[#out + 1] = s:sub(i, i + 219)
    i = i + 220
  end
  return out
end

local out = {}
for _, name in ipairs({ "numen.task", "numen.task.status", "numen.task.stop" }) do
  local ok, h = pcall(numen.api.help, name)
  out[name] = ok and slices(h) or { "ERR: " .. tostring(h) }
end
return out

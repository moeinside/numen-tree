-- P27 只读：numen.gui 分组帮助（切片）+ task.timer 全文
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
local ok, h = pcall(numen.api.help, "numen.gui")
out.gui = ok and slices(h) or { "ERR: " .. tostring(h) }
ok, h = pcall(numen.api.help, "numen.task.timer")
out.timer = ok and slices(h) or { "ERR: " .. tostring(h) }
return out

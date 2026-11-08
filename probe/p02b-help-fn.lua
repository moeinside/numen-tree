-- P02b 只读：按函数精确取帮助（绕过单值截断）
local out = {}
for _, name in ipairs({
  "numen.task",
  "numen.task.status",
  "numen.task.stop",
  "numen.task.timer",
  "numen.move",
  "numen.move.go",
  "numen.move.follow",
  "numen.route.plan",
}) do
  local ok, h = pcall(numen.api.help, name)
  out[name] = ok and h or ("ERR: " .. tostring(h))
end
return out

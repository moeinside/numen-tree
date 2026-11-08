-- P02 只读：API 帮助（任务组 / 移动组），确认官方签名
local out = {}
local ok, h = pcall(numen.api.help, "numen.task")
out.task_help = ok and h or ("ERR: " .. tostring(h))

local ok2, m = pcall(numen.api.help, "numen.move")
out.move_help = ok2 and m or ("ERR: " .. tostring(m))

return out

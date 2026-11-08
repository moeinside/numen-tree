-- P01 只读：自身状态 / 世界 / 当前任务 / 时钟可用性
local out = {}
out.self = numen.status.self()
out.world = numen.status.world()

local ok, t = pcall(numen.task.status)
if ok then
  out.task = t
else
  out.task_err = tostring(t)
end

local ok2, w = pcall(numen.time.wait, 0)
if ok2 then
  out.wait_ret = w
  out.wait_type = type(w)
else
  out.wait_err = tostring(w)
end

local ok3, mods = pcall(numen.module.list)
if ok3 then
  out.modules = mods
else
  out.modules_err = tostring(ok3 and mods or mods)
end

return out

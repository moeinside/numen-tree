-- P06 会移动：走到 20 格外的一个点，观察阻塞时长与任务记录
local target = { x = -15, y = 68, z = 33 } -- 从当前 (-15.4, 68, 13.4) 向北约 20 格
local out = {}
out.before = numen.status.self().pos
out.at_start_task = numen.task.status()

local p = numen.route.plan({ to = target, arrive = "near", range = 2, costs = { dig = true, place = true } })
out.plan = { ok = p.ok, steps = p.steps, seconds = p.seconds, why = p.why }
if not p.ok then
  return out
end

local ok, walked = pcall(numen.move.go, p)
out.move_ok = ok
out.walked = ok and walked or tostring(walked)
out.after = numen.status.self().pos
out.at_end_task = numen.task.status()
return out

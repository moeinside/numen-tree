-- P10 会移动：后台任务运行中再派一个新任务，观察"抢占/取代"语义
local o = numen.status.owner()
local out = {}
out.before = numen.task.status()

local ok, r = pcall(numen.move.to, o.pos, {
  arrive = "near",
  range = 2,
  costs = { dig = true, place = true },
})
out.new_task_ok = ok
out.new_task_ret = ok and r or tostring(r)
out.after = numen.task.status()
return out

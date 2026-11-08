-- P07 会移动：走回出发区，用于测试"程序运行中"的其他工具
local target = { x = -15, y = 68, z = 15 }
local p = numen.route.plan({ to = target, arrive = "near", range = 2, costs = { dig = true, place = true } })
if not p.ok then
  return { plan_ok = false, why = p.why }
end
local ok, walked = pcall(numen.move.go, p)
return { plan_seconds = p.seconds, move_ok = ok, walked = ok and walked or tostring(walked) }

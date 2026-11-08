-- P08 会移动：走到主人身边
local o = numen.status.owner()
if not o.online then
  return { ok = false, why = "owner offline" }
end

local p = numen.route.plan({
  to = o.pos,
  arrive = "near",
  range = 3,
  costs = { dig = true, place = true },
})
if not p.ok then
  return { ok = false, why = p.why, steps = p.steps }
end

local ok, w = pcall(numen.move.go, p)
return {
  ok = ok,
  plan_seconds = p.seconds,
  plan_steps = p.steps,
  walked = ok and w or tostring(w),
  owner_at = o.pos,
  after = numen.status.self().pos,
}

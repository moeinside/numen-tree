-- P22 只读：status / inv / gear / fight / task 分组帮助
local function one(name)
  local ok, h = pcall(numen.api.help, name)
  return ok and tostring(h) or ("ERR: " .. tostring(h))
end
local out = {}
out.status = one("numen.status")
out.inv = one("numen.inv")
out.gear = one("numen.gear")
out.fight = one("numen.fight")
out.task = one("numen.task")
return out

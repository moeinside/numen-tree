-- P04 只读：从帮助里筛出与"预算/超时/后台/停止"相关的行
local patterns = {
  "second", "budget", "timeout", "wait", "async", "background",
  "stop", "cancel", "limit", "max", "queue", "fire", "event",
}

local function interesting(s)
  local out = {}
  for line in (s .. "\n"):gmatch("(.-)\n") do
    local low = line:lower()
    for _, p in ipairs(patterns) do
      if low:find(p, 1, true) then
        out[#out + 1] = line
        break
      end
    end
  end
  return out
end

local out = {}
for _, name in ipairs({
  "numen.move.go",
  "numen.route.plan",
  "numen.move.follow",
  "numen.work.dig",
  "numen.task.timer",
}) do
  local ok, h = pcall(numen.api.help, name)
  if ok then
    local lines = interesting(h)
    local trimmed = {}
    for i = 1, math.min(#lines, 24) do
      trimmed[#trimmed + 1] = lines[i]:sub(1, 200)
    end
    out[name] = trimmed
  else
    out[name] = { "ERR: " .. tostring(h) }
  end
end
return out

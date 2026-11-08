-- P30 只读：只取帮助里的签名行（---@field / ---@class / function ...），每行截断
local function sigs(group)
  local ok, h = pcall(numen.api.help, group)
  if not ok then return { "ERR: " .. tostring(h) } end
  h = tostring(h)
  local out = {}
  for line in (h .. "\n"):gmatch("(.-)\n") do
    if line:find("^%-%-%-@field") or line:find("^%-%-%-@class") or line:find("^function ") then
      out[#out + 1] = line:sub(1, 190)
    end
  end
  return out
end
return {
  scan = sigs("numen.scan"),
  route = sigs("numen.route"),
  move = sigs("numen.move"),
}

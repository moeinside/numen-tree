-- P31 只读：只要函数签名行（---@field 名字 fun），扫描/移动/路线/建造/时间/定位
local function fns(group)
  local ok, h = pcall(numen.api.help, group)
  if not ok then return { "ERR: " .. tostring(h) } end
  local out = {}
  for line in (tostring(h) .. "\n"):gmatch("(.-)\n") do
    if line:find("^%-%-%-@field %w+ fun") then
      out[#out + 1] = line:sub(1, 200)
    end
  end
  return out
end
return {
  scan = fns("numen.scan"),
  move = fns("numen.move"),
  route = fns("numen.route"),
  build = fns("numen.build"),
  time = fns("numen.time"),
  locate = fns("numen.locate"),
  creative = fns("numen.creative"),
}

-- P21 只读：help 分组名 + module.list，切片
local function slices(s)
  s = tostring(s)
  local out = {}
  local i = 1
  while i <= #s do
    out[#out + 1] = s:sub(i, i + 199)
    i = i + 200
  end
  return out
end

local out = {}
for _, name in ipairs({ "numen", "numen.api", "numen.status", "numen.scan" }) do
  local ok, h = pcall(numen.api.help, name)
  out["help:" .. name] = ok and slices(h) or ("ERR: " .. tostring(h))
end

local ok, m = pcall(numen.module.list)
if ok then
  out["module.list type"] = type(m)
  if type(m) == "table" then
    local keys = {}
    for k, v in pairs(m) do
      keys[#keys + 1] = tostring(k) .. "=" .. (type(v) == "string" and v:sub(1, 90) or type(v))
    end
    table.sort(keys)
    out["module.list"] = keys
  else
    out["module.list"] = slices(m)
  end
else
  out["module.list ERR"] = tostring(m)
end
return out

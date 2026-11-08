-- P40 只读：列背包物品 + 站立点/手持（用于挑可放置方块）
local out = { items = {} }
local ok, v = pcall(numen.inv.items)
if ok and type(v) == "table" then
  out.n = #v
  for i = 1, #v do
    local s = v[i]
    out.items[#out.items + 1] = tostring(s.item) .. " x" .. tostring(s.count)
  end
else
  out.err = tostring(v)
end
local ok2, st = pcall(numen.status.self)
if ok2 and type(st) == "table" then
  out.name = tostring(st.name)
  if st.pos then
    out.pos = tostring(st.pos.x) .. "," .. tostring(st.pos.y) .. "," .. tostring(st.pos.z)
  end
  if st.hands and st.hands.mainhand then
    out.mainhand = tostring(st.hands.mainhand.item) .. " x" .. tostring(st.hands.mainhand.count)
  end
  if st.backpack_slots then
    out.slots = tostring(st.backpack_slots.used) .. "/" .. tostring(st.backpack_slots.total)
  end
end
return out

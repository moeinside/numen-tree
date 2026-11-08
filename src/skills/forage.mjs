import { LUA_PRELUDE } from './prelude.mjs';

/**
 * forage —— 打猎取肉：找附近的牛/猪/羊/鸡/兔，打死、走过去捡肉。
 *
 * 只做一件事（树的设计边界：技能只管"怎么做"，判断"该不该做"归仲裁器）。
 * 打不到 / 附近没有可吃的动物 → 报 not_found，由仲裁器决定是去搜箱子还是探索。
 *
 * params:
 *   radius number = 24  找猎物的半径
 *   max    number = 2   一次最多猎几只（防止长任务跑太久）
 */
export default {
  id: 'forage',
  title: '打猎取肉（打被动生物）',
  params: { radius: 'number = 24', max: 'number = 2' },
  build(ctx, params = {}) {
    const radius = Math.max(8, Number(params.radius ?? 24));
    const max = Math.min(4, Math.max(1, Number(params.max ?? 2)));

    const code = `${LUA_PRELUDE}
-- 能吃的被动生物
local EDIBLE = { cow = 1, pig = 1, sheep = 1, chicken = 1, rabbit = 1 }
-- 它们的掉落（生肉），用来判断"肉到没到包里"
local MEAT = {
  beef = 1, porkchop = 1, chicken = 1, mutton = 1, rabbit = 1,
}

local function scanKind(k, r)
  local ok, list = pcall(numen.scan.entities, k, { radius = r })
  if ok and type(list) == "table" then return list end
  return nil
end

local function edibleNear(r)
  local out = {}
  -- 过滤名以实战为准：先试 passive，不行再试 animal，都不行就当没有
  local list = scanKind("passive", r) or scanKind("animal", r) or {}
  for _, e in ipairs(list) do
    local ty = tostring(e.type or e.kind or "")
    local short = ty:match("([%w_]+)$") or ty
    if EDIBLE[short] then out[#out + 1] = e end
  end
  table.sort(out, function(a, b) return (a.distance or 999) < (b.distance or 999) end)
  return out
end

local function meatInBag()
  local n = 0
  for _, it in ipairs(numen.inv.items() or {}) do
    local name = tostring(it.item or it.id or it.name or "")
    local short = name:match("([%w_]+)$") or name
    if MEAT[short] then n = n + (tonumber(it.count or it.n) or 1) end
  end
  return n
end

local ok, r = pcall(function()
  local before = meatInBag()
  local killed, last = 0, nil

  for _ = 1, ${max} do
    local list = edibleNear(${radius})
    if #list == 0 then break end
    local target = list[1]
    local pos = target.pos
    local ty = tostring(target.type or "")

    local k, err = pcall(numen.fight.attack, target)
    if k then
      killed = killed + 1
      last = ty
      -- ★ 掉落物不会自己进包：必须让身体走过去捡（默认半径 8）
      if pos then
        pcall(numen.move.to, { x = pos.x, y = pos.y, z = pos.z }, { arrive = "near", range = 1.5 })
      end
      pcall(numen.work.collect)
      if meatInBag() > before then break end
    elseif type(err) == "table" and err.kind == "not_found" then
      -- 目标已经死了/跑了，去找下一只
    else
      error(err, 0)
    end
  end

  local after = meatInBag()
  if killed == 0 then
    error({
      kind = "not_found",
      message = "no edible animal (cow/pig/sheep/chicken/rabbit) within ${radius} blocks",
    })
  end
  return { killed = killed, before = before, after = after, last = last }
end)
if not ok then return FAIL(r) end
return J({
  { "killed", N(r.killed) },
  { "meat_before", N(r.before) },
  { "meat", N(r.after) },
  { "animal", S(r.last) },
})
`;
    return { code, timeoutMs: 210_000 };
  },
};

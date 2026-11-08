import { LUA_PRELUDE } from './prelude.mjs';

/**
 * fight_safe —— 带"打不过就跑"守卫的战斗：一次清掉附近的敌对。
 *
 * 与 fight_nearest 的区别：每一刀之后都重新看血量和敌人数量，
 * 触发撤退条件就立刻 `move.flee` 走人，而不是硬打到死。
 *
 * params:
 *   radius       number = 16   找敌人的半径
 *   minHp        number = 8    血掉到这个数就撤
 *   maxTargets   number = 2    敌人超过这个数就撤
 *   fleeDistance number = 16   撤退拉开多远
 *   maxFights    number = 6    最多打几场，防止无限循环
 */
export default {
  id: 'fight_safe',
  title: '有守卫的打架（打不过就跑）',
  params: {
    radius: 'number = 16',
    minHp: 'number = 8',
    maxTargets: 'number = 2',
    fleeDistance: 'number = 16',
    maxFights: 'number = 6',
  },
  build(ctx, params = {}) {
    const radius = Math.max(4, Number(params.radius ?? 16));
    const minHp = Math.max(1, Number(params.minHp ?? 8));
    const maxTargets = Math.max(1, Number(params.maxTargets ?? 2));
    const fleeDistance = Math.max(4, Number(params.fleeDistance ?? 16));
    const maxFights = Math.min(12, Math.max(1, Number(params.maxFights ?? 6)));

    const code = `${LUA_PRELUDE}
local function hostiles(r)
  local list = numen.scan.entities("hostile", { radius = r }) or {}
  table.sort(list, function(a, b) return (a.distance or 999) < (b.distance or 999) end)
  return list
end

local ok, r = pcall(function()
  local fought, fled, gave_up = 0, false, false
  local hp = numen.status.self().hp

  for _ = 1, ${maxFights} do
    if hp <= ${minHp} then
      fled = true
      break
    end
    local list = hostiles(${radius})
    if #list == 0 then break end

    -- 被围：敌人多且血不满就撤
    if #list > ${maxTargets} and hp <= 14 then
      fled = true
      break
    end

    local foe = list[1]
    local k, err = pcall(numen.fight.attack, foe)
    if k then
      fought = fought + 1
    elseif type(err) == "table" and err.kind == "not_found" then
      -- 目标已经死了/跑了，接着找下一个
    else
      error(err, 0)
    end

    hp = numen.status.self().hp
    if hp <= ${minHp} then
      fled = true
      break
    end
  end

  hp = numen.status.self().hp
  local list = hostiles(${radius})
  if #list > 0 and (fled or hp <= ${minHp}) then
    pcall(numen.move.flee, list[1], { distance = ${fleeDistance} })
    fled = true
  end
  gave_up = (#list > 0 and hp <= ${minHp})
  return {
    fought = fought,
    hp = numen.status.self().hp,
    left = #hostiles(${radius}),
    fled = fled,
    gave_up = gave_up,
  }
end)
if not ok then return FAIL(r) end
return J({
  { "fought", N(r.fought) },
  { "hp", N(r.hp) },
  { "left", N(r.left) },
  { "fled", r.fled and "true" or "false" },
  { "gave_up", r.gave_up and "true" or "false" },
})
`;
    return { code, timeoutMs: 200_000 };
  },
};

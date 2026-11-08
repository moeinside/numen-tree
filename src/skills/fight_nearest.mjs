import { LUA_PRELUDE } from './prelude.mjs';

/**
 * fight_nearest —— 打最近的敌对生物（走过去、打死/打退为止）。
 * params: radius (默认 16)
 */
export default {
  id: 'fight_nearest',
  title: '打最近的敌对生物',
  params: { radius: 'number = 16' },
  build(ctx, params = {}) {
    const radius = Math.max(4, Number(params.radius ?? 16));
    const code = `${LUA_PRELUDE}
local ok, r = pcall(function()
  local best = nil
  for _, e in ipairs(numen.scan.entities("hostile", { radius = ${radius} }) or {}) do
    if best == nil or (e.distance or 999) < (best.distance or 999) then best = e end
  end
  if best == nil then return { none = true } end
  local before = numen.status.self().hp
  numen.fight.attack(best.id)
  return {
    type = best.type,
    id = best.id,
    hp_before = before,
    hp_after = numen.status.self().hp,
  }
end)
if not ok then return FAIL(r) end
if r.none then return J({ { "none", "true" } }) end
return J({
  { "target", S(r.type) },
  { "id", N(r.id) },
  { "hp_before", N(r.hp_before) },
  { "hp_after", N(r.hp_after) },
})
`;
    return { code, timeoutMs: 180_000 };
  },
};

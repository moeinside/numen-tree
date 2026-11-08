import { LUA_PRELUDE } from './prelude.mjs';

/**
 * retreat —— 远离最近的敌对生物。
 * params: distance (默认 10), radius (默认 24)
 */
export default {
  id: 'retreat',
  title: '远离最近的敌对生物',
  params: { distance: 'number = 10', radius: 'number = 24' },
  build(ctx, params = {}) {
    const distance = Math.max(4, Number(params.distance ?? 10));
    const radius = Math.max(4, Number(params.radius ?? 24));
    const code = `${LUA_PRELUDE}
local ok, r = pcall(function()
  local best = nil
  for _, e in ipairs(numen.scan.entities("hostile", { radius = ${radius} }) or {}) do
    if best == nil or (e.distance or 999) < (best.distance or 999) then best = e end
  end
  if best == nil then return { none = true } end
  numen.move.flee(best, { distance = ${distance} })
  return { type = best.type, id = best.id }
end)
if not ok then return FAIL(r) end
if r.none then return J({ { "none", "true" } }) end
return J({ { "from", S(r.type) }, { "id", N(r.id) } })
`;
    return { code, timeoutMs: 120_000 };
  },
};

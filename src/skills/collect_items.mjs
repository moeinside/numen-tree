import { LUA_PRELUDE } from './prelude.mjs';

/**
 * collect_items —— 把附近掉在地上的物品捡进背包（`numen.work.dig` 只打碎方块，不会自动捡）。
 *
 * 用途：采集配方在 dig_nearby 之后接一步，否则木头/圆石都掉在地上，背包永远是空的。
 *
 * params:
 *   radius number = 16（捡取半径；模块自带"走近→捡"循环）
 *
 * 返回：{collected:N}（0 也当成功：可能是没东西可捡/被别人捡走，配方按后续步骤判断）
 * 失败：failed（collect 抛错）
 *
 * 纪律：不用 numen.task.timer；单次工作交给 numen.work.collect 模块，API 调用数很小。
 */
export default {
  id: 'collect_items',
  title: '捡起附近掉落物',
  params: { radius: 'number = 16' },
  meta: { gives: ['items'], risk: 'low', budgetMs: 120_000 },
  build(ctx, params = {}) {
    const radius = Math.min(64, Math.max(1, Math.floor(Number(params.radius ?? 16)) || 16));
    const code = `${LUA_PRELUDE}
local RADIUS = ${radius}
local ok, r = pcall(function()
  local cOk, cRes = pcall(numen.work.collect, { radius = RADIUS })
  if not cOk then
    -- 退路：帮助文本只写了 collect(opts?)，不确定 radius 参数名时用默认调用再试一次
    local cOk2, cRes2 = pcall(numen.work.collect)
    if not cOk2 then
      error({ kind = "failed", message = "collect 失败：" .. tostring(cRes2),
        hint = "周围可能没有掉落物或背包满" })
    end
    return { collected = tonumber(cRes2) or 0 }
  end
  return { collected = tonumber(cRes) or 0 }
end)
if not ok then return FAIL(r) end
return J({ { "collected", N(r.collected) } })
`;
    return { code, timeoutMs: 120_000 };
  },
};

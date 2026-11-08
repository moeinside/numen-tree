import { LUA_PRELUDE } from './prelude.mjs';

/**
 * dig_cells —— 精确挖掉指定格子（只挖给点名的方块），可选顺手捡掉落物。
 *
 * 用途：修地形/削平室内凸起、挖掉挡路的方块。和 dig_nearby 不同：不扫描、不乱挖，
 * 只处理传给它的 cells 列表；够不着的格子会跳过（返回 dug < attempted）。
 *
 * params:
 *   cells   array [{x,y,z}]（必填；≤40 个，控制 Lua API 调用数）
 *   walk    boolean = false（true=每个格子先 move.to 走近再挖，适合够不着的格子）
 *   collect boolean = true（挖完顺手 work.collect 捡掉落物）
 *
 * 返回：{attempted:N, dug:N, skipped:N}；一个都没挖到且确实有非空气格 → failed/out_of_reach
 *
 * 注意：-- skill: dig_cells（用于回放识别，别删）
 */
export default {
  id: 'dig_cells',
  title: '精确挖指定格子',
  params: {
    cells: 'array [{x,y,z}]（必填，≤40）',
    walk: 'boolean = false（先走近再挖）',
    collect: 'boolean = true',
  },
  meta: { gives: ['dug-cells'], risk: 'medium', budgetMs: 120_000 },
  build(ctx, params = {}) {
    const cells = Array.isArray(params.cells) ? params.cells : [];
    const clean = cells
      .filter((c) => c && ['x', 'y', 'z'].every((k) => Number.isFinite(Number(c[k]))))
      .slice(0, 40)
      .map((c) => ({ x: Math.floor(Number(c.x)), y: Math.floor(Number(c.y)), z: Math.floor(Number(c.z)) }));
    if (!clean.length) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 cells 参数", "示例 cells=[{x:-57,y:64,z:101}]")`,
        timeoutMs: 5000,
      };
    }
    const doCollect = params.collect !== false;
    const doWalk = params.walk === true || params.walk === 'true';
    const cellsLua = `{ ${clean.map((c) => `{ x = ${c.x}, y = ${c.y}, z = ${c.z} }`).join(', ')} }`;

    const code = `${LUA_PRELUDE}
-- skill: dig_cells
local CELLS = ${cellsLua}
local DO_COLLECT = ${doCollect ? 'true' : 'false'}
local DO_WALK = ${doWalk ? 'true' : 'false'}

local ok, r = pcall(function()
  local attempted, dug, skipped = 0, 0, 0
  for _, c in ipairs(CELLS) do
    -- 先走到目标格上方（站在要挖的方块上/旁边），再挖；够不着的格子交给下一轮
    if DO_WALK then
      pcall(numen.move.to, { x = c.x, y = c.y + 1, z = c.z }, { arrive = "near" })
    end
    local b = numen.scan.block(c)
    if b == nil or b.is_air == true then
      skipped = skipped + 1
    else
      attempted = attempted + 1
      local dOk = pcall(numen.work.dig, c, { count = 1 })
      local after = numen.scan.block(c)
      if dOk and after ~= nil and after.is_air == true then
        dug = dug + 1
      end
    end
  end
  if DO_COLLECT then
    pcall(numen.work.collect, { radius = 8 })
  end
  if attempted > 0 and dug <= 0 then
    error({ kind = "out_of_reach", message = "一个指定格子都没挖掉（够不着/工具不对）" })
  end
  return { attempted = attempted, dug = dug, skipped = skipped }
end)
if not ok then return FAIL(r) end
return J({
  { "attempted", N(r.attempted) },
  { "dug", N(r.dug) },
  { "skipped", N(r.skipped) },
})
`;
    return { code, timeoutMs: 180_000 };
  },
};

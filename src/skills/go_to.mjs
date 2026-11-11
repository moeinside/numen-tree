import { LUA_PRELUDE, luaLiteral } from './prelude.mjs';

/**
 * go_to —— 走到目标点 / 主人身边（**分段走**，每段最多 ~8 秒，段与段之间树可中断）。
 *
 * params:
 *   target      "owner" | { x, y, z } | { x, z }
 *   range       number，到达判定半径（默认 2）
 *   chunkBlocks number，每段最多走几格（默认 12，越小越容易被中断）
 *   maxChunks   number，一次调用最多走几段（默认 3 → ≤~24 秒）
 *
 * 返回：arrived=true 表示到点；arrived=false + partial=1 表示还有进度但没走完，
 * 树会自动续派下一段（中间会先跑中断检查）。
 */
export default {
  id: 'go_to',
  title: '走到目标点 / 主人身边（分段）',
  params: {
    target: 'owner | {x,y,z} | {x,z}',
    range: 'number = 2',
    chunkBlocks: 'number = 12',
    maxChunks: 'number = 3',
  },
  build(ctx, params = {}) {
    const range = Math.max(1, Number(params.range ?? 2));
    const chunkBlocks = Math.max(4, Number(params.chunkBlocks ?? 12));
    const maxChunks = Math.max(1, Math.min(12, Number(params.maxChunks ?? 3)));
    let targetExpr;
    if (params.target === 'owner' || params.target === undefined) {
      targetExpr = 'numen.status.owner().pos';
    } else {
      targetExpr = luaLiteral(params.target);
    }

    const code = `${LUA_PRELUDE}
local RANGE = ${range}
local TOL = RANGE + 1.5 -- 到达容差：差一两格别死磕（目标点常被占/高差）
local CHUNK = ${chunkBlocks}
local MAXC = ${maxChunks}

local function distTo(me, t)
  if t == nil then return nil end
  -- 水平距离判定到达：目标点 y 差个 1~3 格很常见（站台/台阶），别因此永远"到不了"
  local dx, dz = me.x - t.x, me.z - t.z
  return math.sqrt(dx * dx + dz * dz)
end

local ok, r = pcall(function()
  local o = numen.status.owner()
  local target = ${targetExpr}
  if target == nil then
    error({ kind = "owner_offline", message = "owner is offline" })
  end

  local me0 = numen.status.self().pos
  local before = distTo(me0, target)
  if before <= TOL then
    return { arrived = true, before = before, after = before, chunks = 0 }
  end

  local last = before
  local chunks = 0
  local noProgress = 0
  for _ = 1, MAXC do
    local me = numen.status.self().pos
    local d = distTo(me, target)
    if d <= TOL then
      last = d
      break
    end
    local step = math.min(CHUNK, d - RANGE)
    if step < 1 then break end
    if step <= 4 then
      -- 最后几格：直接走到目标点（分小段会因为"range=2 视为已到达"而原地打转）
      pcall(numen.move.to, { x = target.x, y = target.y or me.y, z = target.z }, { arrive = "near", range = RANGE, avoid = { "water", "flowing_water" } })
    else
      local wx = me.x + (target.x - me.x) / d * step
      local wz = me.z + (target.z - me.z) / d * step
      -- 不主动爬升/下降（路点 y 用当前层），避免"目标高两格就永远走不到"
      pcall(numen.move.to, { x = wx, y = me.y, z = wz }, { arrive = "near", range = 1, avoid = { "water", "flowing_water" } })
    end
    local after = numen.status.self().pos
    local nd = distTo(after, target)
    if nd >= last - 0.5 then
      noProgress = noProgress + 1
    else
      noProgress = 0
    end
    last = nd
    chunks = chunks + 1
    if noProgress >= 2 then break end
  end

  local arrived = last <= TOL
  if not arrived and noProgress >= 2 and last >= before - 0.5 then
    error({ kind = "no_path", message = "朝目标走了几段都没有进展（地形/水/卡住）" })
  end
  return { arrived = arrived, before = before, after = last, chunks = chunks }
end)
if not ok then return FAIL(r) end

if r.arrived then
  return J({
    { "arrived", "true" },
    { "dist_before", N(r.before) },
    { "dist", N(r.after) },
    { "chunks", N(r.chunks) },
  })
end
return J({
  { "arrived", "false" },
  { "partial", "true" },
  { "dist_before", N(r.before) },
  { "dist", N(r.after) },
  { "chunks", N(r.chunks) },
})
`;
    return { code, timeoutMs: Math.min(120, maxChunks * 15 + 20) * 1000 };
  },
};

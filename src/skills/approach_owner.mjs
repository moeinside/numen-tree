import { LUA_PRELUDE } from './prelude.mjs';

/**
 * approach_owner —— 分段追踪主人（目标点动态刷新，不会"跑到你上一个位置"）。
 *
 * 每段最多 chunkSeconds 秒走 follow（跟着移动中的主人），然后重新取距离再决定要不要继续；
 * 段与段之间树有机会做中断判断（遇敌/主人挨打），不会一口气闷头跑到底。
 *
 * params:
 *   range        number = 4   到多近算到了
 *   chunkSeconds number = 8   每段最多走多久
 *   maxChunks    number = 8   最多几段（≈ 总预算）
 */
export default {
  id: 'approach_owner',
  title: '分段追着主人跑（目标动态刷新）',
  params: {
    range: 'number = 4',
    chunkSeconds: 'number = 8',
    maxChunks: 'number = 8',
  },
  meta: {
    needs: ['owner-online'],
    gives: ['near-owner'],
    risk: 'low',
    budgetMs: 90_000,
  },
  build(ctx, params = {}) {
    const range = Math.max(1, Number(params.range ?? 4));
    const chunkSeconds = Math.min(20, Math.max(2, Number(params.chunkSeconds ?? 8)));
    const maxChunks = Math.min(16, Math.max(1, Number(params.maxChunks ?? 8)));

    const code = `${LUA_PRELUDE}
local RANGE = ${range}
local CHUNK = ${chunkSeconds}
local MAXC = ${maxChunks}

local function ownerDist()
  local o = numen.status.owner()
  if not o or not o.online then return nil end
  return o.distance
end

local ok, r = pcall(function()
  local start = ownerDist()
  if start == nil then
    error({ kind = "owner_offline", message = "主人不在线" })
  end
  if start <= RANGE then
    return { before = start, after = start, chunks = 0 }
  end

  local last = start
  local chunks = 0
  for _ = 1, MAXC do
    local d = ownerDist()
    if d == nil then
      error({ kind = "owner_offline", message = "追到一半主人下线了" })
    end
    if d <= RANGE then
      last = d
      break
    end
    -- 每段：跟着"现在主人所在的位置"走 CHUNK 秒（move.follow 会动态跟随）
    pcall(numen.move.follow, nil, { distance = RANGE, seconds = CHUNK })
    last = ownerDist() or last
    chunks = chunks + 1
  end
  return { before = start, after = last, chunks = chunks }
end)
if not ok then return FAIL(r) end

if r.after <= RANGE then
  return J({
    { "arrived", "true" },
    { "dist_before", N(r.before) },
    { "dist", N(r.after) },
    { "chunks", N(r.chunks) },
  })
end
return J({
  { "arrived", "false" },
  { "dist_before", N(r.before) },
  { "dist", N(r.after) },
  { "chunks", N(r.chunks) },
})
`;
    return { code, timeoutMs: (maxChunks * (chunkSeconds + 8) + 20) * 1000 };
  },
};

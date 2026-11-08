import { LUA_PRELUDE } from './prelude.mjs';

/**
 * dig_nearby —— 挖附近的一种方块（**分段挖**：一次最多 countPerChunk 个，挖不完返回 partial）。
 *
 * 流程（全部包在 pcall 里，失败带 kind）：
 *   1) scan.blocks(BLOCK, {radius}) **只扫一次**，把各簇的方块摊平（§12：单程序 200 次调用上限）；
 *   2) 候选按"够得着优先、其次由近到远"排序（Block 的 in_reach / distance 字段，§3.2）；
 *   3) **一块一块**试 numen.work.dig：单块报错（out_of_reach 等）只跳过这一块、换下一个候选，
 *      不会像整批 dig 那样被一个够不着的块带崩；
 *   4) 最多试 MAX_TRY 个候选（1 次 scan + ≤6 次 dig），累计 dug，达到本段目标（min(WANT, PER)）
 *      或候选用尽即停；有进展就返回 partial + remaining（分片约定），一个都没挖到才 FAIL，
 *      并保留最后一次的 kind（out_of_reach / not_found / …）。
 *
 * 纪律：不用 numen.task.timer（会打断程序）；scan 只做一次；API 调用数固定上限。
 *
 * params:
 *   block          string（方块 id）
 *   count          number 总数（默认 8）
 *   radius         number 扫描半径（默认 24）
 *   countPerChunk  number 每次最多挖几个（默认 2）
 */
export default {
  id: 'dig_nearby',
  title: '挖附近指定方块（分段）',
  params: {
    block: 'string（必填，如 minecraft:stone）',
    count: 'number = 8',
    radius: 'number = 24',
    countPerChunk: 'number = 2',
  },
  build(ctx, params = {}) {
    const block = String(params.block || '');
    if (!block) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 block 参数", "示例 minecraft:oak_log")`,
        timeoutMs: 5000,
      };
    }
    const count = Math.max(1, Number(params.count ?? 8));
    const radius = Math.max(4, Number(params.radius ?? 24));
    const per = Math.max(1, Math.min(count, Number(params.countPerChunk ?? 2)));
    const safe = block.replace(/'/g, "\\'");
    const code = `${LUA_PRELUDE}
local BLOCK = '${safe}'
local WANT = ${count}
local PER = ${per}
local RADIUS = ${radius}
-- 单次程序最多试几个候选：1 次 scan + ≤MAX_TRY 次 dig，远低于 200 次调用上限
local MAX_TRY = 6

local ok, r = pcall(function()
  local clusters = numen.scan.blocks(BLOCK, { radius = RADIUS })
  if clusters == nil or #clusters == 0 then
    error({ kind = "not_found", message = "no " .. BLOCK .. " within " .. RADIUS .. " blocks" })
  end

  -- 把所有簇里的方块摊平当候选：scan 只做这一次，后面纯本地排序
  local cand = {}
  for _, c in ipairs(clusters) do
    local list = (type(c) == "table" and (c.blocks or c)) or {}
    if type(list) == "table" then
      for _, b in ipairs(list) do
        if type(b) == "table" then cand[#cand + 1] = b end
      end
    end
  end
  if #cand == 0 then
    error({ kind = "not_found", message = "no diggable " .. BLOCK .. " within " .. RADIUS .. " blocks" })
  end

  -- 够得着的排前面，其次由近到远；in_reach/distance 缺省时按"未知"处理（仍可尝试）
  local function distOf(b)
    return tonumber(b.distance) or 999
  end
  table.sort(cand, function(a, b)
    local ra = a.in_reach == false and 1 or 0
    local rb = b.in_reach == false and 1 or 0
    if ra ~= rb then return ra < rb end
    return distOf(a) < distOf(b)
  end)

  -- 本段目标沿用分片约定：一次程序最多挖 PER 个，剩下的靠 partial 续派
  local target = WANT
  if PER < target then target = PER end

  local dug, drops, tries, lastKind = 0, 0, 0, nil
  for i = 1, #cand do
    if dug >= target or tries >= MAX_TRY then break end
    tries = tries + 1
    local b = cand[i]
    local cell = b.pos or b
    -- ★ 一块一次：哪个候选报错（out_of_reach 等）只影响它自己，换下一块继续
    local okb, out = pcall(numen.work.dig, cell, { count = 1 })
    if type(out) == "table" then
      -- 正常返回 Dug；也兼容"挖到一部分再抛错"的实现（错误表里带 dug/drops 就计入进度）
      local d = tonumber(out.dug) or 0
      dug = dug + d
      drops = drops + #(out.drops or {})
      if not okb then
        lastKind = out.kind or lastKind
      elseif d <= 0 then
        if out.kind then
          lastKind = out.kind
        elseif (tonumber(out.out_of_reach) or 0) > 0 then
          lastKind = "out_of_reach"
        end
      end
    elseif not okb then
      if lastKind == nil then lastKind = "failed" end
    end
  end

  -- 一个都没挖到才算失败：把最后一次的 kind 带回去（树靠它决定 retry 还是换树种）
  if dug <= 0 then
    error({
      kind = lastKind or "failed",
      message = "dug nothing: no reachable " .. BLOCK .. " among " .. tries .. " tried cell(s)",
    })
  end
  local left = WANT - dug
  if left < 0 then left = 0 end
  return { dug = dug, left = left, drops = drops }
end)
if not ok then return FAIL(r) end

if r.left > 0 then
  return J({
    { "partial", "true" },
    { "dug", N(r.dug) },
    { "remaining", N(r.left) },
    { "drops", N(r.drops) },
  })
end
return J({
  { "dug", N(r.dug) },
  { "left", N(0) },
  { "drops", N(r.drops) },
})
`;
    return { code, timeoutMs: 180_000 };
  },
};

import { LUA_PRELUDE } from './prelude.mjs';
import { baseRegions, luaRegions } from '../base-guard.mjs';

/**
 * mine_nearby —— 挖附近一簇方块里的一小批：用 `numen.work.mine(cluster)`（自带"走近→挖→捡"）。
 *
 * 为什么需要它：`numen.work.dig` 只挖"手够得着"的格子、不会走过去，站在树/矿附近但不在伸手范围
 * 时会全部 out_of_reach。`work.mine` 会走到簇边再挖并顺手捡起掉落物，适合采集。
 *
 * 重要约束/坑：
 *  - `work.mine(cluster)` 会挖**整簇**——地下石头簇可能巨大。这里先用
 *    `numen.scan.cluster(blocks)` 把"最近 N 块"包成小簇再 mine，单段最多 8 块；
 *  - `work.mine` 的返回值实测**不可靠**（挖了一堆圆石却返回 nil），所以"挖到多少"用
 *    **背包里掉落物的前后差**来算（方块→掉落物映射见 DROP_OF）。
 *
 * params:
 *   block          string（必填，方块 id，如 minecraft:stone / spruce_log）
 *   item           string（可选，掉落物 id；默认按 DROP_OF 映射，如 stone→cobblestone）
 *   count          number 期望总数（默认 4）
 *   radius         number 扫描半径（默认 32）
 *   maxClusters    number 单段最多试几簇（默认 2）
 *   countPerChunk  number 单段最多挖几块（默认 4，上限 8）
 *
 * 返回：{mined:N, clusters:N, item}；partial=true 时带 remaining，由树续派。
 * 失败：not_found / out_of_reach / failed
 */

/** 常见方块 → 掉落物映射（用于背包差计数）。 */
const DROP_OF = {
  'minecraft:stone': 'minecraft:cobblestone',
  'minecraft:cobblestone': 'minecraft:cobblestone',
  'minecraft:deepslate': 'minecraft:cobbled_deepslate',
  'minecraft:coal_ore': 'minecraft:coal',
  'minecraft:deepslate_coal_ore': 'minecraft:coal',
  'minecraft:iron_ore': 'minecraft:raw_iron',
  'minecraft:deepslate_iron_ore': 'minecraft:raw_iron',
  'minecraft:copper_ore': 'minecraft:raw_copper',
  'minecraft:deepslate_copper_ore': 'minecraft:raw_copper',
  'minecraft:gold_ore': 'minecraft:raw_gold',
  'minecraft:deepslate_gold_ore': 'minecraft:raw_gold',
  'minecraft:diamond_ore': 'minecraft:diamond',
  'minecraft:deepslate_diamond_ore': 'minecraft:diamond',
  'minecraft:redstone_ore': 'minecraft:redstone',
  'minecraft:deepslate_redstone_ore': 'minecraft:redstone',
  'minecraft:lapis_ore': 'minecraft:lapis_lazuli',
  'minecraft:deepslate_lapis_ore': 'minecraft:lapis_lazuli',
  'minecraft:emerald_ore': 'minecraft:emerald',
  'minecraft:deepslate_emerald_ore': 'minecraft:emerald',
};

export function dropItemOf(block, explicit) {
  const b = String(block || '').trim();
  const e = String(explicit || '').trim();
  if (e) return e.includes(':') ? e : `minecraft:${e}`;
  return DROP_OF[b] || b;
}

export default {
  id: 'mine_nearby',
  title: '走近并挖/捡附近一小批方块',
  params: {
    block: 'string（必填，如 minecraft:spruce_log）',
    item: 'string（可选，掉落物；默认自动映射 stone→cobblestone 等）',
    count: 'number = 4',
    radius: 'number = 32',
    maxClusters: 'number = 2',
    countPerChunk: 'number = 4',
  },
  meta: { gives: ['items'], risk: 'low', budgetMs: 240_000 },
  build(ctx, params = {}) {
    const block = String(params.block || '');
    if (!block) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 block 参数", "示例 minecraft:spruce_log")`,
        timeoutMs: 5000,
      };
    }
    const count = Math.max(1, Math.floor(Number(params.count ?? 4)) || 4);
    const radius = Math.max(4, Math.min(64, Math.floor(Number(params.radius ?? 32)) || 32));
    const maxClusters = Math.max(1, Math.min(4, Math.floor(Number(params.maxClusters ?? 2)) || 2));
    const per = Math.max(1, Math.min(8, Math.floor(Number(params.countPerChunk ?? 4)) || 4));
    const item = dropItemOf(block, params.item);
    const safe = block.replace(/'/g, "\\'");
    const safeItem = item.replace(/'/g, "\\'");

    const code = `${LUA_PRELUDE}
local BLOCK = '${safe}'
local ITEM = '${safeItem}'
local WANT = ${count}
local RADIUS = ${radius}
local MAX_CLUSTERS = ${maxClusters}
local PER = ${per}
local BASE = ${luaRegions(baseRegions(ctx?.places))}
local function inBase(b)
  if type(b) ~= "table" then return false end
  local p = type(b.pos) == "table" and b.pos or b
  local x, y, z = tonumber(p.x), tonumber(p.y), tonumber(p.z)
  if x == nil or y == nil or z == nil then return false end
  for _, r in ipairs(BASE) do
    if math.abs(x - r.x) <= r.half and math.abs(z - r.z) <= r.half and y >= r.yMin and y <= r.yMax then
      return true
    end
  end
  return false
end

local function cnt(it)
  local ok, v = pcall(numen.inv.count, it)
  if not ok then return 0 end
  return tonumber(v) or 0
end

local ok, r = pcall(function()
  local clusters = numen.scan.blocks(BLOCK, { radius = RADIUS })
  if clusters == nil or #clusters == 0 then
    error({ kind = "not_found", message = "no " .. BLOCK .. " within " .. RADIUS .. " blocks" })
  end
  local before = cnt(ITEM)
  local blockedTotal = 0

  local tried, lastErr = 0, nil
  for i = 1, #clusters do
    if cnt(ITEM) - before >= WANT or tried >= MAX_CLUSTERS then break end
    tried = tried + 1
    local c = clusters[i]
    -- 取这一簇的方块列表（兼容 Cluster / {nearest=..,blocks=..} / Block 三种形态）
    local list = {}
    if type(c) == "table" then
      if type(c.blocks) == "table" then list = c.blocks
      elseif c.pos ~= nil or (c.x ~= nil and c.y ~= nil) then list = { c }
      end
    end
    -- 只取"还差多少/单段上限"里较小的那部分，包成小簇，避免 mine 挖整簇
    local progressed = cnt(ITEM) - before
    local need = WANT - progressed
    local takeN = need
    if takeN > PER then takeN = PER end
    local subset = {}
    for j = 1, #list do
      if #subset >= takeN then break end
      if inBase(list[j]) then
        blockedTotal = blockedTotal + 1
      else
        subset[#subset + 1] = list[j]
      end
    end
    if #subset > 0 then
      local target = subset
      local cOk, cRes = pcall(numen.scan.cluster, subset)
      if cOk and cRes ~= nil then target = cRes end
      local mOk, mRes = pcall(numen.work.mine, target)
      if not mOk then lastErr = mRes end
      -- 注意：不信任 work.mine 的返回值，进度统一用背包前后差算
    end
  end

  local mined = cnt(ITEM) - before
  if mined < 0 then mined = 0 end
  if mined <= 0 and blockedTotal > 0 then
    error({ kind = "refused", message = "基地内禁止自主挖掘（" .. blockedTotal .. " 个候选被拒）" })
  end
  if mined <= 0 then
    error({ kind = "out_of_reach",
      message = "mined nothing in " .. tried .. " cluster(s): " .. tostring(lastErr),
      hint = "簇可能被挡住/够不着/工具不对，换个地方再试" })
  end
  return { mined = mined, clusters = tried }
end)
if not ok then return FAIL(r) end

local left = WANT - r.mined
if left < 0 then left = 0 end
if left > 0 then
  return J({
    { "partial", "true" },
    { "mined", N(r.mined) },
    { "remaining", N(left) },
    { "clusters", N(r.clusters) },
    { "item", S(ITEM) },
  })
end
return J({ { "mined", N(r.mined) }, { "clusters", N(r.clusters) }, { "item", S(ITEM) } })
`;
    return { code, timeoutMs: 240_000 };
  },
};


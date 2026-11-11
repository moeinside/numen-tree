import { LUA_PRELUDE } from './prelude.mjs';

/**
 * find_block —— 扫描附近有没有指定方块（只读，不放置不合成）。
 *
 * 用途：避免"每次都做新工作台/熔炉"——配方先用它查已有方块：
 *   找到了 → 直接跳到合成/使用步骤（make/smelt 会自己找最近的台子/炉子）；
 *   没找到 → not_found → 配方 onFail 走"craft + place"分支。
 *
 * params:
 *   block  string（必填，方块 id，如 minecraft:crafting_table）
 *   radius number = 24（扫描半径，4~64）
 *
 * 返回：{found:1, x, y, z, count}（最近一个的位置 + 该半径内簇数）
 * 失败：not_found / bad_argument
 */
export default {
  id: 'find_block',
  title: '找附近的方块（只读）',
  params: {
    block: 'string（必填，方块 id）',
    radius: 'number = 24',
    open: 'boolean = false（找到后尝试打开，失败返回 no_window）',
  },
  meta: { gives: ['found-block'], risk: 'low', budgetMs: 30_000 },
  build(ctx, params = {}) {
    const block = String(params.block || '');
    if (!block) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 block 参数", "示例 minecraft:crafting_table")`,
        timeoutMs: 5000,
      };
    }
    const radius = Math.min(64, Math.max(4, Math.floor(Number(params.radius ?? 24)) || 24));
    const wantOpen = params.open === true || params.open === 'true' || params.open === 1;
    const safe = block.replace(/'/g, "\\'");
    const code = `${LUA_PRELUDE}
local BLOCK = '${safe}'
local RADIUS = ${radius}
local WANT_OPEN = ${wantOpen ? 'true' : 'false'}

local function firstPos(found)
  if type(found) ~= "table" or #found == 0 then return nil end
  local cluster = found[1]
  local at = cluster and (cluster.nearest or (cluster.blocks and cluster.blocks[1]))
  if at == nil then at = cluster end
  if type(at) ~= "table" then return nil end
  local p = at.pos or at
  if type(p) ~= "table" or p.x == nil or p.y == nil or p.z == nil then return nil end
  return { x = p.x, y = p.y, z = p.z }
end

local ok, r = pcall(function()
  local clusters = numen.scan.blocks(BLOCK, { radius = RADIUS })
  local at = firstPos(clusters)
  if at == nil then
    error({ kind = "not_found", message = "附近 " .. RADIUS .. " 格内没有 " .. BLOCK,
      hint = "需要先 craft + place" })
  end
  return { at = at, count = #clusters }
end)
if not ok then return FAIL(r) end
if WANT_OPEN then
  local moved = pcall(numen.move.to, { x = r.at.x, y = r.at.y, z = r.at.z }, { arrive = "use" })
  local used, res = pcall(numen.use.block, { x = r.at.x, y = r.at.y, z = r.at.z })
  local opened = used and type(res) == "table" and (res.put ~= nil or res.take ~= nil)
  if not opened then
    return F("no_window", "找到了 " .. BLOCK .. " 但打不开窗口",
      "台子可能被挡住/不完整，craft+place 一个新的")
  end
end
return J({
  { "found", "true" },
  { "x", N(r.at.x) },
  { "y", N(r.at.y) },
  { "z", N(r.at.z) },
  { "count", N(r.count) },
})
`;
    return { code, timeoutMs: 30_000 };
  },
};

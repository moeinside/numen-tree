import { LUA_PRELUDE, luaLiteral } from './prelude.mjs';
import { LOG_TYPES } from '../crafttree.mjs';

/**
 * smelt —— 找最近的熔炉，把背包里的物品熔炼/烧制（矿→锭、生肉→熟肉等）。
 *
 * 流程（全包在 pcall 里，失败带 kind）：
 *   1) scan.blocks({furnace, blast_furnace}, {radius}) 找最近熔炉（数组不行逐个 id 退路扫）；
 *   2) 校验：背包里至少要有一个待烧物品（否则 not_found）；燃料（默认煤）不够 → no_material；
 *   3) `numen.inv.smelt(at, item, count, {fuel, timeout})` —— 模块负责走路/开炉/放料/等烧好/取出；
 *   4) 返回 {"smelted":N,"furnace":{x,y,z}}。
 *
 * params:
 *   item   string（必填，如 minecraft:raw_beef / minecraft:iron_ore）
 *   count  number（可选；默认把背包里该物品全烧掉）
 *   fuel   string = minecraft:coal（燃料；每 8 个消耗 1 个）
 *   radius number = 24（找熔炉半径）
 *
 * 纪律：不用 numen.task.timer（会打断程序）；单程序 API 调用数很小。
 */
export default {
  id: 'smelt',
  title: '熔炼物品（找熔炉烧）',
  params: {
    item: 'string（必填，如 minecraft:raw_beef）',
    count: 'number（可选，默认全部）',
    fuel: 'string = minecraft:coal',
    radius: 'number = 24',
  },
  meta: { needs: ['furnace'], gives: ['smelted'], risk: 'low', budgetMs: 240_000 },
  build(ctx, params = {}) {
    const rawItem = params.item == null ? '' : String(params.item).trim();
    if (!rawItem) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 item 参数", "示例 minecraft:raw_beef")`,
        timeoutMs: 5000,
      };
    }
    const item = rawItem.includes(':') ? rawItem : `minecraft:${rawItem}`;
    let count = null;
    if (params.count != null && params.count !== '') {
      const n = Math.floor(Number(params.count));
      count = Number.isFinite(n) && n > 0 ? n : null;
    }
    const fuel = (() => {
      const f = String(params.fuel ?? '').trim();
      if (!f) return null;
      return f.includes(':') ? f : `minecraft:${f}`;
    })();
    const radius = Math.min(64, Math.max(4, Math.floor(Number(params.radius ?? 24)) || 24));

    // 燃料候选：煤/木炭/任意木板（木板也能烧东西）；指定 fuel 时只用指定燃料
    const fuelList = LOG_TYPES.map((t) => `minecraft:${t}_planks`);
    const fuels = fuel ? [fuel] : ['minecraft:coal', 'minecraft:charcoal', ...fuelList];
    const fuelArray = `{ ${fuels.map((f) => `"${f}"`).join(', ')} }`;

    const code = `${LUA_PRELUDE}
local ITEM = ${luaLiteral(item)}
local WANT = ${count == null ? 'nil' : String(count)}
local FUEL_FIXED = ${fuel ? luaLiteral(fuel) : 'nil'}
local FUELS = ${fuelArray}
local RADIUS = ${radius}
local FURNACES = { "minecraft:furnace", "minecraft:blast_furnace" }

local function cnt(it)
  local ok, v = pcall(numen.inv.count, it)
  if not ok then return 0 end
  return tonumber(v) or 0
end

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

local function findFurnace(r)
  local ok, found = pcall(numen.scan.blocks, FURNACES, { radius = r })
  if ok then
    local at = firstPos(found)
    if at ~= nil then return at end
  end
  for _, fid in ipairs(FURNACES) do
    local ok2, found2 = pcall(numen.scan.blocks, fid, { radius = r })
    if ok2 then
      local at = firstPos(found2)
      if at ~= nil then return at end
    end
  end
  return nil
end

local ok, r = pcall(function()
  local have = cnt(ITEM)
  if have <= 0 then
    error({ kind = "not_found", message = "背包里没有 " .. ITEM .. " 可烧",
      hint = "先挖矿/打猎拿到原料" })
  end
  local want = WANT
  if want == nil or want > have then want = have end
  -- 燃料：优先指定燃料；否则按 煤→木炭→任意木板 的顺序找背包里有的
  local fuelItem = nil
  if FUEL_FIXED ~= nil then
    if cnt(FUEL_FIXED) > 0 then fuelItem = FUEL_FIXED end
  else
    for _, f in ipairs(FUELS) do
      if cnt(f) > 0 then fuelItem = f break end
    end
  end
  if fuelItem == nil then
    error({ kind = "no_material", message = "没有燃料（煤/木炭/木板都没有）",
      hint = "先挖煤，或用木板当燃料" })
  end
  local at = findFurnace(RADIUS)
  if at == nil then
    error({ kind = "not_found", message = "附近 " .. RADIUS .. " 格内没有熔炉",
      hint = "先 craft(furnace) 并放好（8 圆石）" })
  end
  local sOk, sRes = pcall(numen.inv.smelt, at, ITEM, want, { fuel = fuelItem, timeout = (want * 15) + 30 })
  if not sOk then
    error({ kind = "failed", message = "熔炼失败：" .. tostring(sRes),
      hint = "熔炉可能被占/没空间/燃料不对" })
  end
  return { at = at, smelted = tonumber(sRes) or 0, want = want, fuel = fuelItem }
end)
if not ok then return FAIL(r) end
return J({
  { "smelted", N(r.smelted) },
  { "wanted", N(r.want) },
  { "fuel", S(r.fuel) },
  { "furnace", '{"x":' .. N(r.at.x) .. ',"y":' .. N(r.at.y) .. ',"z":' .. N(r.at.z) .. '}' },
})
`;
    return { code, timeoutMs: 240_000 };
  },
};

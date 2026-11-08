import { LUA_PRELUDE } from './prelude.mjs';

/**
 * eat —— 吃东西恢复饥饿。
 *
 * params:
 *   item  string（可选；不给就按内置食物表从好的往差的挑）
 *   count number（最多吃几件，默认 4；吃饱就停，不会浪费）
 *
 * 食物表按"性价比"从高到低排：熟肉 → 主食 → 生肉 → 腐肉垫底。
 * 只查表，不判断该不该吃（那是仲裁器的活）。
 */
export default {
  id: 'eat',
  title: '吃东西',
  params: { item: 'string（可选）', count: 'number = 4' },
  build(ctx, params = {}) {
    const item = params.item ? String(params.item) : '';
    const maxN = Math.min(8, Math.max(1, Number(params.count ?? 4)));
    const code = `${LUA_PRELUDE}
local FOODS = {
  -- 熟肉：最好
  "minecraft:cooked_beef", "minecraft:cooked_porkchop", "minecraft:cooked_mutton",
  "minecraft:cooked_chicken", "minecraft:cooked_rabbit", "minecraft:cooked_salmon",
  "minecraft:cooked_cod",
  -- 主食/果蔬
  "minecraft:bread", "minecraft:baked_potato", "minecraft:golden_apple",
  "minecraft:apple", "minecraft:carrot", "minecraft:potato", "minecraft:beetroot",
  "minecraft:beetroot_soup", "minecraft:mushroom_stew", "minecraft:rabbit_stew",
  "minecraft:pumpkin_pie", "minecraft:melon_slice", "minecraft:sweet_berries",
  "minecraft:glow_berries", "minecraft:cookie",
  -- 生肉：能填肚子就行（打猎现取）
  "minecraft:beef", "minecraft:porkchop", "minecraft:mutton", "minecraft:chicken",
  "minecraft:rabbit", "minecraft:salmon", "minecraft:cod",
  -- 最差
  "minecraft:rotten_flesh",
}
local wanted = ${item ? `'${item.replace(/'/g, "\\'")}'` : 'nil'}
local maxN = ${maxN}

local ok, r = pcall(function()
  local function hunger() return numen.status.self().hunger end
  local start = hunger()
  if start >= 20 then return { already = true } end

  local ate, last = 0, nil
  for _ = 1, maxN do
    if hunger() >= 20 then break end
    local have = {}
    for _, it in ipairs(numen.inv.items() or {}) do
      local name = it.item or it.id or it.name
      if name then have[name] = it.count or it.n or 1 end
    end
    local pick = wanted
    if pick ~= nil and have[pick] == nil then pick = nil end
    if pick == nil then
      for _, f in ipairs(FOODS) do
        if have[f] then pick = f break end
      end
    end
    if pick == nil then break end
    numen.inv.eat(pick)
    ate = ate + 1
    last = pick
  end

  if ate == 0 then
    error({ kind = "not_found", message = "no food in inventory" })
  end
  return { ate = ate, item = last, before = start, hunger = hunger() }
end)
if not ok then return FAIL(r) end
if r.already then return J({ { "already", "true" } }) end
return J({
  { "ate", N(r.ate) },
  { "item", S(r.item) },
  { "hunger_before", N(r.before) },
  { "hunger", N(r.hunger) },
})
`;
    return { code, timeoutMs: 90_000 };
  },
};

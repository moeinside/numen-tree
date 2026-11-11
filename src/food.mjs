/**
 * 食物目录（docs/27）：营养值、生/熟、可烹饪、急救。
 * 只列原版常见食物；模组食物后续按需扩展。
 */

/** item → { hunger, kind: 'cooked'|'raw'|'plant'|'emergency', safe, cookedTo? } */
export const FOODS = {
  'minecraft:cooked_beef': { hunger: 8, kind: 'cooked', safe: true },
  'minecraft:cooked_porkchop': { hunger: 8, kind: 'cooked', safe: true },
  'minecraft:cooked_mutton': { hunger: 6, kind: 'cooked', safe: true },
  'minecraft:cooked_chicken': { hunger: 6, kind: 'cooked', safe: true },
  'minecraft:cooked_rabbit': { hunger: 5, kind: 'cooked', safe: true },
  'minecraft:cooked_cod': { hunger: 5, kind: 'cooked', safe: true },
  'minecraft:cooked_salmon': { hunger: 6, kind: 'cooked', safe: true },
  'minecraft:bread': { hunger: 5, kind: 'cooked', safe: true },
  'minecraft:baked_potato': { hunger: 5, kind: 'cooked', safe: true },
  'minecraft:pumpkin_pie': { hunger: 8, kind: 'cooked', safe: true },
  'minecraft:mushroom_stew': { hunger: 6, kind: 'cooked', safe: true },
  'minecraft:rabbit_stew': { hunger: 10, kind: 'cooked', safe: true },
  'minecraft:beetroot_soup': { hunger: 6, kind: 'cooked', safe: true },
  'minecraft:apple': { hunger: 4, kind: 'plant', safe: true },
  'minecraft:carrot': { hunger: 3, kind: 'plant', safe: true },
  'minecraft:golden_carrot': { hunger: 6, kind: 'plant', safe: true },
  'minecraft:melon_slice': { hunger: 2, kind: 'plant', safe: true },
  'minecraft:sweet_berries': { hunger: 2, kind: 'plant', safe: true },
  'minecraft:glow_berries': { hunger: 2, kind: 'plant', safe: true },
  'minecraft:cookie': { hunger: 2, kind: 'cooked', safe: true },
  'minecraft:dried_kelp': { hunger: 1, kind: 'cooked', safe: true },
  'minecraft:honey_bottle': { hunger: 6, kind: 'plant', safe: true },
  'minecraft:beef': { hunger: 3, kind: 'raw', safe: true, cookedTo: 'minecraft:cooked_beef' },
  'minecraft:porkchop': { hunger: 3, kind: 'raw', safe: true, cookedTo: 'minecraft:cooked_porkchop' },
  'minecraft:mutton': { hunger: 2, kind: 'raw', safe: true, cookedTo: 'minecraft:cooked_mutton' },
  'minecraft:rabbit': { hunger: 3, kind: 'raw', safe: true, cookedTo: 'minecraft:cooked_rabbit' },
  'minecraft:cod': { hunger: 2, kind: 'raw', safe: true, cookedTo: 'minecraft:cooked_cod' },
  'minecraft:salmon': { hunger: 2, kind: 'raw', safe: true, cookedTo: 'minecraft:cooked_salmon' },
  'minecraft:chicken': { hunger: 2, kind: 'raw', safe: false, cookedTo: 'minecraft:cooked_chicken' },
  'minecraft:potato': { hunger: 1, kind: 'raw', safe: true, cookedTo: 'minecraft:baked_potato' },
  'minecraft:beetroot': { hunger: 1, kind: 'plant', safe: true },
  'minecraft:rotten_flesh': { hunger: 4, kind: 'emergency', safe: false },
};

export const FOOD_IDS = Object.keys(FOODS);

export function foodInfo(item) {
  return FOODS[String(item || '')] || null;
}

/** 可直接吃的食物（急救时允许腐肉）。 */
export function isEdible(item, { emergency = false } = {}) {
  const f = foodInfo(item);
  if (!f) return false;
  if (f.kind === 'emergency') return emergency;
  if (f.kind === 'raw') return f.safe;
  return true;
}

/** 需要烹饪/可烹饪的生食。 */
export function isRawCookable(item) {
  const f = foodInfo(item);
  return !!f && f.kind === 'raw';
}

/** 背包里按营养值排序的可用食物。 */
export function edibleInInventory(inventory, { emergency = false } = {}) {
  const inv = Array.isArray(inventory) ? inventory : [];
  return inv
    .filter((s) => (s.count ?? 0) > 0 && isEdible(s.item, { emergency }))
    .map((s) => ({ item: s.item, count: Number(s.count) || 0, hunger: foodInfo(s.item)?.hunger ?? 0 }))
    .sort((a, b) => b.hunger - a.hunger);
}

export function rawInInventory(inventory) {
  const inv = Array.isArray(inventory) ? inventory : [];
  return inv
    .filter((s) => (s.count ?? 0) > 0 && isRawCookable(s.item))
    .map((s) => ({ item: s.item, count: Number(s.count) || 0, cookedTo: foodInfo(s.item)?.cookedTo }))
    .sort((a, b) => (foodInfo(b.item)?.hunger ?? 0) - (foodInfo(a.item)?.hunger ?? 0));
}

export function countEdible(inventory) {
  return (Array.isArray(inventory) ? inventory : []).reduce(
    (n, s) => n + ((s.count ?? 0) > 0 && isEdible(s.item) ? Number(s.count) : 0),
    0,
  );
}

export function countCooked(inventory) {
  return (Array.isArray(inventory) ? inventory : []).reduce(
    (n, s) => n + ((s.count ?? 0) > 0 && foodInfo(s.item)?.kind === 'cooked' ? Number(s.count) : 0),
    0,
  );
}

export function countRaw(inventory) {
  return (Array.isArray(inventory) ? inventory : []).reduce(
    (n, s) => n + ((s.count ?? 0) > 0 && isRawCookable(s.item) ? Number(s.count) : 0),
    0,
  );
}

/** 给 Lua 侧用的 food 分数表文本（在 atoms/lane 里拼进 Lua）。 */
export function foodScoreLua() {
  const pairs = [];
  for (const [item, f] of Object.entries(FOODS)) {
    if (f.kind === 'emergency') continue;
    if (f.kind === 'raw' && !f.safe) continue;
    pairs.push(`["${item.replace(/^minecraft:/, '')}"] = ${f.hunger}`);
  }
  return `{ ${pairs.join(', ')} }`;
}

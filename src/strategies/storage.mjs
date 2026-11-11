/**
 * 存储战略（从 strategy.mjs 拆出）。
 */
const STORE_KEEP_RE = /(_sword|_axe|_pickaxe|_shovel|_hoe|_bow|_crossbow|_trident|_shield)$/;
const MATERIAL_RE = /(_log|_planks|_ore|_ingot|_nugget|_coal|_stone|cobblestone|dirt|sand|gravel|_sapling|_seeds?|_crop|_food|_meat|_fish)$/;

/** 背包里值得存进箱子的素材（排除工具/武器/食物/护甲）。 */
export function materialsInInventory(state) {
  const inv = Array.isArray(state?.inventory) ? state.inventory : [];
  return inv
    .filter((s) => (s.count ?? 0) > 0)
    .filter((s) => MATERIAL_RE.test(String(s.item || '')))
    .filter((s) => !STORE_KEEP_RE.test(String(s.item || '')))
    .map((s) => ({ item: String(s.item), count: Number(s.count) || 0 }));
}


/** 存素材：回家 → 找箱子 → 把背包里的素材 store_batch。 */
export async function storeMaterials(params, ctx, callTactic) {
  const st = ctx?.state;
  if (!st) return { ok: false, kind: 'no_state', message: 'store_materials 需要 state' };
  const mats = materialsInInventory(st);
  if (!mats.length) return { ok: false, kind: 'nothing_to_store', message: '背包里没有可存的素材' };
  const home = ctx?.homePlace;
  if (!home) return { ok: false, kind: 'no_home', message: '没有家/锚点记录' };
  const dist =
    st.pos != null
      ? Math.hypot(Number(home.x) - Number(st.pos.x), Number(home.z) - Number(st.pos.z))
      : null;
  if (dist == null || dist > 8) {
    const mv = await callTactic('travel_to', { target: { x: home.x, y: home.y, z: home.z }, arrive: 3 });
    if (!mv?.ok) return { ok: false, kind: 'travel_failed', message: '回家失败，先不存' };
  }
  const loc = await callTactic('locate_station', { block: 'minecraft:chest', radius: 24 });
  const s = loc?.vars?.s;
  if (!s?.found) return { ok: false, kind: 'no_chest', message: '家附近没有箱子' };
  const cell = { x: s.x, y: s.y, z: s.z };
  const limit = Math.max(1, Math.min(12, Number(params?.limit ?? 6)));
  const stored = [];
  let moved = 0;
  for (const m of mats.slice(0, limit)) {
    const r = await callTactic('store_batch', { cell, item: m.item, count: m.count });
    const n = Number(r?.vars?.s?.moved ?? 0);
    if (r?.ok && n > 0) {
      moved += n;
      stored.push({ item: m.item, moved: n });
    }
  }
  return {
    ok: moved > 0,
    kind: moved > 0 ? 'ok' : 'store_failed',
    moved,
    stored,
    message: moved > 0 ? undefined : '素材没能放进箱子',
  };
}

/** store_materials 的效用候选（给 arbiter 用）。 */
export function storeMaterialsCandidate(ctx) {
  const st = ctx?.state;
  const home = ctx?.homePlace;
  const materials = materialsInInventory(st);
  const dist =
    home && st?.pos
      ? Math.hypot(Number(home.x) - Number(st.pos.x), Number(home.z) - Number(st.pos.z))
      : null;
  return {
    id: 'store_materials',
    level: 2,
    kind: 'strategy',
    minRunSeconds: 15,
    cooldownSeconds: 180,
    eligible: () => materials.length > 0 && !!home,
    score: () => {
      const stacks = Math.min(1, materials.length / 6);
      const totalCount = materials.reduce((a, m) => a + m.count, 0);
      const fullness = Math.min(1, totalCount / 64);
      const hp = Number(st?.hp ?? 20) / 20;
      const deathRisk = Math.max(0, 1 - hp);
      const opportunity = 0.6 * stacks + 0.4 * fullness;
      const value = 0.5 * fullness + 0.5 * deathRisk;
      const risk = Math.min(1, (st?.dark ? 0.4 : 0) + ((st?.hostileCount ?? 0) > 0 ? 0.6 : 0));
      const cost = dist == null ? 0.3 : Math.min(1, dist / 64);
      const total =
        100 * Math.max(0, Math.min(1, 0.3 * 0.1 + 0.25 * value + 0.15 * opportunity - 0.1 * risk - 0.05 * cost));
      return {
        total,
        parts: { urgency: 0.1, value, opportunity, risk, cost, stacks, fullness, distance: dist },
      };
    },
  };
}

﻿
const TOOL_CATEGORIES = [
  { key: 'weapon', re: /_sword$/ },
  { key: 'pickaxe', re: /_pickaxe$/ },
  { key: 'axe', re: /_axe$/ },
];

/** 基地箱子至少留 1 份备用工具：背包有 2 份以上才存 1 份。 */
export async function stockBackup(params, ctx, callTactic) {
  const st = ctx?.state;
  const home = ctx?.homePlace;
  if (!st) return { ok: false, kind: 'no_state', message: 'stock_backup 需要 state' };
  if (!home) return { ok: false, kind: 'no_home', message: '没有家/锚点记录' };
  const dist =
    st.pos != null
      ? Math.hypot(Number(home.x) - Number(st.pos.x), Number(home.z) - Number(st.pos.z))
      : null;
  if (dist == null || dist > 8) {
    const mv = await callTactic('travel_to', { target: { x: home.x, y: home.y, z: home.z }, arrive: 3 });
    if (!mv?.ok) return { ok: false, kind: 'travel_failed', message: '回基地失败，无法检查备用工具' };
  }
  const loc = await callTactic('locate_station', { block: 'minecraft:chest', radius: 32 });
  const s = loc?.vars?.s;
  if (!s?.found) return { ok: false, kind: 'no_chest', message: '基地附近没有箱子，无法存备用工具' };
  const cell = { x: s.x, y: s.y, z: s.z };
  const sc = await callTactic('scan_container', { cell });
  const slots = sc?.vars?.c || {};
  const text = Object.values(slots).map(String).join(' ');
  const chestHas = Object.fromEntries(TOOL_CATEGORIES.map((c) => [c.key, c.re.test(text)]));
  if (TOOL_CATEGORIES.every((c) => chestHas[c.key])) {
    return { ok: true, reason: 'backup_exists', chest: cell, stored: 0 };
  }
  const inv = Array.isArray(st.inventory) ? st.inventory : [];
  const stored = [];
  const skipped = [];
  for (const c of TOOL_CATEGORIES) {
    if (chestHas[c.key]) continue;
    const item = inv.find((x) => (x.count ?? 0) > 0 && c.re.test(String(x.item ?? '')));
    if (!item) {
      skipped.push({ key: c.key, reason: 'none_in_inventory' });
      continue;
    }
    const cnt = await callTactic('count_items', { item: item.item });
    const n = Number(cnt?.vars?.n?.count ?? 0);
    if (n < 2) {
      skipped.push({ key: c.key, item: item.item, reason: 'only_one_no_backup' });
      continue;
    }
    const r = await callTactic('store_batch', {
      cell,
      item: item.item,
      count: 1,
    });
    if (r?.ok) {
      stored.push({ key: c.key, item: item.item });
      chestHas[c.key] = true;
    } else {
      skipped.push({ key: c.key, item: item.item, reason: r?.kind ?? 'store_failed' });
    }
  }
  return {
    ok: stored.length > 0,
    kind: stored.length > 0 ? 'ok' : 'no_surplus',
    stored,
    skipped,
    chest: cell,
    message: stored.length > 0 ? undefined : '没有多余工具可存为备用（需先制作第二份）',
  };
}

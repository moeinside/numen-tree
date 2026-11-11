/**
 * 燃料战略（从 strategy.mjs 拆出）。
 */
import { pickCraftable, craftWoodenGear, ensureWorkbench } from './craft.mjs';
import { varsOf } from './util.mjs';

export async function ensureSticks(callTactic) {
  const planks = await pickCraftable(callTactic, (it) => it.endsWith('_planks'));
  if (planks) await callTactic('craft_batch', { recipe: planks.recipeId, count: 4 });
  const sticks = await pickCraftable(callTactic, (it) => it === 'minecraft:stick');
  if (sticks) await callTactic('craft_batch', { recipe: sticks.recipeId, count: 4 });
}

export async function mineCoal(params, ctx, callTactic) {
  const pick = await callTactic('count_items', { item: 'minecraft:wooden_pickaxe' });
  if (Number(varsOf(pick).n?.count ?? 0) <= 0) {
    return { ok: false, kind: 'need_tools', message: '没有镐，挖不了煤' };
  }
  const countCoal = async () => {
    const r = await callTactic('count_items', { item: 'minecraft:coal' });
    return Number(r?.vars?.n?.count ?? 0);
  };
  let coal = await countCoal();
  if (coal > 0) return { ok: true, coal, reason: 'already_have' };
  for (const block of ['minecraft:coal_ore', 'minecraft:deepslate_coal_ore']) {
    const loc = await callTactic('locate_station', { block, radius: 32 });
    const s = loc?.vars?.s;
    if (!s?.found) continue;
    await callTactic('travel_to', { target: { x: s.x, y: s.y, z: s.z }, arrive: 2 });
    await callTactic('dig_cluster', { block, radius: 16, count: Math.max(1, Number(params?.count ?? 4)) });
    await callTactic('collect_drops', { radius: 6 });
    coal = await countCoal();
    if (coal > 0) return { ok: true, coal, block };
  }
  return { ok: false, kind: 'no_coal', message: '附近没找到煤矿' };
}

export async function makeCharcoal(params, ctx, callTactic) {
  const st = ctx?.state;
  if (!st) return { ok: false, kind: 'no_state', message: 'make_charcoal 需要 state' };
  const count = async (item) => {
    const r = await callTactic('count_items', { item });
    return Number(r?.vars?.n?.count ?? 0);
  };
  let charcoal = await count('minecraft:charcoal');
  if (charcoal > 0) return { ok: true, charcoal, reason: 'already_have' };

  // 1) 挖石头（需要镐；没有就先做一把木镐）
  if ((await count('minecraft:cobblestone')) < 8) {
    let pick = await count('minecraft:wooden_pickaxe');
    if (pick <= 0) {
      // 复用 secure_gear 的木镐合成链（找树→做桌→木镐）
      await craftWoodenGear(callTactic, st, 'tools');
      pick = await count('minecraft:wooden_pickaxe');
    }
    if (pick <= 0) return { ok: false, kind: 'need_pickaxe', message: '没有镐，挖不了石头' };
    const loc = await callTactic('locate_station', { block: 'minecraft:stone', radius: 32 });
    const s = loc?.vars?.s;
    if (!s?.found) return { ok: false, kind: 'no_stone', message: '附近没找到石头' };
    await callTactic('travel_to', { target: { x: s.x, y: s.y, z: s.z }, arrive: 2 });
    await callTactic('dig_cluster', { block: 'minecraft:stone', radius: 16, count: 8 });
    await callTactic('collect_drops', { radius: 6 });
  }
  if ((await count('minecraft:cobblestone')) < 8) {
    return { ok: false, kind: 'no_cobblestone', message: '石头不够 8 个' };
  }

  // 2) 确保工作台打开（附近有就开；背包里有就放；没有就做）
  const bench = await ensureWorkbench(callTactic, st);
  if (!bench.ok) return { ok: false, kind: 'no_table', message: '没有可用的工作台（3×3）' };

  // 3) 做熔炉
  let furnace = await count('minecraft:furnace');
  if (furnace <= 0) {
    const furnaceRecipe = await pickCraftable(callTactic, (it) => it === 'minecraft:furnace');
    if (!furnaceRecipe) return { ok: false, kind: 'no_furnace_recipe', message: '做不了熔炉（缺材料）' };
    await callTactic('craft_batch', { recipe: furnaceRecipe.recipeId, count: 1 });
    furnace = await count('minecraft:furnace');
  }
  if (furnace <= 0) return { ok: false, kind: 'no_furnace', message: '没有熔炉' };

  // 4) 放熔炉
  let furnaceCell = null;
  if (st?.pos) {
    const base = { x: Math.floor(st.pos.x), y: Math.floor(st.pos.y), z: Math.floor(st.pos.z) };
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const cell = { x: base.x + dx, y: base.y, z: base.z + dz };
      if ((await callTactic('place_one', { cell, block: 'minecraft:furnace' }))?.ok) {
        furnaceCell = cell;
        break;
      }
    }
  }
  if (!furnaceCell) return { ok: false, kind: 'no_furnace_cell', message: '熔炉放不下去' };

  // 5) 烧原木→木炭（用木板当燃料）
  const inv = Array.isArray(st.inventory) ? st.inventory : [];
  const log = inv.find((s) => /_log$/.test(String(s.item)) && (s.count ?? 0) > 0);
  const planks = inv.find((s) => /_planks$/.test(String(s.item)) && (s.count ?? 0) > 0);
  if (!log) return { ok: false, kind: 'no_log', message: '没有原木可烧' };
  if (!planks) return { ok: false, kind: 'no_fuel', message: '没有木板当燃料' };
  await callTactic('smelt_batch', {
    cell: furnaceCell,
    item: log.item,
    count: 1,
    fuel: planks.item,
    timeout: 10,
  });
  charcoal = await count('minecraft:charcoal');
  return {
    ok: charcoal > 0,
    kind: charcoal > 0 ? 'ok' : 'smelt_failed',
    charcoal,
    message: charcoal > 0 ? undefined : '烧完没有木炭',
  };
}


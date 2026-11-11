/**
 * 装备/合成战略（从 strategy.mjs 拆出）。
 */
import { LOG_ITEMS, PLANK_ITEMS } from '../crafttree.mjs';
import { gearRecoveryDecision, hasTools, hasWeapon } from '../needs.mjs';
import { varsOf } from './util.mjs';

/** 配方材料里可能是 tag/any（如 planks(any)、#minecraft:planks），解析成真实物品列表。 */
function ingredientSpec(ing) {
  const s = String(ing || '');
  const low = s.toLowerCase();
  if (low.includes('plank') || low === '#minecraft:planks' || low.includes('planks(any)')) {
    return { kind: 'planks', list: PLANK_ITEMS, label: s };
  }
  if (low.includes('log') || low === '#minecraft:logs' || low.includes('logs(any)')) {
    return { kind: 'logs', list: LOG_ITEMS, label: s };
  }
  return { kind: 'item', list: [s], label: s, item: s };
}

function countInInventory(st, list) {
  const inv = Array.isArray(st?.inventory) ? st.inventory : [];
  let n = 0;
  for (const s of inv) {
    if (list.includes(String(s.item))) n += Number(s.count ?? 0);
  }
  return n;
}


export async function secureGear(params, ctx, callTactic) {
  const st = ctx?.state;
  if (!st) return { ok: false, kind: 'no_state', message: 'secure_gear 需要 state' };
  const need = String(params?.need || 'get_weapon');
  if (hasWeapon(st) && (need !== 'get_tools' || hasTools(st))) {
    return { ok: true, need, reason: 'already_have' };
  }
  const deathPlace = ctx?.deathPlace || null;
  const now = Date.now();
  // 死亡点如果最近去失败过，10 分钟内不再尝试，直接走箱子/合成（防止反复 12s 空跑）
  const avoidRecovery = now < Number(st?.gearRecoveryAvoidUntil ?? 0);
  const dist =
    deathPlace && st?.pos
      ? Math.hypot(
          Number(deathPlace.x) - Number(st.pos.x),
          Number(deathPlace.z) - Number(st.pos.z),
        )
      : null;
  const dec = gearRecoveryDecision(st, {
    deathsRecent: Number(ctx?.deathsRecent ?? 0),
    deathDistance: dist,
  });
  if (dec.action !== 'recover') {
    // 夜间/不安全：先等，不出去
    return { ok: false, kind: 'wait', need, message: dec.hint, reasons: dec.reasons };
  }
  if (avoidRecovery) {
    const chest = await tryChestGear(callTactic);
    if (chest.ok) return { ...chest, need, reason: 'recovery_avoided_chest' };
    const crafted = await craftWoodenGear(callTactic, st, need);
    if (crafted.ok) return { ...crafted, reason: 'recovery_avoided_crafted' };
    return { ok: false, kind: 'recovery_avoided', need, message: '死亡点暂时不去，箱子/合成也没成功' };
  }
  if (!deathPlace) {
    // 没有死亡点：先找重生点/家附近的箱子，再走合成
    const chest = await tryChestGear(callTactic);
    if (chest.ok) return { ...chest, need, reason: 'chest' };
    const crafted = await craftWoodenGear(callTactic, st, need);
    return crafted;
  }
  const mv = await callTactic('travel_to', {
    target: { x: deathPlace.x, y: deathPlace.y, z: deathPlace.z },
    arrive: 2,
  });
  if (!mv?.ok) {
    st.gearRecoveryAvoidUntil = Date.now() + 10 * 60_000;
    const chest = await tryChestGear(callTactic);
    if (chest.ok) return { ...chest, need, reason: 'travel_failed_chest' };
    const crafted = await craftWoodenGear(callTactic, st, need);
    if (crafted.ok) return { ...crafted, reason: 'travel_failed_crafted' };
    return {
      ok: false,
      kind: 'travel_failed',
      need,
      message: `去死亡点失败：${mv?.message ?? mv?.kind ?? 'unknown'}`,
    };
  }
  const col = await callTactic('collect_drops', { radius: 8 });
  const eq = await callTactic('equip_best', {});
  if (col?.ok || eq?.ok) {
    return {
      ok: true,
      need,
      recovered: true,
      collected: col?.vars?.d?.count ?? 0,
      held: eq?.vars?.w?.held ?? null,
    };
  }
  // 死亡点没捡到：先箱子，再合成 fallback
  const chest = await tryChestGear(callTactic);
  if (chest.ok) return { ...chest, need, reason: 'recover_empty_chest' };
  const crafted = await craftWoodenGear(callTactic, st, need);
  if (crafted.ok) return { ...crafted, reason: 'recover_empty_crafted' };
  return { ok: false, kind: 'recover_no_gear', need, message: '到了死亡点，但没捡到武器/工具' };
}


async function tryChestGear(callTactic) {
  const loc = await callTactic('locate_station', { block: 'minecraft:chest', radius: 24 });
  const s = loc?.vars?.s;
  if (!s?.found) return { ok: false, kind: 'no_chest' };
  await callTactic('travel_to', { target: { x: s.x, y: s.y, z: s.z }, arrive: 2 });
  const sc = await callTactic('scan_container', { cell: { x: s.x, y: s.y, z: s.z } });
  if (!sc?.ok) return { ok: false, kind: 'chest_unreadable' };
  const c = sc.vars?.c || {};
  const texts = [];
  for (let i = 1; i <= 12; i += 1) if (c[`slot${i}`]) texts.push(String(c[`slot${i}`]));
  const ids = [...new Set(texts.join(' | ').match(/[a-z0-9_]+:[a-z0-9_]+/g) || [])];
  const cell = { x: s.x, y: s.y, z: s.z };
  const weapon = ids.find((id) => /(_sword|_axe|_pickaxe)$/.test(id));
  if (weapon) {
    await callTactic('fetch_batch', { cell, item: weapon, count: 1 });
    const eq = await callTactic('equip_best', {});
    if (eq?.ok) return { ok: true, fromChest: true, item: weapon };
  }
  const materials = ids.filter((id) =>
    /_log$|_planks$|^minecraft:stick$|^minecraft:crafting_table$/.test(id),
  );
  for (const id of materials.slice(0, 5)) {
    await callTactic('fetch_batch', { cell, item: id, count: id.endsWith('crafting_table') ? 1 : 16 });
  }
  return { ok: false, kind: 'chest_no_gear', materials };
}

/** 从当前可做配方里挑一个匹配的（按 item 名）。 */
export async function pickCraftable(callTactic, matchFn, limit = 12) {
  const q = await callTactic('query_craftable', { limit });
  if (!q?.ok) return null;
  const c = q.vars?.c || {};
  for (let i = 1; i <= limit; i += 1) {
    const id = c[`r${i}_id`];
    const item = c[`r${i}_item`];
    if (!id || !item) continue;
    if (matchFn(String(item))) return { recipeId: String(id), item: String(item) };
  }
  return null;
}

/** 做/拿木制装备：砍树 → 木板 → 木棍 → 工作台 → 木剑/木镐/木斧 → 装备。 */
/** 确保身边有一个打开的工作台：优先用附近的，其次放背包里的，最后现做一个。 */
export async function ensureWorkbench(callTactic, st) {
  const countOf = async (it) => {
    const r = await callTactic('count_items', { item: it });
    return Number(varsOf(r).n?.count ?? 0);
  };
  // 1) 附近已有工作台
  const loc = await callTactic('locate_station', { block: 'minecraft:crafting_table', radius: 24 });
  const s = varsOf(loc).s;
  if (s?.found) {
    await callTactic('travel_to', { target: { x: s.x, y: s.y, z: s.z }, arrive: 2 });
    const opened = await callTactic('open_station', { cell: { x: s.x, y: s.y, z: s.z } });
    if (opened?.ok) return { ok: true, cell: { x: s.x, y: s.y, z: s.z }, source: 'existing' };
  }
  // 2) 背包里的工作台：放下 + 打开
  let tableItem = await countOf('minecraft:crafting_table');
  if (tableItem <= 0) {
    const tableRecipe = await pickCraftable(callTactic, (it) => it === 'minecraft:crafting_table');
    if (tableRecipe) await callTactic('craft_batch', { recipe: tableRecipe.recipeId, count: 1 });
    tableItem = await countOf('minecraft:crafting_table');
  }
  if (tableItem > 0 && st?.pos) {
    const base = { x: Math.floor(st.pos.x), y: Math.floor(st.pos.y), z: Math.floor(st.pos.z) };
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0]];
    for (const [dx, dz] of offsets) {
      const cell = { x: base.x + dx, y: base.y, z: base.z + dz };
      const placed = await callTactic('place_one', { cell, block: 'minecraft:crafting_table' });
      if (!placed?.ok) continue;
      const opened = await callTactic('open_station', { cell });
      if (opened?.ok) return { ok: true, cell, source: 'placed' };
    }
  }
  return { ok: false, kind: 'no_station', message: '放不下/没有工作台' };
}

export async function craftWoodenGear(callTactic, st, need) {
  // 1) 先尝试就地采集木头
  const loc = await callTactic('locate_station', { block: '#minecraft:logs', radius: 32 });
  const s = loc?.vars?.s;
  if (s?.found) {
    await callTactic('travel_to', { target: { x: s.x, y: s.y, z: s.z }, arrive: 2 });
    await callTactic('dig_cluster', { block: '#minecraft:logs', radius: 16, count: 6 });
    await callTactic('collect_drops', { radius: 6 });
  }

  // 2) 木板（不同木头配方不同，动态找可做配方）
  let planks = await pickCraftable(callTactic, (it) => it.endsWith('_planks'));
  if (planks) {
    await callTactic('craft_batch', { recipe: planks.recipeId, count: 8 });
  }
  // 3) 木棍
  let sticks = await pickCraftable(callTactic, (it) => it === 'minecraft:stick');
  if (sticks) {
    await callTactic('craft_batch', { recipe: sticks.recipeId, count: 8 });
  }
  // 4) 工作台：附近有就开，没有就放背包里的/现做
  const bench = await ensureWorkbench(callTactic, st);
  const opened = !!bench.ok;

  // 5) 木剑（武器）
  const wantSword = need !== 'get_tools';
  let gotWeapon = false;
  if (wantSword) {
    const sword = await pickCraftable(callTactic, (it) => it === 'minecraft:wooden_sword');
    if (sword) {
      const made = await callTactic('craft_batch', { recipe: sword.recipeId, count: 1 });
      if (made?.ok) {
        await callTactic('equip_best', {});
        gotWeapon = true;
      }
    }
  }
  // 6) 工具（镐+斧）
  let gotPick = false;
  let gotAxe = false;
  if (need === 'get_tools' || !gotWeapon) {
    const pick = await pickCraftable(callTactic, (it) => it === 'minecraft:wooden_pickaxe');
    if (pick) {
      const made = await callTactic('craft_batch', { recipe: pick.recipeId, count: 1 });
      gotPick = !!made?.ok;
    }
    const axe = await pickCraftable(callTactic, (it) => it === 'minecraft:wooden_axe');
    if (axe) {
      const made = await callTactic('craft_batch', { recipe: axe.recipeId, count: 1 });
      gotAxe = !!made?.ok;
    }
    if (gotPick || gotAxe) await callTactic('equip_best', {});
  }

  return {
    ok: gotWeapon || gotPick || gotAxe,
    kind: gotWeapon || gotPick || gotAxe ? 'ok' : 'craft_failed',
    need,
    reason: 'crafted',
    crafted: { weapon: gotWeapon, pickaxe: gotPick, axe: gotAxe, table: opened },
    message: gotWeapon || gotPick || gotAxe ? undefined : '合成 fallback 没做成（缺材料/工作台/配方）',
  };
}

/** 从箱子补缺料：找附近箱子→开→把缺的材料 fetch 到背包。 */
async function fetchMissingFromChest(callTactic, missing) {
  if (!missing.length) return { ok: true, fetched: 0 };
  const loc = await callTactic('locate_station', { block: 'minecraft:chest', radius: 48 });
  const s = varsOf(loc).s;
  if (!s?.found) return { ok: false, kind: 'no_chest', message: '附近没有箱子可补料' };
  const cell = { x: s.x, y: s.y, z: s.z };
  await callTactic('travel_to', { target: cell, arrive: 2 });
  const sc = await callTactic('scan_container', { cell });
  const slots = varsOf(sc).c || {};
  const texts = Object.values(slots).map((v) => String(v));
  let fetched = 0;
  for (const m of missing) {
    const spec = ingredientSpec(m.item);
    const candidate = spec.list.find((it) => {
      const short = String(it).replace(/^minecraft:/, '');
      return texts.some((t) => t.includes(short));
    });
    if (!candidate) continue;
    const r = await callTactic('fetch_batch', { cell, item: candidate, count: m.need });
    if (r?.ok) fetched += 1;
  }
  return { ok: fetched > 0, fetched, chest: cell, message: fetched > 0 ? undefined : '箱子里也没有缺的材料' };
}

export async function makeItem(params, ctx, callTactic) {
  const item = String(params.item || '').trim();
  const want = Math.max(1, Math.floor(Number(params.count ?? 1)));
  if (!item) return { ok: false, kind: 'bad_argument', message: '缺少 item' };

  const countOf = async (it) => {
    const r = await callTactic('count_items', { item: it });
    return Number(varsOf(r).n?.count ?? 0);
  };
  const countIngredient = async (ing) => {
    const spec = ingredientSpec(ing);
    if (spec.kind === 'item') return countOf(spec.item);
    // tag/any：优先用观测到的背包；不逐个查 11 种木头（会吃光战术预算）
    return countInInventory(ctx?.state, spec.list);
  };
  const recipeOf = async (it) => {
    const r = await callTactic('query_recipes', { item: it });
    if (!r?.ok) return null;
    const v = varsOf(r).q || {};
    const ingredients = String(v.r1_ingredients ?? '').split('|').filter(Boolean);
    return {
      recipeId: v.r1_id ?? v.recipe_id,
      station: v.r1_station ?? v.station,
      makes: Number(v.r1_makes ?? v.makes ?? 1) || 1,
      grid: Number(v.r1_grid ?? v.grid ?? 2) || 2,
      ingredients,
    };
  };

  const before = await countOf(item);
  if (before >= want) {
    return { ok: true, item, count: want, made: 0, reason: 'already_have', before, after: before };
  }
  const rec = await recipeOf(item);
  if (!rec) return { ok: false, kind: 'no_recipe', message: `没有找到 ${item} 的配方（可能只能挖/交易）` };
  if (rec.station !== 'crafting') {
    return {
      ok: false,
      kind: 'unsupported_station',
      message: `v1 只支持 crafting，这个配方在 ${rec.station}`,
      recipeId: rec.recipeId,
    };
  }
  if (!rec.recipeId) return { ok: false, kind: 'bad_recipe', message: '配方缺少 id' };

  const delta = want - before;
  const craftsNeeded = Math.max(1, Math.ceil(delta / rec.makes));
  let missing = [];
  for (const ing of rec.ingredients) {
    const c = await countIngredient(ing);
    if (c < craftsNeeded) missing.push({ item: ing, need: craftsNeeded, have: c });
  }
  if (missing.length) {
    // 工作台制作前先查表，缺料去箱子取（用户规则：素材优先存箱子，做东西再取）
    const got = await fetchMissingFromChest(callTactic, missing);
    if (got.ok) {
      missing = [];
      for (const ing of rec.ingredients) {
        const c = await countIngredient(ing);
        if (c < craftsNeeded) missing.push({ item: ing, need: craftsNeeded, have: c });
      }
    }
    if (missing.length) {
      return {
        ok: false,
        kind: 'missing_material',
        message: `缺材料：${missing.map((m) => `${m.item}(${m.have}/${m.need})`).join(', ')}`,
        missing,
        recipeId: rec.recipeId,
        fetchedFromChest: !!got.ok,
      };
    }
  }

  // 3×3 配方需要工作台；2×2 先直接试
  const craft = async () => {
    const r = await callTactic('craft_batch', { recipe: rec.recipeId, count: delta });
    return r;
  };
  let res = null;
  let usedTable = false;
  if (rec.grid >= 3) {
    const bench = await ensureWorkbench(callTactic, ctx?.state);
    if (!bench.ok) {
      return { ok: false, kind: 'no_station', message: bench.message ?? '需要 3×3 工作台，但放不下/找不到', recipeId: rec.recipeId };
    }
    usedTable = true;
    res = await craft();
  } else {
    res = await craft();
    // 2×2 直接做失败时，兜底用工作台再试一次
    if (!res?.ok) {
      const bench = await ensureWorkbench(callTactic, ctx?.state);
      if (bench.ok) {
        usedTable = true;
        res = await craft();
      }
    }
  }

  if (!res?.ok) {
    return {
      ok: false,
      kind: res?.kind ?? 'craft_failed',
      message: `合成失败：${res?.message ?? '未知原因'}`,
      recipeId: rec.recipeId,
      usedTable,
    };
  }
  const after = await countOf(item);
  return {
    ok: after > before,
    kind: after > before ? 'ok' : 'verify_failed',
    message: after > before ? undefined : '合成后数量没有增加',
    item,
    recipeId: rec.recipeId,
    usedTable,
    before,
    after,
    made: after - before,
  };
}


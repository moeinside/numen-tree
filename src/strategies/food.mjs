/**
 * 食物战略（从 strategy.mjs 拆出）。
 * 只依赖 callTactic / ctx.state / 食物目录；不直接读游戏、不调 numen。
 */
import { edibleInInventory, foodInfo, isEdible, rawInInventory } from '../food.mjs';

function varsOf(r) {
  return r && r.ok ? r.vars || {} : {};
}

/** 吃背包里的食物，直到饥饿达到 target。 */
async function eatLoop(callTactic, target) {
  let hunger = 0;
  let eaten = 0;
  const items = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await callTactic('survive_eat', {});
    if (!r?.ok) {
      return {
        ok: eaten > 0 && hunger >= target,
        kind: eaten > 0 ? 'partial' : (r?.kind ?? 'no_food'),
        hunger,
        eaten,
        items,
        message: r?.message,
      };
    }
    const e = r.vars?.eat || {};
    hunger = Number(e.hunger_after ?? hunger);
    eaten += 1;
    if (e.item) items.push(String(e.item));
    if (hunger >= target) break;
  }
  return { ok: hunger >= target, kind: hunger >= target ? 'ok' : 'partial', hunger, eaten, items };
}

async function eatFromChest(callTactic, target, st, { maxDistance = 48 } = {}) {
  const loc = await callTactic('locate_station', { block: 'minecraft:chest', radius: 48 });
  const s = varsOf(loc).s;
  if (!s?.found) return { ok: false, kind: 'no_chest' };
  const cell = { x: s.x, y: s.y, z: s.z };
  // 夜间/紧急模式：太远的箱子不跑，避免把长链排进夜里。
  if (maxDistance != null && st?.pos != null) {
    const d = Math.hypot(Number(cell.x) - Number(st.pos.x), Number(cell.z) - Number(st.pos.z));
    if (Number.isFinite(d) && d > Number(maxDistance)) {
      return { ok: false, kind: 'chest_too_far', distance: Math.round(d) };
    }
  }
  await callTactic('travel_to', { target: cell, arrive: 2 });
  const sc = await callTactic('scan_container', { cell });
  const slots = varsOf(sc).c || {};
  const foods = [];
  for (const v of Object.values(slots)) {
    const text = String(v);
    const m = text.match(/minecraft:[a-z_]+/g) || [];
    for (const id of m) if (isEdible(id)) foods.push(id);
  }
  if (!foods.length) return { ok: false, kind: 'no_chest_food' };
  for (const id of foods.slice(0, 4)) await callTactic('fetch_batch', { cell, item: id, count: 8 });
  const out = await eatLoop(callTactic, target);
  return { ...out, source: 'chest' };
}

async function cookRawFood(callTactic, st, target) {
  const raw = rawInInventory(st?.inventory);
  if (!raw.length) return { ok: false, kind: 'no_raw_food' };
  let cell = null;
  const loc = await callTactic('locate_station', { block: 'minecraft:furnace', radius: 24 });
  const fs = varsOf(loc).s;
  if (fs?.found) {
    cell = { x: fs.x, y: fs.y, z: fs.z };
  } else {
    const cnt = await callTactic('count_items', { item: 'minecraft:furnace' });
    const have = Number(varsOf(cnt).n?.count ?? 0);
    if (have <= 0 || !st?.pos) return { ok: false, kind: 'no_furnace' };
    const base = { x: Math.floor(st.pos.x), y: Math.floor(st.pos.y), z: Math.floor(st.pos.z) };
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const c = { x: base.x + dx, y: base.y, z: base.z + dz };
      if ((await callTactic('place_one', { cell: c, block: 'minecraft:furnace' }))?.ok) {
        cell = c;
        break;
      }
    }
    if (!cell) return { ok: false, kind: 'no_furnace_cell' };
  }
  const fuel = (st?.inventory || []).find(
    (s) => (s.count ?? 0) > 0 && /^(minecraft:)(coal|charcoal|.*_planks|.*_log)$/.test(String(s.item)),
  );
  if (!fuel) return { ok: false, kind: 'no_fuel' };
  const targetRaw = raw[0];
  const sm = await callTactic('smelt_batch', {
    cell,
    item: targetRaw.item,
    count: 1,
    fuel: fuel.item,
    timeout: 10,
  });
  if (!sm?.ok) return { ok: false, kind: sm?.kind ?? 'cook_failed', message: sm?.message };
  const out = await eatLoop(callTactic, target);
  return { ...out, source: 'cooked' };
}

async function huntAnimal(callTactic, ctx, target) {
  const found = await callTactic('find_entity', { type: 'passive', radius: 24 });
  const e = varsOf(found).scan;
  if (!e?.count) return { ok: false, kind: 'no_animal' };
  const id = e.id;
  if (id == null) return { ok: false, kind: 'no_animal' };
  const hit = await callTactic('attack_target', { entityId: Number(id), radius: 24 });
  if (!hit?.ok) return { ok: false, kind: hit?.kind ?? 'hunt_failed', message: hit?.message };
  await callTactic('collect_drops', { radius: 6 });
  const out = await eatLoop(callTactic, target);
  return { ...out, source: 'hunt' };
}

/** 多来源食物：背包→箱子→烹饪生食→猎杀→急救。 */
export async function secureFood(params, ctx, callTactic) {
  const st = ctx?.state;
  if (!st) return { ok: false, kind: 'no_state', message: 'secure_food 需要 state' };
  const target = Math.max(1, Math.min(20, Number(params?.targetHunger ?? 16)));
  let hunger = Number(st.hunger ?? 0);
  if (hunger >= target) return { ok: true, reason: 'already_full', hunger, source: 'none' };
  const tried = [];

  // 0) 背包里已有食物（状态里 foodCount>0）：直接吃，不先扫描/找箱子
  if (Number(st.foodCount ?? 0) > 0) {
    const out = await eatLoop(callTactic, target);
    if (out.ok) return { ...out, source: 'inventory' };
    tried.push(out.kind);
    hunger = out.hunger ?? hunger;
  }

  // 1) 背包现成可直接吃的（优先熟食/植物，不先吃生肉）
  const ready = edibleInInventory(st.inventory, { emergency: hunger <= 2 }).filter(
    (f) => foodInfo(f.item)?.kind !== 'raw',
  );
  if (ready.length > 0) {
    const out = await eatLoop(callTactic, target);
    if (out.ok) return { ...out, source: 'inventory' };
    tried.push(out.kind);
    hunger = out.hunger ?? hunger;
  }

  // 2) 夜里：只吃背包/近处箱子，不排外出长链（烹饪/猎杀/远箱）。
  if (st.dark) {
    const rawSafe = edibleInInventory(st.inventory, { emergency: false }).filter(
      (f) => foodInfo(f.item)?.kind === 'raw',
    );
    if (rawSafe.length > 0) {
      const out = await eatLoop(callTactic, target);
      if (out.ok) return { ...out, source: 'raw_inventory_night' };
      tried.push(out.kind);
      hunger = out.hunger ?? hunger;
    }
    const out = await eatFromChest(callTactic, target, st, { maxDistance: 16 });
    if (out.ok) return out;
    tried.push(out.kind);
    return {
      ok: false,
      kind: 'no_food_night',
      hunger: out.hunger ?? hunger,
      tried: [...new Set(tried)].filter(Boolean),
      message: '夜里只查近处箱子和背包，不外出找食物',
    };
  }

  // 2) 箱子存粮
  if (hunger < target) {
    const out = await eatFromChest(callTactic, target, st);
    if (out.ok) return out;
    tried.push(out.kind);
    hunger = out.hunger ?? hunger;
  }

  // 3) 生食 + 炉 + 燃料 → 烹饪
  if (hunger < target) {
    const out = await cookRawFood(callTactic, st, target);
    if (out.ok) return out;
    tried.push(out.kind);
    hunger = out.hunger ?? hunger;
  }

  // 3.5) 有安全生食但做不了饭：先吃生的（生鸡肉等不安全的不吃）
  if (hunger < target) {
    const rawSafe = edibleInInventory(st.inventory, { emergency: false }).filter(
      (f) => foodInfo(f.item)?.kind === 'raw',
    );
    if (rawSafe.length > 0) {
      const out = await eatLoop(callTactic, target);
      if (out.ok) return { ...out, source: 'raw_inventory' };
      tried.push(out.kind);
      hunger = out.hunger ?? hunger;
    }
  }

  // 4) 白天、无敌对 → 猎杀
  if (hunger < target && !st.dark && (st.hostileCount ?? 0) === 0) {
    const out = await huntAnimal(callTactic, ctx, target);
    if (out.ok) return out;
    tried.push(out.kind);
    hunger = out.hunger ?? hunger;
  }

  // 5) 急救：饥饿<=2 时吃腐肉（eat_best 已把它排到最后）
  if (hunger <= 2) {
    const out = await eatLoop(callTactic, target);
    if (out.ok) return { ...out, source: 'emergency' };
    tried.push(out.kind);
  }

  return {
    ok: false,
    kind: 'no_food',
    hunger,
    tried: [...new Set(tried)].filter(Boolean),
    message: `找不到食物：${tried.join(' / ') || '无可用来源'}`,
  };
}


export async function eatToRecover(params, ctx, callTactic) {
  const target = Math.max(1, Math.min(20, Number(params?.targetHunger ?? 18)));
  let last = Number(ctx?.state?.hunger ?? 0);
  let eaten = 0;
  for (let i = 0; i < 6; i += 1) {
    const r = await callTactic('survive_eat', {});
    if (!r?.ok) {
      return { ok: false, kind: r?.kind ?? 'eat_failed', hunger: last, eaten, message: r?.message };
    }
    last = Number(r.vars?.eat?.hunger_after ?? last);
    eaten += 1;
    if (last >= target) break;
  }
  return {
    ok: last >= target,
    kind: last >= target ? 'ok' : 'partial',
    hunger: last,
    eaten,
    message: last >= target ? undefined : `只吃到 ${last}/${target}（可能没食物了）`,
  };
}


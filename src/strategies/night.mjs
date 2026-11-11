/**
 * 夜间战略（从 strategy.mjs 拆出）。
 */
import { hasWeapon } from '../needs.mjs';
import { varsOf } from './util.mjs';
import { pickCraftable } from './craft.mjs';
import { ensureSticks, mineCoal, makeCharcoal } from './fuel.mjs';
import { returnHome } from './safety.mjs';

export async function sleepThroughNight(params, ctx, callTactic) {
  const st = ctx?.state;
  if (!st?.dark) return { ok: true, reason: 'already_day' };
  const loc = await callTactic('locate_station', { block: '#minecraft:beds', radius: 32 });
  const s = loc?.vars?.s;
  if (!s?.found) return { ok: false, kind: 'no_bed', message: '附近没有床' };
  await callTactic('travel_to', { target: { x: s.x, y: s.y, z: s.z }, arrive: 2 });
  const sl = await callTactic('sleep_once', { cell: { x: s.x, y: s.y, z: s.z } });
  if (sl?.ok) return { ok: true, reason: 'slept' };
  return { ok: false, kind: 'sleep_failed', message: sl?.message ?? '睡不了（可能白天/太远）' };
}

export async function lightBase(params, ctx, callTactic) {
  const st = ctx?.state;
  const home = ctx?.homePlace;
  if (!home) return { ok: false, kind: 'no_home', message: '没有家/锚点记录' };
  // 夜里空手不出去找火把/放火把；先守家/搞武器
  if (st?.dark && !hasWeapon(st)) {
    return { ok: false, kind: 'need_gear', message: '夜里空手不出去照明：先做武器' };
  }
  const dist = st?.pos != null
    ? Math.hypot(Number(home.x) - Number(st.pos.x), Number(home.z) - Number(st.pos.z))
    : null;
  if (dist == null || dist > 8) {
    const mv = await callTactic('travel_to', { target: { x: home.x, y: home.y, z: home.z }, arrive: 3 });
    if (!mv?.ok) return { ok: false, kind: 'travel_failed', message: '回家失败，无法照明' };
  }

  const countTorch = async () => {
    const r = await callTactic('count_items', { item: 'minecraft:torch' });
    return Number(r?.vars?.n?.count ?? 0);
  };
  let torches = await countTorch();
  // 箱子里找火把
  if (torches === 0) {
    const loc = await callTactic('locate_station', { block: 'minecraft:chest', radius: 24 });
    const s = loc?.vars?.s;
    if (s?.found) {
      await callTactic('travel_to', { target: { x: s.x, y: s.y, z: s.z }, arrive: 2 });
      const sc = await callTactic('scan_container', { cell: { x: s.x, y: s.y, z: s.z } });
      const texts = [];
      const c = sc?.vars?.c || {};
      for (let i = 1; i <= 12; i += 1) if (c[`slot${i}`]) texts.push(String(c[`slot${i}`]));
      if (texts.join(' ').includes('minecraft:torch')) {
        await callTactic('fetch_batch', { cell: { x: s.x, y: s.y, z: s.z }, item: 'minecraft:torch', count: 16 });
        torches = await countTorch();
      }
    }
  }
  // 现做火把（需要燃料+木棍）
  if (torches === 0) {
    const torchRecipe = await pickCraftable(callTactic, (it) => it === 'minecraft:torch');
    if (torchRecipe) {
      await callTactic('craft_batch', { recipe: torchRecipe.recipeId, count: 8 });
      torches = await countTorch();
    }
  }
  // 还没火把：尝试挖煤→做木棍→做火把；没煤就烧木炭
  if (torches === 0) {
    let fuelReady = (await mineCoal({ count: 4 }, ctx, callTactic)).ok;
    if (!fuelReady) {
      fuelReady = (await makeCharcoal({}, ctx, callTactic)).ok;
    }
    if (fuelReady) {
      await ensureSticks(callTactic);
      const torchRecipe = await pickCraftable(callTactic, (it) => it === 'minecraft:torch');
      if (torchRecipe) {
        await callTactic('craft_batch', { recipe: torchRecipe.recipeId, count: 8 });
        torches = await countTorch();
      }
    }
  }
  if (torches === 0) return { ok: false, kind: 'no_torches', message: '没火把且做不了（缺燃料/木棍）' };

  // 在基地周围放一圈（最多 count 个）
  const want = Math.max(1, Math.min(8, Number(params?.count ?? 4)));
  const base = {
    x: Math.floor(Number(home.x)),
    y: Math.floor(Number(home.y)),
    z: Math.floor(Number(home.z)),
  };
  const offsets = [
    [3, 0], [-3, 0], [0, 3], [0, -3],
    [2, 2], [-2, 2], [2, -2], [-2, -2],
  ];
  let placed = 0;
  for (const [dx, dz] of offsets) {
    if (placed >= want) break;
    const cell = { x: base.x + dx, y: base.y, z: base.z + dz };
    const r = await callTactic('place_one', { cell, block: 'minecraft:torch' });
    if (r?.ok) placed += 1;
  }
  return {
    ok: placed > 0,
    kind: placed > 0 ? 'ok' : 'place_failed',
    placed,
    torches,
    message: placed > 0 ? undefined : '有火把但没放下去（位置不合适）',
  };
}

export async function prepareForNight(params, ctx, callTactic) {
  const st = ctx?.state;
  // 空手不出去做“过夜准备”：先把武器搞到（有武器才允许离基地/走夜路）
  if (!hasWeapon(st)) {
    return { ok: false, kind: 'need_gear', message: '空手不出去准备过夜：先做一把武器' };
  }
  if (!st?.dark) {
    // 白天：检查够不够；够就 return，不够就补光/找床；成功后由 lane 记“今天已准备”
    const bed = await callTactic('locate_station', { block: '#minecraft:beds', radius: 32 });
    if (varsOf(bed).s?.found) return { ok: true, reason: 'has_bed' };
    const torch = await callTactic('count_items', { item: 'minecraft:torch' });
    const torches = Number(varsOf(torch).n?.count ?? 0);
    if (torches >= 4) return { ok: true, reason: 'torches_enough', torches };
    const light = await lightBase(params, ctx, callTactic);
    if (light.ok) return { ...light, reason: 'lit' };
    return {
      ok: false,
      kind: 'no_night_solution',
      message: `白天准备不足：没床/火把不够（${torches}），${light.kind ?? 'no_torches'}`,
    };
  }
  // 夜里（手动调用/兜底）：找床睡或照明；自动需求在夜里不会派它
  // 先回家（离家远时）
  const home = ctx?.homePlace;
  if (home && st?.pos != null) {
    const d = Math.hypot(Number(home.x) - Number(st.pos.x), Number(home.z) - Number(st.pos.z));
    if (d > 8) {
      const rh = await returnHome({}, ctx, callTactic);
      if (!rh.ok) return { ...rh, kind: 'return_failed' };
    }
  }
  // 有床就睡
  const sleep = await sleepThroughNight({}, ctx, callTactic);
  if (sleep.ok) return { ...sleep, reason: 'slept' };
  // 否则照明
  const light = await lightBase(params, ctx, callTactic);
  if (light.ok) return { ...light, reason: 'lit' };
  return {
    ok: false,
    kind: 'no_night_solution',
    message: `没床/没火把/没燃料：${sleep.kind ?? 'no_bed'} / ${light.kind ?? 'no_torches'}`,
  };
}

/** 夜里被追/离家远：回家或就近守，不继续跑远。 */
export async function nightHold(params, ctx, callTactic) {
  const st = ctx?.state;
  if (!st) return { ok: false, kind: 'no_state', message: 'night_hold 需要 state' };
  const hostiles = Number(st.hostileCount ?? 0);
  if (!st.dark || hostiles === 0) return { ok: true, reason: 'already_safe' };
  const home = ctx?.homePlace;
  if (!home) return { ok: false, kind: 'no_home', message: '没有家/锚点记录，无法回家' };
  // 空手守夜：不硬打，先回安全屋（有武器才 patrol/guard）
  if (!hasWeapon(st)) {
    const d0 =
      st.pos != null
        ? Math.hypot(Number(home.x) - Number(st.pos.x), Number(home.z) - Number(st.pos.z))
        : null;
    if (d0 != null && d0 > 12) {
      const rh = await returnHome({}, ctx, callTactic);
      if (rh.ok) return { ...rh, reason: 'unarmed_retreat_home' };
    }
    return { ok: true, reason: 'unarmed_hold_safe_house', homeDistance: d0 };
  }
  const dist =
    st.pos != null
      ? Math.hypot(Number(home.x) - Number(st.pos.x), Number(home.z) - Number(st.pos.z))
      : null;
  if (dist != null && dist <= 16) {
    return { ok: true, reason: 'hold_near_home', homeDistance: dist };
  }
  const mv = await callTactic('travel_to', {
    target: { x: home.x, y: home.y, z: home.z },
    arrive: 3,
  });
  if (mv?.ok) return { ok: true, reason: 'returned_home' };
  return {
    ok: false,
    kind: 'return_failed',
    message: `回家路线失败（${mv?.kind ?? 'unknown'}），就地守，不继续跑远`,
  };
}

/** 从附近箱子里找现成武器/工具；没有就取材料（木板/原木/木棍/工作台）。 */

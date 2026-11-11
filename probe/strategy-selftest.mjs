/**
 * 战略包自测：node probe/strategy-selftest.mjs
 * 用假的 callTactic 覆盖 make_item 的分支（已拥有/2×2/3×3/缺料/无配方）。
 */
import {
  runStrategy,
  getStrategy,
  materialsInInventory,
  storeMaterialsCandidate,
  strategyTimePriority,
  strategyAllowedNow,
} from '../src/strategy.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeWorld(over = {}) {
  return {
    inventory: { 'minecraft:oak_log': 0, 'minecraft:oak_planks': 8, 'minecraft:stick': 0, ...(over.inventory || {}) },
    recipes: {
      'minecraft:stick': {
        id: 'minecraft:stick',
        station: 'crafting',
        makes: 4,
        grid: 2,
        ingredients: ['minecraft:oak_planks'],
      },
      ...(over.recipes || {}),
    },
    grid3: over.grid3 || false,
    tableFound: over.tableFound !== false,
    noRecipe: over.noRecipe || false,
    calls: [],
  };
}

function makeCtx(w) {
  const callTactic = async (tid, params = {}) => {
    w.calls.push({ tid, params });
    if (tid === 'count_items') {
      const n = Number(w.inventory[params.item] ?? 0);
      return { ok: true, vars: { n: { count: n } } };
    }
    if (tid === 'query_recipes') {
      const rec = w.recipes[params.item];
      if (w.noRecipe || !rec) return { ok: false, kind: 'not_success' };
      return {
        ok: true,
        vars: {
          q: {
            count: 1,
            r1_id: rec.id,
            r1_station: rec.station,
            r1_makes: rec.makes,
            r1_grid: rec.grid,
            r1_ingredients: rec.ingredients.join('|'),
            recipe_id: rec.id,
            station: rec.station,
            makes: rec.makes,
            grid: rec.grid,
          },
        },
      };
    }
    if (tid === 'locate_station') {
      if (!w.tableFound) return { ok: false, kind: 'not_success' };
      return { ok: true, vars: { s: { found: true, x: 10, y: 64, z: 10, distance: 2 } } };
    }
    if (tid === 'move_segment') return { ok: true, vars: {} };
    if (tid === 'open_station') {
      if (!w.tableFound) return { ok: false, kind: 'not_success' };
      return { ok: true, vars: { w: { opened: true } } };
    }
    if (tid === 'craft_batch') {
      const rec = w.recipes[params.recipe];
      if (!rec) return { ok: false, kind: 'no_recipe' };
      const delta = Number(params.count ?? 1);
      w.inventory[rec.id] = Number(w.inventory[rec.id] ?? 0) + delta;
      return { ok: true, vars: { c: { crafted: delta, carrying: w.inventory[rec.id], more: false } } };
    }
    return { ok: false, kind: 'unknown_tactic' };
  };
  return {
    callTactic,
    state: {
      inventory: Object.entries(w.inventory)
        .filter(([, n]) => Number(n) > 0)
        .map(([item, count]) => ({ item, count: Number(count) })),
    },
  };
}

console.log('战略注册：');
check('make_item 已注册', !!getStrategy('make_item'));
check('strategy. 前缀也能查', !!getStrategy('strategy.make_item'));

console.log('昼夜规范：');
{
  const day = { dark: false };
  const night = { dark: true };
  check('secure_gear 白天允许', strategyAllowedNow('secure_gear', day) === true);
  check('secure_gear 夜里不允许', strategyAllowedNow('secure_gear', night) === false);
  check('night_hold 夜里允许', strategyAllowedNow('night_hold', night) === true);
  check('night_hold 白天不允许', strategyAllowedNow('night_hold', day) === false);
  check('make_item 昼夜都允许', strategyAllowedNow('make_item', day) && strategyAllowedNow('make_item', night));
  check('secure_gear 夜里优先级降到 5', strategyTimePriority('secure_gear', night) === 5, String(strategyTimePriority('secure_gear', night)));
  check('night_hold 夜里优先级 85', strategyTimePriority('night_hold', night) === 85);
}

console.log('make_item：');
{
  const w = makeWorld({ inventory: { 'minecraft:stick': 8 } });
  const r = await runStrategy('make_item', { item: 'minecraft:stick', count: 4 }, makeCtx(w));
  check('已拥有足够 → 成功且不合成', r.ok === true && r.reason === 'already_have' && w.calls.length === 1, JSON.stringify(r).slice(0, 160));
}
{
  const w = makeWorld();
  const r = await runStrategy('make_item', { item: 'minecraft:stick', count: 4 }, makeCtx(w));
  check('2×2 有材料 → 合成成功', r.ok === true && r.usedTable === false, JSON.stringify(r).slice(0, 200));
  check('调用了 craft_batch', w.calls.some((c) => c.tid === 'craft_batch'));
  check('数量增加', Number(w.inventory['minecraft:stick']) >= 4, String(w.inventory['minecraft:stick']));
}
{
  const w = makeWorld({ grid3: true });
  w.recipes['minecraft:stick'].grid = 3;
  const r = await runStrategy('make_item', { item: 'minecraft:stick', count: 1 }, makeCtx(w));
  check('3×3 → 找台/移动/开台/合成', r.ok === true && r.usedTable === true, JSON.stringify(r).slice(0, 240));
  const tids = w.calls.map((c) => c.tid);
  check('顺序包含 locate→travel→open→craft', ['locate_station', 'travel_to', 'open_station', 'craft_batch'].every((t) => tids.includes(t)), tids.join(','));
}
{
  const w = makeWorld({ inventory: { 'minecraft:oak_planks': 0 } });
  const r = await runStrategy('make_item', { item: 'minecraft:stick', count: 4 }, makeCtx(w));
  check('缺料 → missing_material', r.ok === false && r.kind === 'missing_material', JSON.stringify(r).slice(0, 200));
  check('缺料时不合成', !w.calls.some((c) => c.tid === 'craft_batch'));
}
{
  const w = makeWorld({ noRecipe: true });
  const r = await runStrategy('make_item', { item: 'minecraft:stick', count: 1 }, makeCtx(w));
  check('无配方 → no_recipe', r.ok === false && r.kind === 'no_recipe', JSON.stringify(r).slice(0, 160));
}
{
  const w = makeWorld({ grid3: true, tableFound: false });
  w.recipes['minecraft:stick'].grid = 3;
  const r = await runStrategy('make_item', { item: 'minecraft:stick', count: 1 }, makeCtx(w));
  check('3×3 没工作台 → no_station', r.ok === false && r.kind === 'no_station', JSON.stringify(r).slice(0, 160));
}
{
  const w = makeWorld();
  const r = await runStrategy('nope', {}, makeCtx(w));
  check('未知战略 → unknown_strategy', r.ok === false && r.kind === 'unknown_strategy');
}

console.log('secure_gear（死后恢复装备）：');
{
  const state = {
    inventory: [{ item: 'minecraft:wooden_sword', count: 1 }],
    pos: { x: 0, y: 64, z: 0 },
    hp: 20,
    hunger: 20,
    hostileCount: 0,
    hostileDistance: null,
    dark: false,
  };
  const calls = [];
  const callTactic = async (tid) => { calls.push(tid); return { ok: false, kind: 'unexpected' }; };
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic, state, deathPlace: { x: 10, y: 64, z: 0 } });
  check('已有武器 → already_have，不动战术', r.ok === true && r.reason === 'already_have' && calls.length === 0, JSON.stringify(r).slice(0, 160));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 }, hp: 20, hunger: 20, hostileCount: 0, hostileDistance: null, dark: true };
  const callTactic = async () => ({ ok: true });
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic, state, deathPlace: { x: 10, y: 64, z: 0 } });
  check('夜里 → wait（不出去）', r.ok === false && r.kind === 'wait' && r.reasons.includes('night'), JSON.stringify(r).slice(0, 200));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 }, hp: 20, hunger: 20, hostileCount: 0, hostileDistance: null, dark: false };
  const calls = [];
  const callTactic = async (tid) => {
    calls.push(tid);
    if (tid === 'travel_to') return { ok: true };
    if (tid === 'collect_drops') return { ok: true, vars: { d: { count: 3 } } };
    if (tid === 'equip_best') return { ok: true, vars: { w: { held: 'minecraft:wooden_sword' } } };
    return { ok: false, kind: 'unexpected' };
  };
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic, state, deathPlace: { x: 10, y: 64, z: 0 } });
  check('白天安全+死亡点 → 去捡并成功', r.ok === true && r.recovered === true, JSON.stringify(r).slice(0, 200));
  check('顺序 travel→collect→equip', calls.join(',') === 'travel_to,collect_drops,equip_best', calls.join(','));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 }, hp: 20, hunger: 20, hostileCount: 0, hostileDistance: null, dark: false };
  const callTactic = async (tid) => {
    if (tid === 'travel_to') return { ok: false, kind: 'no_path', message: '走不动' };
    return { ok: true };
  };
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic, state, deathPlace: { x: 10, y: 64, z: 0 } });
  check('去死亡点失败 → travel_failed', r.ok === false && r.kind === 'travel_failed', JSON.stringify(r).slice(0, 160));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 }, hp: 20, hunger: 20, hostileCount: 0, hostileDistance: null, dark: false };
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic: async () => ({ ok: true }), state, deathPlace: null });
  check('没有死亡点且做不出 → craft_failed', r.ok === false && r.kind === 'craft_failed', JSON.stringify(r).slice(0, 200));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 }, hp: 20, hunger: 20, hostileCount: 0, hostileDistance: null, dark: false };
  const callTactic = async (tid, params) => {
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 4, y: 64, z: 4 } } };
    if (tid === 'query_craftable') {
      return {
        ok: true,
        vars: {
          c: {
            count: 5,
            r1_id: 'minecraft:oak_planks',
            r1_item: 'minecraft:oak_planks',
            r2_id: 'minecraft:stick',
            r2_item: 'minecraft:stick',
            r3_id: 'minecraft:crafting_table',
            r3_item: 'minecraft:crafting_table',
            r4_id: 'minecraft:wooden_sword',
            r4_item: 'minecraft:wooden_sword',
            r5_id: 'minecraft:wooden_pickaxe',
            r5_item: 'minecraft:wooden_pickaxe',
          },
        },
      };
    }
    if (tid === 'craft_batch' || tid === 'place_one' || tid === 'open_station' || tid === 'equip_best' || tid === 'travel_to' || tid === 'dig_cluster' || tid === 'collect_drops') {
      return { ok: true, vars: {} };
    }
    return { ok: false, kind: 'unexpected' };
  };
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic, state, deathPlace: null });
  check('没有死亡点但能就地做 → crafted 成功', r.ok === true && r.crafted?.weapon === true, JSON.stringify(r).slice(0, 240));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 }, hp: 20, hunger: 20, hostileCount: 1, hostileDistance: 12, dark: false };
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic: async () => ({ ok: true }), state, deathPlace: { x: 10, y: 64, z: 0 } });
  check('附近有敌对 → wait', r.ok === false && r.kind === 'wait' && r.reasons.includes('hostile_near'), JSON.stringify(r).slice(0, 200));
}

{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 }, hp: 20, hunger: 20, hostileCount: 0, hostileDistance: null, dark: false };
  const callTactic = async (tid) => {
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 2, y: 64, z: 2 } } };
    if (tid === 'scan_container') return { ok: true, vars: { c: { count: 2, slot1: 'minecraft:iron_sword x 1', slot2: 'minecraft:oak_planks x 16' } } };
    if (tid === 'fetch_batch') return { ok: true, vars: { f: { moved: 1 } } };
    if (tid === 'equip_best') return { ok: true, vars: { w: { held: 'minecraft:iron_sword' } } };
    if (tid === 'travel_to') return { ok: true };
    return { ok: true };
  };
  const r = await runStrategy('secure_gear', { need: 'get_weapon' }, { callTactic, state, deathPlace: null });
  check('附近箱子有现成武器 → 取来装备', r.ok === true && r.fromChest === true && r.item === 'minecraft:iron_sword', JSON.stringify(r).slice(0, 200));
}

console.log('night_hold（夜里不跑远）：');
{
  const state = { dark: false, hostileCount: 0, pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('night_hold', {}, { callTactic: async () => ({ ok: true }), state, homePlace: { x: 0, y: 64, z: 0 } });
  check('白天/无怪 → already_safe', r.ok === true && r.reason === 'already_safe');
}
{
  const state = { dark: true, hostileCount: 1, hostileDistance: 10, weapon: 'minecraft:wooden_sword', pos: { x: 100, y: 64, z: 0 } };
  const calls = [];
  const callTactic = async (tid) => { calls.push(tid); return { ok: true }; };
  const r = await runStrategy('night_hold', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('夜里离家远 → 回家', r.ok === true && r.reason === 'returned_home' && calls[0] === 'travel_to', JSON.stringify(r).slice(0, 160));
}
{
  const state = { dark: true, hostileCount: 1, hostileDistance: 10, weapon: 'minecraft:wooden_sword', pos: { x: 10, y: 64, z: 0 } };
  const r = await runStrategy('night_hold', {}, { callTactic: async () => ({ ok: true }), state, homePlace: { x: 0, y: 64, z: 0 } });
  check('已在家附近 → hold_near_home', r.ok === true && r.reason === 'hold_near_home', JSON.stringify(r).slice(0, 160));
}
{
  const state = { dark: true, hostileCount: 1, hostileDistance: 10, weapon: 'minecraft:wooden_sword', pos: { x: 100, y: 64, z: 0 } };
  const callTactic = async (tid) => (tid === 'travel_to' ? { ok: false, kind: 'no_path' } : { ok: true });
  const r = await runStrategy('night_hold', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('回家失败 → return_failed（就地守）', r.ok === false && r.kind === 'return_failed', JSON.stringify(r).slice(0, 160));
}
{
  const state = { dark: true, hostileCount: 1, hostileDistance: 10, weapon: 'minecraft:wooden_sword', pos: { x: 100, y: 64, z: 0 } };
  const r = await runStrategy('night_hold', {}, { callTactic: async () => ({ ok: true }), state, homePlace: null });
  check('没有家记录 → no_home', r.ok === false && r.kind === 'no_home', JSON.stringify(r).slice(0, 160));
}

console.log('配方 tag 解析（planks(any)）：');
{
  const w = makeWorld({
    inventory: { 'minecraft:oak_planks': 8, 'minecraft:stick': 4, 'minecraft:wooden_pickaxe': 0 },
    recipes: {
      'minecraft:wooden_pickaxe': {
        id: 'minecraft:wooden_pickaxe',
        station: 'crafting',
        makes: 1,
        grid: 3,
        ingredients: ['planks(any)', 'planks(any)', 'minecraft:stick'],
      },
    },
  });
  const r = await runStrategy('make_item', { item: 'minecraft:wooden_pickaxe', count: 1 }, makeCtx(w));
  check('planks(any) 能识别背包木板', r.ok === true && r.after >= 1, JSON.stringify(r).slice(0, 240));
  check('确实调用了 craft_batch', w.calls.some((c) => c.tid === 'craft_batch'));
}

console.log('store_materials（效用型）：');
{
  const state = {
    inventory: [
      { item: 'minecraft:oak_log', count: 12 },
      { item: 'minecraft:cobblestone', count: 20 },
      { item: 'minecraft:wooden_sword', count: 1 },
      { item: 'minecraft:apple', count: 2 },
    ],
  };
  const mats = materialsInInventory(state);
  check('只挑素材（排除剑/食物）', mats.some((m) => m.item === 'minecraft:oak_log') && !mats.some((m) => m.item.endsWith('_sword')) && !mats.some((m) => m.item.endsWith('apple')), JSON.stringify(mats));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('store_materials', {}, { callTactic: async () => ({ ok: true }), state, homePlace: { x: 0, y: 64, z: 0 } });
  check('没素材 → nothing_to_store', r.ok === false && r.kind === 'nothing_to_store', JSON.stringify(r).slice(0, 160));
}
{
  const state = {
    inventory: [{ item: 'minecraft:oak_log', count: 12 }],
    pos: { x: 0, y: 64, z: 0 },
  };
  const callTactic = async (tid) => {
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 1, y: 64, z: 1 } } };
    if (tid === 'store_batch') return { ok: true, vars: { s: { moved: 12 } } };
    if (tid === 'travel_to') return { ok: true };
    return { ok: true };
  };
  const r = await runStrategy('store_materials', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('有素材+箱子 → 存入成功', r.ok === true && r.moved === 12, JSON.stringify(r).slice(0, 200));
}
{
  const state = {
    inventory: [{ item: 'minecraft:oak_log', count: 12 }],
    pos: { x: 0, y: 64, z: 0 },
  };
  const callTactic = async (tid) => (tid === 'locate_station' ? { ok: false, kind: 'not_success' } : { ok: true });
  const r = await runStrategy('store_materials', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('没箱子 → no_chest', r.ok === false && r.kind === 'no_chest', JSON.stringify(r).slice(0, 160));
}
{
  const empty = { state: { inventory: [], pos: { x: 0, y: 64, z: 0 } }, homePlace: { x: 0, y: 64, z: 0 } };
  const full = {
    state: {
      inventory: [
        { item: 'minecraft:oak_log', count: 64 },
        { item: 'minecraft:cobblestone', count: 64 },
        { item: 'minecraft:dirt', count: 64 },
        { item: 'minecraft:sand', count: 64 },
        { item: 'minecraft:coal', count: 64 },
        { item: 'minecraft:iron_ore', count: 64 },
      ],
      pos: { x: 0, y: 64, z: 0 },
      hp: 6,
    },
    homePlace: { x: 0, y: 64, z: 0 },
  };
  const c1 = storeMaterialsCandidate(empty);
  const c2 = storeMaterialsCandidate(full);
  check('没素材 → 候选不可用', c1.eligible() === false);
  check('背包满+血低 → 候选分数更高', c2.eligible() === true && c2.score().total > c1.score().total, `${c1.score().total} vs ${c2.score().total}`);
}

console.log('过夜/补给战略：');
{
  const state = { hunger: 6, dark: false, pos: { x: 0, y: 64, z: 0 } };
  let hunger = 6;
  const callTactic = async (tid) => {
    if (tid === 'survive_eat') { hunger = Math.min(20, hunger + 4); return { ok: true, vars: { eat: { hunger_after: hunger } } }; }
    return { ok: true };
  };
  const r = await runStrategy('eat_to_recover', { targetHunger: 18 }, { callTactic, state });
  check('eat_to_recover 吃到目标', r.ok === true && r.hunger >= 18 && r.eaten >= 3, JSON.stringify(r).slice(0, 200));
}
{
  const state = { hunger: 6, dark: false };
  const r = await runStrategy('eat_to_recover', {}, { callTactic: async () => ({ ok: false, kind: 'no_food' }), state });
  check('没食物 → no_food', r.ok === false && r.kind === 'no_food');
}
{
  const state = { dark: false, pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('sleep_through_night', {}, { callTactic: async () => ({ ok: true }), state });
  check('白天 → already_day', r.ok === true && r.reason === 'already_day');
}
{
  const state = { dark: true, pos: { x: 50, y: 64, z: 0 } };
  const calls = [];
  const callTactic = async (tid) => {
    calls.push(tid);
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 0, y: 64, z: 0 } } };
    if (tid === 'travel_to' || tid === 'sleep_once') return { ok: true };
    return { ok: true };
  };
  const r = await runStrategy('sleep_through_night', {}, { callTactic, state });
  check('夜里找床→走→睡', r.ok === true && r.reason === 'slept' && calls.includes('sleep_once'), calls.join(','));
}
{
  const state = { dark: true, pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('sleep_through_night', {}, { callTactic: async (tid) => (tid === 'locate_station' ? { ok: false, kind: 'not_success' } : { ok: true }), state });
  check('没床 → no_bed', r.ok === false && r.kind === 'no_bed');
}
{
  const state = { pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('return_home', {}, { callTactic: async () => ({ ok: true }), state, homePlace: { x: 0, y: 64, z: 0 } });
  check('已在家 → already_home', r.ok === true && r.reason === 'already_home');
}
{
  const state = { pos: { x: 50, y: 64, z: 0 } };
  const calls = [];
  const callTactic = async (tid) => { calls.push(tid); return { ok: true }; };
  const r = await runStrategy('return_home', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('离家远 → 回家调用 travel_to', r.ok === true && calls.includes('travel_to'));
}
{
  const state = { pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('return_home', {}, { callTactic: async () => ({ ok: true }), state, homePlace: null });
  check('没有家 → no_home', r.ok === false && r.kind === 'no_home');
}
{
  const state = { pos: { x: 0, y: 64, z: 0 } };
  const calls = [];
  const callTactic = async (tid) => {
    calls.push(tid);
    if (tid === 'count_items') return { ok: true, vars: { n: { count: 4 } } };
    if (tid === 'place_one') return { ok: true, vars: { p: { placed: 1 } } };
    return { ok: true };
  };
  const r = await runStrategy('light_base', { count: 2 }, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('有火把 → 放火把成功', r.ok === true && r.placed === 2 && calls.includes('place_one'), JSON.stringify(r).slice(0, 200));
}
{
  const state = { pos: { x: 0, y: 64, z: 0 } };
  const callTactic = async (tid) => (tid === 'count_items' ? { ok: true, vars: { n: { count: 0 } } } : tid === 'locate_station' ? { ok: false } : { ok: true });
  const r = await runStrategy('light_base', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('没火把且做不了 → no_torches', r.ok === false && r.kind === 'no_torches', JSON.stringify(r).slice(0, 160));
}
{
  const state = { dark: true, pos: { x: 0, y: 64, z: 0 }, weapon: 'minecraft:wooden_sword' };
  const callTactic = async (tid) => {
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 0, y: 64, z: 0 } } };
    if (tid === 'travel_to' || tid === 'sleep_once') return { ok: true };
    return { ok: true };
  };
  const r = await runStrategy('prepare_for_night', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('夜里准备：优先睡觉', r.ok === true && r.reason === 'slept', JSON.stringify(r).slice(0, 200));
}
{
  const state = { dark: true, pos: { x: 0, y: 64, z: 0 }, weapon: 'minecraft:wooden_sword' };
  const callTactic = async (tid) => {
    if (tid === 'locate_station') return { ok: false }; // 没床/没箱子
    if (tid === 'count_items') return { ok: true, vars: { n: { count: 4 } } };
    if (tid === 'place_one') return { ok: true, vars: { p: { placed: 1 } } };
    return { ok: true };
  };
  const r = await runStrategy('prepare_for_night', {}, { callTactic, state, homePlace: { x: 0, y: 64, z: 0 } });
  check('没床但有火把 → 照明', r.ok === true && r.reason === 'lit', JSON.stringify(r).slice(0, 200));
}
{
  const state = { dark: true, pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('prepare_for_night', {}, { callTactic: async () => ({ ok: true }), state, homePlace: { x: 0, y: 64, z: 0 } });
  check('空手 → need_gear（不出去准备）', r.ok === false && r.kind === 'need_gear', JSON.stringify(r).slice(0, 160));
}

console.log('燃料链（挖煤）：');
{
  const state = { inventory: [] };
  const callTactic = async (tid) => (tid === 'count_items' ? { ok: true, vars: { n: { count: 3 } } } : { ok: true });
  const r = await runStrategy('mine_coal', {}, { callTactic, state });
  check('已有煤 → already_have', r.ok === true && r.reason === 'already_have', JSON.stringify(r).slice(0, 160));
}
{
  const state = { inventory: [] };
  let coal = 0;
  const calls = [];
  const callTactic = async (tid, params) => {
    calls.push(tid);
    if (tid === 'count_items') {
      if (String(params?.item || '').includes('pickaxe')) return { ok: true, vars: { n: { count: 1 } } };
      return { ok: true, vars: { n: { count: coal } } };
    }
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 5, y: 40, z: 5 } } };
    if (tid === 'travel_to') return { ok: true };
    if (tid === 'dig_cluster') { coal = 4; return { ok: true, vars: { d: { dug: 4 } } }; }
    if (tid === 'collect_drops') return { ok: true };
    return { ok: true };
  };
  const r = await runStrategy('mine_coal', {}, { callTactic, state });
  check('找到煤矿 → 挖到 4 煤', r.ok === true && r.coal === 4, JSON.stringify(r).slice(0, 200));
  check('调用了 dig_cluster', calls.includes('dig_cluster'));
}
{
  const state = { inventory: [] };
  const callTactic = async (tid, params) => {
    if (tid === 'count_items') {
      if (String(params?.item || '').includes('pickaxe')) return { ok: true, vars: { n: { count: 1 } } };
      return { ok: true, vars: { n: { count: 0 } } };
    }
    if (tid === 'locate_station') return { ok: false };
    return { ok: true };
  };
  const r = await runStrategy('mine_coal', {}, { callTactic, state });
  check('没煤矿 → no_coal', r.ok === false && r.kind === 'no_coal', JSON.stringify(r).slice(0, 160));
}

console.log('燃料链（烧木炭）：');
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 } };
  const callTactic = async (tid) => (tid === 'count_items' ? { ok: true, vars: { n: { count: 2 } } } : { ok: true });
  const r = await runStrategy('make_charcoal', {}, { callTactic, state });
  check('已有木炭 → already_have', r.ok === true && r.reason === 'already_have', JSON.stringify(r).slice(0, 160));
}
{
  const state = {
    inventory: [
      { item: 'minecraft:spruce_log', count: 2 },
      { item: 'minecraft:spruce_planks', count: 8 },
      { item: 'minecraft:crafting_table', count: 1 },
    ],
    pos: { x: 0, y: 64, z: 0 },
  };
  let cobble = 0;
  let charcoal = 0;
  const calls = [];
  const callTactic = async (tid, params) => {
    calls.push(tid);
    if (tid === 'count_items') {
      const item = params.item;
      if (item === 'minecraft:charcoal') return { ok: true, vars: { n: { count: charcoal } } };
      if (item === 'minecraft:cobblestone') return { ok: true, vars: { n: { count: cobble } } };
      if (item === 'minecraft:wooden_pickaxe') return { ok: true, vars: { n: { count: 1 } } };
      if (item === 'minecraft:crafting_table') return { ok: true, vars: { n: { count: 1 } } };
      if (item === 'minecraft:furnace') return { ok: true, vars: { n: { count: 1 } } };
      return { ok: true, vars: { n: { count: 0 } } };
    }
    if (tid === 'locate_station') {
      if (params.block === 'minecraft:stone') return { ok: true, vars: { s: { found: true, x: 5, y: 40, z: 5 } } };
      return { ok: true, vars: { s: { found: true, x: 1, y: 64, z: 1 } } };
    }
    if (tid === 'dig_cluster') { cobble = 10; return { ok: true, vars: { d: { dug: 8 } } }; }
    if (tid === 'query_craftable') {
      return { ok: true, vars: { c: { count: 1, r1_id: 'minecraft:furnace', r1_item: 'minecraft:furnace' } } };
    }
    if (tid === 'place_one') return { ok: true, vars: { p: { placed: 1 } } };
    if (tid === 'smelt_batch') { charcoal = 1; return { ok: true, vars: { m: { took: 1 } } }; }
    return { ok: true };
  };
  const r = await runStrategy('make_charcoal', {}, { callTactic, state });
  check('挖石→熔炉→烧炭 成功', r.ok === true && r.charcoal === 1, JSON.stringify(r).slice(0, 240));
  check('调用了 smelt_batch', calls.includes('smelt_batch'));
}
{
  const state = { inventory: [], pos: { x: 0, y: 64, z: 0 } };
  const callTactic = async (tid, params) => {
    if (tid === 'count_items') {
      if (params.item === 'minecraft:charcoal') return { ok: true, vars: { n: { count: 0 } } };
      if (params.item === 'minecraft:cobblestone') return { ok: true, vars: { n: { count: 0 } } };
      if (params.item === 'minecraft:wooden_pickaxe') return { ok: true, vars: { n: { count: 1 } } };
      return { ok: true, vars: { n: { count: 0 } } };
    }
    if (tid === 'locate_station') return { ok: false };
    return { ok: true };
  };
  const r = await runStrategy('make_charcoal', {}, { callTactic, state });
  check('没石头 → no_stone', r.ok === false && r.kind === 'no_stone', JSON.stringify(r).slice(0, 160));
}

console.log('secure_food（多来源）：');
{
  const state = {
    hunger: 6,
    dark: false,
    hostileCount: 0,
    pos: { x: 0, y: 64, z: 0 },
    inventory: [{ item: 'minecraft:cooked_beef', count: 3 }],
  };
  let hunger = 6;
  const callTactic = async (tid) => {
    if (tid === 'survive_eat') {
      hunger = Math.min(20, hunger + 5);
      return { ok: true, vars: { eat: { hunger_after: hunger, item: 'minecraft:cooked_beef' } } };
    }
    return { ok: true };
  };
  const r = await runStrategy('secure_food', { targetHunger: 16 }, { callTactic, state });
  check('背包有熟肉 → 吃到 16', r.ok === true && r.source === 'inventory' && r.hunger >= 16, JSON.stringify(r).slice(0, 200));
}
{
  const state = { hunger: 6, dark: true, hostileCount: 0, pos: { x: 0, y: 64, z: 0 }, inventory: [] };
  const callTactic = async (tid) => {
    if (tid === 'locate_station') return { ok: false, kind: 'not_success' };
    if (tid === 'count_items') return { ok: true, vars: { n: { count: 0 } } };
    return { ok: false, kind: 'no_food' };
  };
  const r = await runStrategy('secure_food', { targetHunger: 16 }, { callTactic, state });
  check('没任何来源 → no_food', r.ok === false && r.kind === 'no_food', JSON.stringify(r).slice(0, 200));
}
{
  const state = { hunger: 4, dark: true, hostileCount: 0, pos: { x: 0, y: 64, z: 0 }, inventory: [] };
  let hunger = 4;
  const callTactic = async (tid) => {
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 1, y: 64, z: 1 } } };
    if (tid === 'scan_container') return { ok: true, vars: { c: { slot1: 'minecraft:cooked_beef x 5' } } };
    if (tid === 'survive_eat') {
      hunger = Math.min(20, hunger + 5);
      return { ok: true, vars: { eat: { hunger_after: hunger, item: 'minecraft:cooked_beef' } } };
    }
    return { ok: true };
  };
  const r = await runStrategy('secure_food', { targetHunger: 16 }, { callTactic, state });
  check('箱子有食物 → 取来吃', r.ok === true && r.source === 'chest', JSON.stringify(r).slice(0, 200));
}
{
  const state = { hunger: 4, dark: false, hostileCount: 0, pos: { x: 0, y: 64, z: 0 }, inventory: [] };
  let hunger = 4;
  const callTactic = async (tid) => {
    if (tid === 'find_entity') return { ok: true, vars: { scan: { count: 1, id: 7, type: 'minecraft:cow' } } };
    if (tid === 'attack_target' || tid === 'collect_drops') return { ok: true };
    if (tid === 'locate_station') return { ok: false, kind: 'not_success' };
    if (tid === 'count_items') return { ok: true, vars: { n: { count: 0 } } };
    if (tid === 'survive_eat') {
      hunger = Math.min(20, hunger + 5);
      return { ok: true, vars: { eat: { hunger_after: hunger, item: 'minecraft:beef' } } };
    }
    return { ok: false };
  };
  const r = await runStrategy('secure_food', { targetHunger: 16 }, { callTactic, state });
  check('白天猎动物 → 吃', r.ok === true && r.source === 'hunt', JSON.stringify(r).slice(0, 200));
}
{
  const state = {
    hunger: 4,
    dark: true,
    hostileCount: 0,
    pos: { x: 0, y: 64, z: 0 },
    inventory: [{ item: 'minecraft:beef', count: 2 }, { item: 'minecraft:spruce_planks', count: 4 }],
  };
  let hunger = 4;
  const callTactic = async (tid) => {
    if (tid === 'locate_station') return { ok: true, vars: { s: { found: true, x: 2, y: 64, z: 2 } } };
    if (tid === 'smelt_batch') return { ok: true, vars: { m: { took: 1 } } };
    if (tid === 'survive_eat') {
      hunger = Math.min(20, hunger + 5);
      return { ok: true, vars: { eat: { hunger_after: hunger, item: 'minecraft:cooked_beef' } } };
    }
    return { ok: true };
  };
  const r = await runStrategy('secure_food', { targetHunger: 16 }, { callTactic, state });
  check('生肉+炉+燃料 → 烹饪后吃', r.ok === true && r.source === 'cooked', JSON.stringify(r).slice(0, 200));
}

console.log('escape_stuck（自主脱困）：');
{
  const state = { pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('escape_stuck', {}, { callTactic: async (tid) => ({ ok: tid === 'try_step' }), state });
  check('先 try_step 就能走 → 成功', r.ok === true && r.reason === 'try_step', JSON.stringify(r).slice(0, 160));
}
{
  const state = { pos: { x: 0, y: 64, z: 0 } };
  let steps = 0;
  const callTactic = async (tid) => {
    if (tid === 'try_step') return { ok: false, kind: 'blocked' };
    if (tid === 'move_segment') return { ok: true };
    return { ok: false, kind: 'failed' };
  };
  const r = await runStrategy('escape_stuck', {}, { callTactic, state });
  check('走不动但 move_segment 成功', r.ok === true && r.reason === 'move_segment', JSON.stringify(r).slice(0, 160));
}
{
  const state = { pos: { x: 0, y: 64, z: 0 } };
  const r = await runStrategy('escape_stuck', {}, { callTactic: async () => ({ ok: false, kind: 'no_path' }), state });
  check('全部失败 → stuck_failed', r.ok === false && r.kind === 'stuck_failed', JSON.stringify(r).slice(0, 200));
}

console.log('');
console.log(`战略包自测：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);

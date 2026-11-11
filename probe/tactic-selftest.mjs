/**
 * 战术包/原子/运行器自测（离线，无游戏、无树）。
 * 覆盖 docs/19 §8 的硬不变量：预算、until 上限、熔断、抢占后 settle、孤儿恢复。
 * 运行：node probe/tactic-selftest.mjs
 */
import { buildAtom, listAtoms } from '../src/atoms.mjs';
import { TACTICS } from '../src/tactics.mjs';
import { runTactic, runSettle, shouldAbandon, needsSettle } from '../src/tactic-runner.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

function makeFake(world = {}) {
  const w = { distance: 10, step: 4, inReach: false, air: false, hunger: 10, ...world };
  const calls = [];
  const executeAtom = async (atomId, params) => {
    calls.push({ atomId, params });
    switch (atomId) {
      case 'atom.move_segment': {
        if (w.moveFail) return { ok: false, kind: 'no_path', msg: '走不动' };
        w.distance = Math.max(0, w.distance - w.step);
        return { ok: true, moved: w.step, distance: w.distance, x: 0, y: 0, z: 0 };
      }
      case 'atom.scan_container':
        return { ok: true, count: 2, slot1: 'minecraft:oak_planks x 16', slot2: 'minecraft:stick x 8' };
      case 'atom.place_one':
        if (w.placeFail) return { ok: false, kind: 'out_of_reach', msg: '够不着' };
        return { ok: true, placed: 1, left: 0, block: params.block };
      case 'atom.dig_cluster':
        return { ok: true, found: !w.noCluster, dug: w.noCluster ? 0 : (params.count ?? 1), collected: 2 };
      case 'atom.sleep_once':
        if (w.dayTime) return { ok: false, kind: 'failed', msg: '现在不能睡' };
        return { ok: true, slept: true };
      case 'atom.scan_block':
        return { ok: true, air: w.air, in_reach: w.inReach, name: 'minecraft:dirt' };
      case 'atom.dig_one':
        w.air = true;
        return { ok: true, air: true, block: 'minecraft:dirt', delta: 1 };
      case 'atom.collect_near':
        return { ok: true, count: w.collectCount ?? 1 };
      case 'atom.eat_one': {
        const before = w.hunger;
        w.hunger = before + 2;
        return { ok: true, item: params.item, hunger_before: before, hunger_after: w.hunger, count_before: 1, count_after: 0 };
      }
      case 'atom.settle':
        w.settleCalls = (w.settleCalls ?? 0) + 1;
        return { ok: true, x: 0, y: 0, z: 0, items: 0 };
      case 'atom.fail_atom':
        return { ok: false, kind: 'no_path', msg: 'fake no path' };
      case 'atom.scan_entities':
        return {
          ok: true,
          count: w.hostiles ?? 0,
          id: w.hostileId ?? 7,
          name: 'minecraft:zombie',
          distance: w.threatDistance ?? 8,
          x: 0,
          y: 0,
          z: 0,
        };
      case 'atom.eat_best': {
        if (!w.hasFood) return { ok: false, kind: 'no_food', msg: '没吃的' };
        const before = w.hunger;
        w.hunger = before + 3;
        return { ok: true, item: 'minecraft:bread', hunger_before: before, hunger_after: w.hunger, count_before: 1, count_after: 0 };
      }
      case 'atom.equip_best_weapon':
        if (w.noWeapon) return { ok: true, held: null, no_weapon: true };
        return { ok: true, held: 'minecraft:wooden_sword', no_weapon: false };
      case 'atom.move_flee':
        w.threatDistance = Math.max(w.threatDistance ?? 8, 14);
        return { ok: true, distance: w.threatDistance, x: 0, y: 0, z: 0 };
      case 'atom.attack_one':
        w.hostiles = 0;
        return { ok: true, entityId: params.entityId, result: 'dead' };
      case 'atom.swing_once':
        w.hostiles = 0;
        w.entityPresent = false;
        return { ok: true, entityId: params.entityId, result: 'hit' };
      case 'atom.scan_entity_id':
        return {
          ok: true,
          present: w.entityPresent ?? true,
          id: params.entityId,
          hp: 20,
          distance: w.entityDistance ?? 2,
          x: 0,
          y: 0,
          z: 0,
        };
      case 'atom.recipe_query':
        if (w.noRecipe) return { ok: true, count: 0, recipes_json: '[]' };
        return {
          ok: true,
          count: 1,
          recipes_json: '[{"id":"minecraft:stick","station":"crafting","item":"minecraft:stick","makes":4,"ingredients":["minecraft:oak_planks"]}]',
          recipe_id: 'minecraft:stick',
          station: 'crafting',
          item: params.item,
          makes: 4,
        };
      case 'atom.craftable_query':
        if (w.noCraftable) return { ok: true, count: 0, recipes_json: '[]' };
        return {
          ok: true,
          count: 2,
          recipes_json: '[{"id":"minecraft:stick","station":"crafting"}]',
          recipe_id: 'minecraft:stick',
          station: 'crafting',
          item: 'minecraft:stick',
          makes: 4,
        };
      case 'atom.count_items':
        return { ok: true, item: params.item, count: w.itemCount ?? 12 };
      case 'atom.locate_station':
        if (w.noStation) return { ok: true, found: false, count: 0 };
        return {
          ok: true,
          found: true,
          count: 1,
          block: 'minecraft:crafting_table',
          x: 1,
          y: 2,
          z: 3,
          distance: 2,
        };
      case 'atom.open_station':
        if (w.noWindow) return { ok: true, opened: false, detail: 'clicked' };
        return { ok: true, opened: true, detail: 'window' };
      case 'atom.craft_batch':
        if (w.noMaterial) return { ok: false, kind: 'no_material', msg: '缺 2 个木板' };
        return { ok: true, crafted: params.count ?? 1, carrying: params.count ?? 1, more: false };
      case 'atom.store_batch':
        return { ok: true, moved: w.moved ?? 1, item: params.item };
      case 'atom.fetch_batch':
        return { ok: true, moved: w.moved ?? 1, item: params.item };
      case 'atom.smelt_batch':
        if (w.smeltFail) return { ok: false, kind: 'failed', msg: '炉子不可用' };
        return { ok: true, took: w.smelted ?? 1, item: params.item };
      case 'atom.collect_near':
        return { ok: true, count: w.collectCount ?? 2 };
      case 'atom.try_step':
        if (w.stuck) return { ok: false, kind: 'no_path', msg: '卡住' };
        return { ok: true, moved: 3, x: 0, y: 0, z: 0 };
      default:
        throw new Error(`fake 未实现 ${atomId}`);
    }
  };
  return { w, calls, executeAtom };
}

console.log('原子编译：');
check('原子数 >= 12', listAtoms().length >= 12, String(listAtoms().length));
check('move_segment 生成 move.to', buildAtom('move_segment', { target: { x: 1, y: 2, z: 3 } }).code.includes('numen.move.to'));
check('dig_one 生成 work.dig', buildAtom('dig_one', { cell: { x: 1, y: 2, z: 3 } }).code.includes('numen.work.dig'));
check('eat_one 生成 inv.eat', buildAtom('eat_one', { item: 'minecraft:bread' }).code.includes('numen.inv.eat'));
check('settle 生成 task.stop', buildAtom('settle').code.includes('numen.task.stop'));
check('scan_entities 生成 scan.entities', buildAtom('scan_entities', {}).code.includes('numen.scan.entities'));
check('eat_best 生成 inv.eat', buildAtom('eat_best').code.includes('numen.inv.eat'));
check('equip_best_weapon 生成 gear.hold', buildAtom('equip_best_weapon').code.includes('numen.gear.hold'));
check('move_flee 生成 move.flee', buildAtom('move_flee', { from: { x: 1, y: 2, z: 3 } }).code.includes('numen.move.flee'));
check('attack_one 生成 fight.attack', buildAtom('attack_one', { entityId: 7 }).code.includes('numen.fight.attack'));
check('swing_once 生成 use.hit', buildAtom('swing_once', { entityId: 7 }).code.includes('numen.use.hit'));
check('scan_entity_id 生成 scan.entities', buildAtom('scan_entity_id', { entityId: 7 }).code.includes('numen.scan.entities'));
check('recipe_query 生成 inv.recipes', buildAtom('recipe_query', { item: 'minecraft:stick' }).code.includes('numen.inv.recipes'));
check('craftable_query 生成 inv.craftable', buildAtom('craftable_query', {}).code.includes('numen.inv.craftable'));
check('count_items 生成 inv.count', buildAtom('count_items', { item: 'minecraft:stick' }).code.includes('numen.inv.count'));
check('locate_station 生成 scan.blocks', buildAtom('locate_station', {}).code.includes('numen.scan.blocks'));
check('open_station 生成 use.block', buildAtom('open_station', { cell: { x: 1, y: 2, z: 3 } }).code.includes('numen.use.block'));
check('craft_batch 生成 inv.craft', buildAtom('craft_batch', { recipe: 'minecraft:stick', count: 1 }).code.includes('numen.inv.craft'));
check('store_batch 生成 inv.store', buildAtom('store_batch', { cell: { x: 1, y: 2, z: 3 }, item: 'minecraft:stick' }).code.includes('numen.inv.store'));
check('fetch_batch 生成 inv.fetch', buildAtom('fetch_batch', { cell: { x: 1, y: 2, z: 3 }, item: 'minecraft:stick' }).code.includes('numen.inv.fetch'));
check('smelt_batch 生成 inv.smelt', buildAtom('smelt_batch', { cell: { x: 1, y: 2, z: 3 }, item: 'minecraft:iron_ore' }).code.includes('numen.inv.smelt'));
check('collect_drops 生成 work.collect', buildAtom('collect_near', { radius: 6 }).code.includes('numen.work.collect'));
check('equip_best 生成 gear.hold', buildAtom('equip_best_weapon').code.includes('numen.gear.hold'));
check('scan_container 生成 scan.container', buildAtom('scan_container', { cell: { x: 1, y: 2, z: 3 } }).code.includes('numen.scan.container'));
check('place_one 生成 build.place', buildAtom('place_one', { cell: { x: 1, y: 2, z: 3 }, block: 'minecraft:crafting_table' }).code.includes('numen.build.place'));
check('dig_cluster 生成 scan.blocks+work.dig', buildAtom('dig_cluster', { block: 'minecraft:oak_log' }).code.includes('numen.scan.blocks') && buildAtom('dig_cluster', { block: 'minecraft:oak_log' }).code.includes('numen.work.dig'));
check('sleep_once 生成 use.sleep', buildAtom('sleep_once', {}).code.includes('numen.use.sleep'));
check('try_step 生成 move.to', buildAtom('try_step').code.includes('numen.move.to'));
check('未知原子抛错', (() => { try { buildAtom('nope'); return false; } catch { return true; } })());
check('缺 cell 抛错', (() => { try { buildAtom('dig_one', {}); return false; } catch { return true; } })());

console.log('战术包运行：');
{
  const { w, executeAtom } = makeFake({ distance: 10, step: 4 });
  const r = await runTactic('move_segment', { target: { x: 0, y: 0, z: 0 }, arrive: 2 }, { executeAtom });
  check('move 到达（until 收敛）', r.ok && w.distance <= 2, JSON.stringify(r).slice(0, 200));
  check('move 用了 2 个原子', r.atoms === 2, String(r.atoms));
}
{
  const fake = makeFake({ inReach: false, air: false });
  const r = await runTactic('dig_one', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: fake.executeAtom });
  const order = fake.calls.map((c) => c.atomId).join('>');
  check('dig 成功', r.ok === true, JSON.stringify(r).slice(0, 200));
  check(
    'dig 顺序 scan>move>dig>collect',
    order === 'atom.scan_block>atom.move_segment>atom.dig_one>atom.collect_near',
    order,
  );
}
{
  const fake = makeFake({ inReach: true, air: false });
  const r = await runTactic('dig_one', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: fake.executeAtom });
  check('dig 在 reach 内不移动', r.ok && fake.calls.length === 3, fake.calls.map((c) => c.atomId).join('>'));
}
{
  // 世界已变：方块本来就是空气 → 直接完成，不挖
  const fake = makeFake({ air: true });
  const r = await runTactic('dig_one', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: fake.executeAtom });
  check('孤儿恢复：已空气 → 干净完成', r.ok && !fake.calls.some((c) => c.atomId === 'atom.dig_one'), JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ hunger: 10 });
  const r = await runTactic('eat_one', { item: 'minecraft:bread' }, { executeAtom: fake.executeAtom });
  check('eat 成功（饥饿上升）', r.ok === true, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ hunger: 20 });
  const executeAtom = async (id, p) => ({ ok: true, hunger_before: 20, hunger_after: 20, count_before: 1, count_after: 1 });
  const r = await runTactic('eat_one', { item: 'minecraft:bread' }, { executeAtom });
  check('eat 未回血 → not_success（不假成功）', r.ok === false && r.kind === 'not_success', JSON.stringify(r).slice(0, 160));
}

console.log('生存战术（Batch A）：');
{
  const fake = makeFake({ hunger: 10, hasFood: true });
  const r = await runTactic('survive_eat', {}, { executeAtom: fake.executeAtom });
  check('survive_eat 有食物 → 成功', r.ok === true, JSON.stringify(r).slice(0, 160));
  check('survive_eat 只用了 1 个原子', r.atoms === 1, String(r.atoms));
}
{
  const fake = makeFake({ hasFood: false });
  const r = await runTactic('survive_eat', {}, { executeAtom: fake.executeAtom });
  check('survive_eat 无食物 → no_food', r.ok === false && r.kind === 'no_food', JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ hostiles: 1, threatDistance: 8 });
  const r = await runTactic('survive_flee', { distance: 12 }, { executeAtom: fake.executeAtom });
  check('survive_flee 逃到安全距离', r.ok === true, JSON.stringify(r).slice(0, 160));
  check('survive_flee 用了 3 个原子（扫→逃→再扫）', r.atoms === 3, String(r.atoms));
}
{
  const fake = makeFake({ hostiles: 0 });
  const r = await runTactic('survive_flee', { distance: 12 }, { executeAtom: fake.executeAtom });
  check('survive_flee 无敌人 → 直接成功', r.ok === true && r.atoms === 1, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ hostiles: 1, threatDistance: 3 });
  const r = await runTactic('survive_fight', {}, { executeAtom: fake.executeAtom });
  check('survive_fight 击杀目标 → 成功', r.ok === true, JSON.stringify(r).slice(0, 160));
  check('survive_fight 用了 4 个原子（扫→换武器→挥击→再扫）', r.atoms === 4, String(r.atoms));
}
{
  const fake = makeFake({ entityPresent: true, entityDistance: 2 });
  const r = await runTactic('attack_target', { entityId: 7 }, { executeAtom: fake.executeAtom });
  check('attack_target 指定目标击杀 → 成功', r.ok === true, JSON.stringify(r).slice(0, 160));
  check('attack_target 用了 4 个原子（查→换武器→挥击→再查）', r.atoms === 4, String(r.atoms));
}
{
  const fake = makeFake({ entityPresent: false });
  const r = await runTactic('attack_target', { entityId: 7 }, { executeAtom: fake.executeAtom });
  check('attack_target 目标已不在 → 直接成功', r.ok === true && r.atoms === 1, JSON.stringify(r).slice(0, 160));
}
console.log('只读战术（Batch B）：');
{
  const fake = makeFake({});
  const r = await runTactic('query_recipes', { item: 'minecraft:stick' }, { executeAtom: fake.executeAtom });
  check('query_recipes 找到配方 → 成功', r.ok === true, JSON.stringify(r).slice(0, 160));
  check('query_recipes 返回 recipe_id', r.vars?.q?.recipe_id === 'minecraft:stick', JSON.stringify(r.vars?.q));
}
{
  const fake = makeFake({ noRecipe: true });
  const r = await runTactic('query_recipes', { item: 'minecraft:diamond' }, { executeAtom: fake.executeAtom });
  check('query_recipes 无配方 → not_success', r.ok === false && r.kind === 'not_success', JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({});
  const r = await runTactic('query_craftable', {}, { executeAtom: fake.executeAtom });
  check('query_craftable 有可做 → 成功', r.ok === true, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ noCraftable: true });
  const r = await runTactic('query_craftable', {}, { executeAtom: fake.executeAtom });
  check('query_craftable 没材料 → not_success', r.ok === false && r.kind === 'not_success', JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ itemCount: 12 });
  const r = await runTactic('count_items', { item: 'minecraft:stick' }, { executeAtom: fake.executeAtom });
  check('count_items 返回数量', r.ok === true && r.vars?.n?.count === 12, JSON.stringify(r.vars?.n));
}
{
  const fake = makeFake({ itemCount: 0 });
  const r = await runTactic('count_items', { item: 'minecraft:stick' }, { executeAtom: fake.executeAtom });
  check('count_items 数量 0 也算成功', r.ok === true && r.vars?.n?.count === 0, JSON.stringify(r.vars?.n));
}
{
  const fake = makeFake({});
  const r = await runTactic('locate_station', { block: 'minecraft:crafting_table' }, { executeAtom: fake.executeAtom });
  check('locate_station 找到工作台', r.ok === true && r.vars?.s?.found === true, JSON.stringify(r.vars?.s));
}
{
  const fake = makeFake({ noStation: true });
  const r = await runTactic('locate_station', {}, { executeAtom: fake.executeAtom });
  check('locate_station 找不到 → not_success', r.ok === false && r.kind === 'not_success', JSON.stringify(r).slice(0, 160));
}

console.log('生存/建造战术（Batch C）：');
{
  const fake = makeFake({});
  const r = await runTactic('scan_container', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: fake.executeAtom });
  check('scan_container 查到 2 格 → 成功', r.ok === true && r.vars?.c?.count === 2, JSON.stringify(r.vars?.c));
}
{
  const fake = makeFake({});
  const r = await runTactic('place_one', { cell: { x: 1, y: 2, z: 3 }, block: 'minecraft:crafting_table' }, { executeAtom: fake.executeAtom });
  check('place_one 放下 1 个 → 成功', r.ok === true && r.vars?.p?.placed === 1, JSON.stringify(r.vars?.p));
}
{
  const fake = makeFake({ placeFail: true });
  const r = await runTactic('place_one', { cell: { x: 1, y: 2, z: 3 }, block: 'minecraft:crafting_table' }, { executeAtom: fake.executeAtom });
  check('place_one 够不着 → out_of_reach', r.ok === false && r.kind === 'out_of_reach', JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({});
  const r = await runTactic('dig_cluster', { block: 'minecraft:oak_log', count: 3 }, { executeAtom: fake.executeAtom });
  check('dig_cluster 挖到 3 个 → 成功', r.ok === true && r.vars?.d?.dug === 3, JSON.stringify(r.vars?.d));
}
{
  const fake = makeFake({ noCluster: true });
  const r = await runTactic('dig_cluster', { block: 'minecraft:oak_log' }, { executeAtom: fake.executeAtom });
  check('dig_cluster 没找到 → not_success', r.ok === false && r.kind === 'not_success');
}
{
  const fake = makeFake({});
  const r = await runTactic('sleep_once', {}, { executeAtom: fake.executeAtom });
  check('sleep_once 入睡 → 成功', r.ok === true && r.vars?.s?.slept === true, JSON.stringify(r.vars?.s));
}
{
  const fake = makeFake({ dayTime: true });
  const r = await runTactic('sleep_once', {}, { executeAtom: fake.executeAtom });
  check('sleep_once 白天睡不了 → 失败', r.ok === false, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({});
  const r = await runTactic('travel_to', { target: { x: 10, y: 64, z: 10 }, arrive: 2 }, { executeAtom: fake.executeAtom });
  check('travel_to 分片走到目标 → 成功', r.ok === true, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ moveFail: true });
  const r = await runTactic('travel_to', { target: { x: 10, y: 64, z: 10 }, arrive: 2 }, { executeAtom: fake.executeAtom });
  check('travel_to 走不动 → no_path', r.ok === false && r.kind === 'no_path', JSON.stringify(r).slice(0, 160));
}

console.log('交互战术（Batch B）：');
{
  const fake = makeFake({});
  const r = await runTactic('open_station', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: fake.executeAtom });
  check('open_station 打开窗口 → 成功', r.ok === true && r.vars?.w?.opened === true, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ noWindow: true });
  const r = await runTactic('open_station', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: fake.executeAtom });
  check('open_station 没窗口 → not_success', r.ok === false && r.kind === 'not_success', JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({});
  const r = await runTactic('craft_batch', { recipe: 'minecraft:stick', count: 4 }, { executeAtom: fake.executeAtom });
  check('craft_batch 做出 4 个 → 成功', r.ok === true && r.vars?.c?.crafted === 4, JSON.stringify(r.vars?.c));
}
{
  const fake = makeFake({ noMaterial: true });
  const r = await runTactic('craft_batch', { recipe: 'minecraft:stick', count: 4 }, { executeAtom: fake.executeAtom });
  check('craft_batch 缺材料 → no_material', r.ok === false && r.kind === 'no_material', JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ moved: 3 });
  const r = await runTactic('store_batch', { cell: { x: 1, y: 2, z: 3 }, item: 'minecraft:stick' }, { executeAtom: fake.executeAtom });
  check('store_batch 存入 3 个', r.ok === true && r.vars?.s?.moved === 3, JSON.stringify(r.vars?.s));
}
{
  const fake = makeFake({ moved: 2 });
  const r = await runTactic('fetch_batch', { cell: { x: 1, y: 2, z: 3 }, item: 'minecraft:stick' }, { executeAtom: fake.executeAtom });
  check('fetch_batch 取出 2 个', r.ok === true && r.vars?.f?.moved === 2, JSON.stringify(r.vars?.f));
}
{
  const fake = makeFake({ smelted: 3 });
  const r = await runTactic('smelt_batch', { cell: { x: 1, y: 2, z: 3 }, item: 'minecraft:iron_ore', count: 3 }, { executeAtom: fake.executeAtom });
  check('smelt_batch 熔出 3 个 → 成功', r.ok === true && r.vars?.m?.took === 3, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ smeltFail: true });
  const r = await runTactic('smelt_batch', { cell: { x: 1, y: 2, z: 3 }, item: 'minecraft:iron_ore' }, { executeAtom: fake.executeAtom });
  check('smelt_batch 炉子不可用 → 失败 kind', r.ok === false && r.kind === 'failed', JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ collectCount: 3 });
  const r = await runTactic('collect_drops', { radius: 6 }, { executeAtom: fake.executeAtom });
  check('collect_drops 捡到 3 个 → 成功', r.ok === true && r.vars?.d?.count === 3, JSON.stringify(r.vars?.d));
}
{
  const fake = makeFake({ collectCount: 0 });
  const r = await runTactic('collect_drops', {}, { executeAtom: fake.executeAtom });
  check('collect_drops 没掉落 → not_success', r.ok === false && r.kind === 'not_success');
}
{
  const fake = makeFake({});
  const r = await runTactic('equip_best', {}, { executeAtom: fake.executeAtom });
  check('equip_best 有武器 → 成功', r.ok === true && r.vars?.w?.held === 'minecraft:wooden_sword', JSON.stringify(r.vars?.w));
}
{
  const fake = makeFake({ noWeapon: true });
  const r = await runTactic('equip_best', {}, { executeAtom: fake.executeAtom });
  check('equip_best 没武器 → not_success', r.ok === false && r.kind === 'not_success');
}

{
  const fake = makeFake({ stuck: false });
  const r = await runTactic('survive_unstick', {}, { executeAtom: fake.executeAtom });
  check('survive_unstick 挪动成功', r.ok === true, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ stuck: true });
  const r = await runTactic('survive_unstick', {}, { executeAtom: fake.executeAtom });
  check('survive_unstick 卡死 → no_path（不无限重试）', r.ok === false && r.kind === 'no_path', JSON.stringify(r).slice(0, 160));
}

console.log('防死循环：');
{
  const fake = makeFake({ distance: 100, step: 0 });
  const r = await runTactic('move_segment', { target: { x: 0, y: 0, z: 0 }, arrive: 2 }, { executeAtom: fake.executeAtom });
  check('until 不可能满足 → loop_exhausted', r.ok === false && r.kind === 'loop_exhausted', JSON.stringify(r).slice(0, 160));
  check('until 有 maxRounds（原子=8）', r.atoms === 8, String(r.atoms));
}
{
  const fake = makeFake({ distance: 100, step: 0 });
  const r = await runTactic(
    'move_segment',
    { target: { x: 0, y: 0, z: 0 }, arrive: 2 },
    { executeAtom: fake.executeAtom, budget: { maxAtoms: 5, maxSeconds: 60 } },
  );
  check('maxAtoms 兜底 → budget', r.ok === false && r.kind === 'budget' && r.atoms === 5, JSON.stringify(r).slice(0, 160));
}
{
  const fake = makeFake({ inReach: true, air: false });
  const r = await runTactic('dig_one', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: async () => ({ ok: false, kind: 'no_path' }) });
  check('单次失败 → no_path', r.ok === false && r.kind === 'no_path', JSON.stringify(r).slice(0, 160));
}
{
  // 测试专用战术：retry 5 次，但熔断应在同一失败第 3 次触发
  TACTICS.__selftest_retry = {
    id: 'tactic.__selftest_retry',
    budget: { maxAtoms: 10, maxSeconds: 5 },
    steps: [{ op: 'retry', maxTries: 5, steps: [{ op: 'atom', atom: 'atom.fail_atom', as: 'f' }] }],
    success: { op: 'true' },
  };
  const fake = makeFake();
  const r = await runTactic('__selftest_retry', {}, { executeAtom: fake.executeAtom, budget: { maxSameFail: 3 } });
  check('同失败熔断 → breaker', r.ok === false && r.kind === 'breaker', JSON.stringify(r).slice(0, 160));
  check('熔断后只跑了 3 个原子', r.atoms === 3, String(r.atoms));
  delete TACTICS.__selftest_retry;
}

console.log('抢占 + settle：');
{
  const fake = makeFake({ inReach: false, air: false });
  const r = await runTactic('dig_one', { cell: { x: 1, y: 2, z: 3 } }, { executeAtom: fake.executeAtom, interruptBeforeAtom: 2 });
  check('注入抢占 → preempted', r.ok === false && r.preempted === true, JSON.stringify(r).slice(0, 160));
  check('抢占后没有继续跑原子', r.atoms === 1, String(r.atoms));
  const sr = await runSettle(fake.executeAtom);
  check('settle 跑成功', sr.ok === true, JSON.stringify(sr).slice(0, 160));
  check('settle 只跑了一次任务停止原子', fake.calls.filter((c) => c.atomId === 'atom.settle').length === 1, '');
}
check('needsSettle(preempted/timeout)=true', needsSettle('preempted') && needsSettle('timeout'));
check('needsSettle(detached)=true（外部急刹切断原子）', needsSettle('detached'));
check('needsSettle(ok)=false', !needsSettle('ok'));
check('thrash: 3 次/30s 内 → 放弃', shouldAbandon({ preemptCount: 3, firstPreemptAt: 1000, now: 5000, windowMs: 30000 }));
check('thrash: 2 次 → 不放弃', !shouldAbandon({ preemptCount: 2, firstPreemptAt: 1000, now: 5000 }));
check('thrash: 窗口外 → 不放弃', !shouldAbandon({ preemptCount: 3, firstPreemptAt: 1000, now: 60000, windowMs: 30000 }));

console.log(`\n战术包自测：${pass}/${pass + fail} 通过${fail ? `（失败 ${fail}）` : ''}`);
process.exit(fail ? 1 : 0);

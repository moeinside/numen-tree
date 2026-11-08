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
        w.distance = Math.max(0, w.distance - w.step);
        return { ok: true, moved: w.step, distance: w.distance, x: 0, y: 0, z: 0 };
      }
      case 'atom.scan_block':
        return { ok: true, air: w.air, in_reach: w.inReach, name: 'minecraft:dirt' };
      case 'atom.dig_one':
        w.air = true;
        return { ok: true, air: true, block: 'minecraft:dirt', delta: 1 };
      case 'atom.collect_near':
        return { ok: true, count: 1 };
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

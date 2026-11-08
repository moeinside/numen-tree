/**
 * 场景：战术包 lane 集成（move_segment + dig_one）。
 * 验证：lane 能执行 skill='tactic' 目标；每个战术包按原子序列跑；tactic_done 落 trace。
 * FakeNumen 用 fixture.luaResult 直接拦原子 Lua 代码（原子没有独立技能名）。
 */
import { obs, check } from './_common.mjs';
import { makeGoal } from '../../src/state.mjs';

export default {
  id: 'tactic_lane',
  title: '战术包集成：lane 跑 move_segment/dig_one（多原子）',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs(), obs()],
  setup(ctx) {
    ctx.evidence.tac = { distance: 10, moveCalls: 0, settle: 0, atoms: [] };
    ctx.evidence.g1 = makeGoal({
      skill: 'tactic',
      params: { tactic: 'move_segment', params: { target: { x: 100, y: 64, z: -40 }, arrive: 2 } },
      priority: 40,
      note: 'mcp',
    });
    ctx.evidence.g2 = makeGoal({
      skill: 'tactic',
      params: { tactic: 'dig_one', params: { cell: { x: 100, y: 63, z: -40 } } },
      priority: 40,
      note: 'mcp',
    });
    ctx.lane.state.pushGoal(ctx.evidence.g1);
    ctx.lane.state.pushGoal(ctx.evidence.g2);
  },
  luaResult(ctx, code) {
    const ev = ctx.evidence.tac;
    if (!ev) return null;
    const ret = (obj) => ({ result: { kind: 'returned', value: JSON.stringify(obj) } });
    if (code.includes('numen.move.to')) {
      ev.moveCalls += 1;
      ev.distance = Math.max(0, ev.distance - 4);
      ev.atoms.push('move');
      return ret({ ok: true, moved: 4, distance: ev.distance, x: 0, y: 0, z: 0 });
    }
    if (code.includes('numen.work.dig')) {
      ev.atoms.push('dig');
      return ret({ ok: true, air: true, block: 'minecraft:dirt', delta: 1 });
    }
    if (code.includes('numen.work.collect')) {
      ev.atoms.push('collect');
      return ret({ ok: true, count: 1 });
    }
    if (code.includes('numen.inv.eat')) {
      ev.atoms.push('eat');
      return ret({ ok: true, hunger_before: 10, hunger_after: 12, count_before: 1, count_after: 0 });
    }
    if (code.includes('numen.task.stop')) {
      ev.settle += 1;
      ev.atoms.push('settle');
      return ret({ ok: true, x: 0, y: 0, z: 0, items: 0 });
    }
    if (code.includes('numen.scan.block(') && !code.includes('numen.scan.blocks')) {
      ev.atoms.push('scan');
      return ret({ ok: true, air: false, in_reach: true, name: 'minecraft:dirt' });
    }
    return null; // 观测等走普通路径
  },
  done(ctx) {
    const g1 = ctx.evidence.g1;
    const g2 = ctx.evidence.g2;
    return (g1?.endedAt && g2?.endedAt) || ctx.ticks >= 300;
  },
  maxTicks: 360,
  check(ctx) {
    const g1 = ctx.evidence.g1;
    const g2 = ctx.evidence.g2;
    const doneTrace = ctx.traceOf('tactic_done');
    return [
      check('move 战术包完成', g1?.status === 'done', String(g1?.status)),
      check('dig 战术包完成', g2?.status === 'done', String(g2?.status)),
      check('trace 记录 2 次 tactic_done', doneTrace.length >= 2, String(doneTrace.length)),
      check('move 用了 2 个原子', g1?.lastResult?.atoms === 2, JSON.stringify(g1?.lastResult)),
      check('dig 用了 3 个原子', g2?.lastResult?.atoms === 3, JSON.stringify(g2?.lastResult)),
      check('没有 tick_error', ctx.traceOf('tick_error').length === 0, String(ctx.traceOf('tick_error').length)),
    ];
  },
};

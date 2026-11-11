/**
 * 过期字段禁止抢占：
 * 故意把 hostileCount 候选做成超 TTL，战术包不应被 outnumbered/near_death 抢占。
 */
import { obs, check } from './_common.mjs';
import { makeGoal } from '../../src/state.mjs';

export default {
  id: 'cap_stale_no_preempt',
  title: '过期感知快照：hostileCount 超 TTL → 禁止抢占',
  cfg: { behavior: { schedule: { enabled: false }, perceptionTtlMs: 1000 } },
  observations: [obs(), obs(), obs()],
  setup(ctx) {
    ctx.evidence.tac = { distance: 10, atoms: [] };
    // 过期候选：observedAt=0，value 声称 3 个敌人
    ctx.lane.state.factCandidates = {
      hostileCount: [{ value: 3, observedAt: 0, source: 'observe', radius: 16 }],
    };
    ctx.lane.state.factMeta = {
      hostileCount: { value: 3, observedAt: 0, source: 'observe', radius: 16 },
    };
    ctx.evidence.tacticGoal = makeGoal({
      skill: 'tactic',
      params: { tactic: 'move_segment', params: { target: { x: 100, y: 64, z: -40 }, arrive: 2 } },
      priority: 40,
      priorityClass: 'P3',
      note: 'mcp',
    });
    ctx.lane.state.pushGoal(ctx.evidence.tacticGoal);
  },
  luaResult(ctx, code) {
    const ev = ctx.evidence.tac;
    if (!ev) return null;
    const ret = (obj) => ({ result: { kind: 'returned', value: JSON.stringify(obj) } });
    if (code.includes('numen.move.to')) {
      ev.atoms.push('move');
      ev.distance = Math.max(0, ev.distance - 4);
      ctx.state.hp = 3;
      ctx.state.hostileCount = 3;
      ctx.state.hostileDistance = 2;
      return ret({ ok: true, moved: 4, distance: ev.distance, x: 0, y: 0, z: 0 });
    }
    return ret({ ok: true, x: 0, y: 0, z: 0 });
  },
  results(ctx) {
    return { ok: true, at: 'stale_interrupt' };
  },
  done(ctx) {
    return !!ctx.evidence.tacticGoal?.endedAt || ctx.ticks >= 60;
  },
  maxTicks: 90,
  check(ctx) {
    const g = ctx.evidence.tacticGoal;
    return [
      check('没有发生抢占', g?.lastResult?.kind !== 'preempted', JSON.stringify(g?.lastResult)),
      check('出现 stale 拒绝抢占 trace', ctx.traceOf('priority_snapshot_stale').length >= 1,
        String(ctx.traceOf('priority_snapshot_stale').length)),
      check('没有 tick_error', ctx.traceOf('tick_error').length === 0, String(ctx.traceOf('tick_error').length)),
    ];
  },
};

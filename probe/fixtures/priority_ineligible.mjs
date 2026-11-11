/**
 * 场景：goal 在 atom 边界失去 eligible → current_ineligible，不与 preempted 混码。
 */
import { obs, check } from './_common.mjs';
import { makeGoal } from '../../src/state.mjs';

export default {
  id: 'priority_ineligible',
  title: 'current 失效在边界释放，返回 current_ineligible',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs()],
  setup(ctx) {
    ctx.evidence.allowed = true;
    ctx.evidence.ev = { distance: 10, atoms: 0 };
    ctx.evidence.goal = makeGoal({
      skill: 'tactic',
      params: { tactic: 'move_segment', params: { target: { x: 100, y: 64, z: -40 }, arrive: 2 } },
      priority: 50,
      priorityClass: 'P3',
      eligible: () => ctx.evidence.allowed,
      note: 'mcp',
    });
    ctx.lane.state.pushGoal(ctx.evidence.goal);
  },
  luaResult(ctx, code) {
    const ev = ctx.evidence.ev;
    if (code.includes('numen.move.to')) {
      ev.atoms += 1;
      ev.distance = Math.max(0, ev.distance - 4);
      if (ev.atoms === 1) ctx.evidence.allowed = false;
      return { result: { kind: 'returned', value: JSON.stringify({ ok: true, moved: 4, distance: ev.distance, x: 0, y: 0, z: 0 }) } };
    }
    return null;
  },
  done(ctx) {
    return !!ctx.evidence.goal?.endedAt;
  },
  maxTicks: 60,
  check(ctx) {
    const g = ctx.evidence.goal;
    return [
      check('goal 以 current_ineligible 结束', g?.status === 'failed' && g?.lastResult?.kind === 'current_ineligible', JSON.stringify(g?.lastResult)),
      check('未混成 preempted', g?.lastResult?.kind !== 'preempted'),
      check('独立计数 ineligible', ctx.lane.state.priorityStats?.ineligible === 1, JSON.stringify(ctx.lane.state.priorityStats)),
    ];
  },
};

/**
 * 场景：P0/death-risk goal 遇到低后果中断 → keep current，goal 正常完成。
 */
import { obs, check } from './_common.mjs';
import { makeGoal } from '../../src/state.mjs';

export default {
  id: 'priority_keep',
  title: '死亡风险 goal 不被低后果中断抢占',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs()],
  setup(ctx) {
    ctx.evidence.goal = makeGoal({
      skill: 'tactic',
      params: { tactic: 'move_segment', params: { target: { x: 100, y: 64, z: -40 }, arrive: 2 } },
      priority: 90,
      priorityClass: 'P0',
      consequence: 'death_risk',
      note: 'mcp',
    });
    ctx.lane.state.pushGoal(ctx.evidence.goal);
    ctx.evidence.ev = { distance: 10, atoms: 0 };
  },
  luaResult(ctx, code) {
    const ev = ctx.evidence.ev;
    if (code.includes('numen.move.to')) {
      ev.atoms += 1;
      ev.distance = Math.max(0, ev.distance - 4);
      if (ev.atoms === 1) {
        ctx.state.hp = 20;
        ctx.state.ownerDangerAt = Date.now();
        ctx.state.ownerDistance = 4;
        ctx.state.hostileCount = 1;
        ctx.state.weapon = false;
      }
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
    const decisions = ctx.traceOf('priority_decision').map((e) => {
      try { return JSON.parse(e.note); } catch { return null; }
    }).filter(Boolean);
    return [
      check('goal 完成', g?.status === 'done', JSON.stringify(g?.lastResult)),
      check('trace 记录 lower_consequence', decisions.some((d) => d.code === 'lower_consequence'), JSON.stringify(decisions)),
      check('没有 tactic_failed(preempted)', ctx.traceOf('tactic_failed').length === 0, String(ctx.traceOf('tactic_failed').length)),
    ];
  },
};

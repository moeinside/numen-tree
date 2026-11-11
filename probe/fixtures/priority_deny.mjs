/**
 * 场景：P1/irreversible goal 被同后果中断抢占 → 必须拒绝，goal 继续跑完。
 */
import { obs, check } from './_common.mjs';
import { makeGoal } from '../../src/state.mjs';

export default {
  id: 'priority_deny',
  title: '不可逆 goal 拒绝同后果中断抢占并继续完成',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs()],
  setup(ctx) {
    ctx.evidence.goal = makeGoal({
      skill: 'tactic',
      params: { tactic: 'move_segment', params: { target: { x: 100, y: 64, z: -40 }, arrive: 2 } },
      priority: 75,
      priorityClass: 'P1',
      reversal: 'irreversible',
      note: 'mcp',
    });
    ctx.lane.state.pushGoal(ctx.evidence.goal);
    ctx.evidence.ev = { distance: 10, atoms: 0 };
    // 同后果、优先级更高：用来证明“不可逆拒绝”而不是“优先级不够”。
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
        ctx.state.weapon = true;
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
      check('goal 继续完成，不被抢占', g?.status === 'done', JSON.stringify(g?.lastResult)),
      check('trace 记录 irreversible_commitment', decisions.some((d) => d.code === 'irreversible_commitment'), JSON.stringify(decisions)),
      check('没有 tactic_failed(preempted)', ctx.traceOf('tactic_failed').length === 0, String(ctx.traceOf('tactic_failed').length)),
    ];
  },
};

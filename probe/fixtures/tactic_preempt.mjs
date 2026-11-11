/**
 * 场景：战术包执行中被安全中断抢占 → settle → 下一 tick 走中断。
 * 验证 docs/19 §8 A2/B1：
 *  - 原子边界检测到更高优先级中断 → runner 返回 preempted；
 *  - lane 自动跑一次 settle（task_stop）；
 *  - 下一 tick 正常执行中断动作（不静默丢掉危险）。
 */
import { obs, check } from './_common.mjs';
import { makeGoal } from '../../src/state.mjs';

export default {
  id: 'tactic_preempt',
  title: '战术包被安全中断抢占 → settle（不静默丢危险）',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs(), obs()],
  setup(ctx) {
    ctx.evidence.tac = { distance: 10, settle: 0, atoms: [] };
    ctx.evidence.tacticGoal = makeGoal({
      skill: 'tactic',
      params: { tactic: 'move_segment', params: { target: { x: 100, y: 64, z: -40 }, arrive: 2 } },
      priority: 40, // P3 级：低于 near_death(95)
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
      // 第一个原子跑完后把世界变危险：下一个原子边界应被 near_death 抢占
      if (ev.atoms.length === 1) {
        ctx.state.hp = 3;
        ctx.state.hostileCount = 1;
        ctx.state.hostileDistance = 2;
      }
      return ret({ ok: true, moved: 4, distance: ev.distance, x: 0, y: 0, z: 0 });
    }
    if (code.includes('numen.task.stop')) {
      ev.settle += 1;
      ev.atoms.push('settle');
      return ret({ ok: true, x: 0, y: 0, z: 0, items: 0 });
    }
    return null;
  },
  results(ctx, skill) {
    // 中断动作（retreat/fight_safe/go_to 等）一律成功，避免影响断言
    return { ok: true, at: 'tactic_preempt_interrupt' };
  },
  done(ctx) {
    const g = ctx.evidence.tacticGoal;
    const interrupted = ctx.traceOf('interrupt').length > 0;
    return (g?.endedAt && interrupted) || ctx.ticks >= 120;
  },
  maxTicks: 160,
  check(ctx) {
    const g = ctx.evidence.tacticGoal;
    const ev = ctx.evidence.tac;
    return [
      check('战术包以 preempted 结束', g?.status === 'failed' && g?.lastResult?.kind === 'preempted', JSON.stringify(g?.lastResult)),
      check('抢占发生在第二个原子之前（已跑 1 个）', g?.lastResult?.atoms === 2, String(g?.lastResult?.atoms)),
      check('自动跑了 settle（1 次）', ev.settle === 1, String(ev.settle)),
      check('trace 记录 tactic_failed', ctx.traceOf('tactic_failed').length >= 1, String(ctx.traceOf('tactic_failed').length)),
      check('下一 tick 确实走了中断', ctx.traceOf('interrupt').length >= 1, String(ctx.traceOf('interrupt').length)),
      check('没有 tick_error', ctx.traceOf('tick_error').length === 0, String(ctx.traceOf('tick_error').length)),
    ];
  },
};

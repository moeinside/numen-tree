/**
 * Dispatch watchdog：plan active、无 atom begin / steps 进展 → stall + suspend。
 */
import { obs, check } from './_common.mjs';

export default {
  id: 'cap_dispatch_stall',
  title: 'Dispatch watchdog：plan active 但无进展 → stalled',
  cfg: { behavior: { schedule: { enabled: false }, progressWatchdogSeconds: 0.01 } },
  observations: [obs()],
  setup(ctx) {
    const r = ctx.lane.startPlan({ intent: 'craft_tools', source: 'auto' });
    ctx.evidence.ok = r.ok;
    ctx.evidence.plan = r.plan ?? null;
    const plan = r.plan;
    if (plan) {
      const d = ctx.lane.dispatchWatchdog;
      d.planId = plan.id;
      d.cursor = plan.cursor ?? null;
      d.stepsDone = 0;
      d.lastProgressAt = 0;
      d.lastAtomAt = 0;
      d.stalledAt = 0;
    }
  },
  done(ctx) {
    return ctx.ticks >= 3 || ctx.lane.state.plan?.status === 'suspended';
  },
  maxTicks: 10,
  check(ctx) {
    const current = ctx.lane.state.plan;
    return [
      check('plan 已启动', !!ctx.evidence.plan && ctx.evidence.ok !== false, String(ctx.evidence.ok)),
      check('plan 被 watchdog 挂起', current?.status === 'suspended', String(current?.status)),
      check('trace 记录 dispatch stalled', ctx.traceOf('plan_dispatch_stalled').length >= 1,
        String(ctx.traceOf('plan_dispatch_stalled').length)),
    ];
  },
};

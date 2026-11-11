/**
 * DispatchGate 僵尸态：plan active+steps0 持续 >2s，且 actionLock 属于别的 goal。
 * 期望：gateReason=active_steps0、gateMode=stalled、trace plan_stalled_active_zero_steps。
 */
import { obs, check } from './_common.mjs';

export default {
  id: 'cap_gate_stalled',
  title: 'DispatchGate：active+steps0 超 2s → stalled + gateReason',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs()],
  setup(ctx) {
    const r = ctx.lane.startPlan({ intent: 'craft_tools', source: 'llm' });
    ctx.evidence.plan = r.plan ?? null;
    ctx.evidence.ok = r.ok;
    // 模拟另一个 goal/策略占着动作锁
    ctx.lane.state.actionLock = true;
    ctx.lane.state.current = { goalId: 'other-goal', skill: 'safety_hold', startedAt: new Date().toISOString() };
    // 让 gate 看到已经持续超过 2s
    ctx.lane.state.gateZombiePlanId = ctx.evidence.plan?.id ?? null;
    ctx.lane.state.gateZombieSince = Date.now() - 3000;
  },
  done(ctx) {
    return ctx.ticks >= 5 || ctx.evidence.plan?.status === 'suspended';
  },
  maxTicks: 20,
  check(ctx) {
    const p = ctx.evidence.plan;
    const current = ctx.lane.state.plan;
    return [
      check('plan 已启动', !!p && ctx.evidence.ok !== false, String(ctx.evidence.ok)),
      check('plan 被标 stalled', current?.gateMode === 'stalled' && current?.gateReason === 'active_steps0',
        `gate=${current?.gateMode}/${current?.gateReason} status=${current?.status}`),
      check('plan 已 suspended', current?.status === 'suspended', String(current?.status)),
      check('trace 记录零进度僵尸', ctx.traceOf('plan_stalled_active_zero_steps').length >= 1,
        String(ctx.traceOf('plan_stalled_active_zero_steps').length)),
    ];
  },
};

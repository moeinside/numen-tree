/**
 * P0-a：计划步骤反复 slot_blocked。
 * 期望：blocked 计入、resume 有观测门、同意图重试≤2、最终停止空转。
 */
import { obs, ok, fail, check } from './_common.mjs';

export default {
  id: 'slot_resume',
  title: 'slot_blocked：blocked 计入 + 恢复观测门 + 重试上限',
  cfg: {
    behavior: {
      schedule: { enabled: false },
      execPolicy: { gateLongSkills: false },
    },
    loop: { observeSlowMs: 1, observeFastMs: 1, tickMs: 8 },
  },
  observations: Array.from({ length: 80 }, () => obs({ food: 4, hunger: 18 })),
  setup(ctx) {
    ctx.lane.startPlan({ intent: 'gather_wood', source: 'llm' });
  },
  observeError(ctx) {
    if ((ctx.evidence.observeErrors || 0) < 2) {
      ctx.evidence.observeErrors = (ctx.evidence.observeErrors || 0) + 1;
      return { kind: 'failed', message: 'slot busy (fixture)' };
    }
    return undefined;
  },
  results(ctx, skill) {
    if (skill === 'mine_nearby') return fail('slot_blocked', 'fixture: slot blocked on action');
    return ok();
  },
  onTick(ctx) {
    const p = ctx.state.planHistory?.[0];
    if (p) {
      // 把 2s 稳定窗回拨一次，快速回归“重试上限”，不真等
      if (p.status === 'suspended' && p.suspendedAt && p._warpedSuspendedAt !== p.suspendedAt) {
        p._warpedSuspendedAt = p.suspendedAt;
        p.suspendedAt = new Date(Date.now() - 5000).toISOString();
      }
      ctx.evidence.maxSuspend = Math.max(ctx.evidence.maxSuspend || 0, Number(p.slotSuspendCount || 0));
      ctx.evidence.resumeCount = Math.max(ctx.evidence.resumeCount || 0, Number(p.resumeCount || 0));
    }
    ctx.evidence.maxBlocked = Math.max(ctx.evidence.maxBlocked || 0, Number(ctx.state.slotBlocked || 0));
  },
  done(ctx) {
    const p = ctx.state.planHistory?.[0];
    return !!p && p.status === 'failed';
  },
  maxTicks: 1200,
  check(ctx) {
    const p = ctx.plan();
    const exhausted = ctx.traceOf('plan_slot_retry_exhausted');
    return [
      check('slot_blocked 计入 state.slotBlocked', ctx.evidence.maxBlocked >= 1, `maxBlocked=${ctx.evidence.maxBlocked}`),
      check('计划记录 slotSuspendCount', (p?.slotSuspendCount || 0) >= 3, `slotSuspendCount=${p?.slotSuspendCount}; suspended=${ctx.traceOf('plan_suspended').length}; resumes=${ctx.traceOf('plan_resume').length}; cursor=${p?.cursor}; status=${p?.status}; suspendedBy=${p?.suspendedBy}; execMode=${ctx.state.execMode}; gate=${ctx.lane.execPolicy?.gateLongSkills}; observeCount=${ctx.observeCount}; observeErrors=${ctx.evidence.observeErrors}; lastObs=${ctx.state.lastSuccessfulObserveAt}; suspendedAt=${p?.suspendedAt}; slotBlocked=${ctx.state.slotBlocked}`),
      check('恢复次数有上限（不是无限 resume）', (p?.resumeCount || 0) <= 2, `resumeCount=${p?.resumeCount}`),
      check('触发 retry exhausted 并停止', exhausted.length === 1, `exhausted=${exhausted.length}`),
      check('计划最终 failed', p?.status === 'failed', `status=${p?.status}`),
    ];
  },
};

/**
 * 派发 watchdog（纯逻辑）：plan 已 active，但长期没有 atom begin / steps 进展。
 * 只回答“是否无进展”，不执行动作。
 */
export function createDispatchWatchdog() {
  return {
    planId: null,
    cursor: null,
    stepsDone: -1,
    lastProgressAt: 0,
    lastAtomAt: 0,
    stalledAt: 0,
  };
}

export function observePlan(state, plan, now = Date.now()) {
  if (!plan) {
    state.planId = null;
    state.cursor = null;
    state.stepsDone = -1;
    return state;
  }
  const stepsDone = Number(plan.steps_done ?? (plan.stepResults?.length ?? 0));
  if (state.planId !== plan.id || state.cursor !== plan.cursor || state.stepsDone !== stepsDone) {
    state.planId = plan.id;
    state.cursor = plan.cursor ?? null;
    state.stepsDone = stepsDone;
    state.lastProgressAt = now;
    state.lastAtomAt = now;
    state.stalledAt = 0;
  }
  return state;
}

export function noteAtomBegin(state, now = Date.now()) {
  state.lastAtomAt = now;
  return state;
}

/**
 * @returns {{stalled:boolean, reason?:string, idleMs?:number}}
 */
export function checkDispatchWatchdog(state, plan, now = Date.now(), timeoutMs = 20_000) {
  if (!plan || plan.status !== 'active') return { stalled: false };
  if (state.planId !== plan.id) observePlan(state, plan, now);
  const lastProgressAt = Number(state.lastProgressAt || 0);
  const lastAtomAt = Number(state.lastAtomAt || 0);
  const idleMs = now - Math.max(lastProgressAt, lastAtomAt);
  if (idleMs < timeoutMs) return { stalled: false, idleMs };
  state.stalledAt = now;
  return {
    stalled: true,
    idleMs,
    reason: `plan ${plan.id} active ${Math.round(idleMs / 1000)}s，无 atom begin / steps 进展`,
  };
}

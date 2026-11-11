/**
 * P0-0b：真实 atom 边界上的抢占判定 + 当前承诺记录。
 * 无副作用，由 lane 在 atom 开始前调用。
 */
import { CONSEQUENCE, REVERSAL, canPreempt, priorityEvent, isConsequence, isReversal } from './priority.mjs';
import { consequenceForPriorityClass, declarationForInterrupt } from './priority-declarations.mjs';

/**
 * @param {object} input
 * @param {object} input.goal 当前 goal（id/consequence/reversal）
 * @param {number} input.goalPriority 兼容数字
 * @param {string|null} input.priorityClass P0~P4
 * @param {object} input.hit pickInterrupt 命中项
 * @param {number} [input.now]
 * @returns {{preempt:boolean, decision:object, event:object|null, current:object, legacy:boolean}}
 */
export function decidePreemption({ goal, goalPriority, priorityClass = null, hit, now = Date.now() }) {
  const declaredCurrent = isConsequence(goal?.consequence)
    ? goal.consequence
    : consequenceForPriorityClass(priorityClass);
  const current = {
    id: `goal:${goal?.id ?? 'unknown'}`,
    consequence: declaredCurrent ?? CONSEQUENCE.UNDECLARED,
    reversal: isReversal(goal?.reversal) ? goal.reversal : REVERSAL.RESUMABLE,
    priority: Number(goalPriority ?? 0),
  };
  const incomingDecl = declarationForInterrupt(hit?.entry);
  const incoming = {
    id: `interrupt:${incomingDecl.id || 'unknown'}`,
    consequence: incomingDecl.consequence ?? CONSEQUENCE.UNDECLARED,
    reversal: incomingDecl.reversal,
    priority: Number(hit?.entry?.priority ?? 0),
  };
  const verdict = canPreempt(current, incoming, { atAtomBoundary: true });
  const legacy = declaredCurrent === null || !incomingDecl.declared;
  if (legacy) {
    const decision = {
      at: now,
      code: 'legacy_undeclared',
      reason: '缺少显式 consequence 声明，fail-closed：不抢占',
      from: current.id,
      to: incoming.id,
      incomingConsequence: incoming.consequence ?? null,
      incomingReversal: incoming.reversal,
      atAtomBoundary: true,
      currentDeclared: declaredCurrent !== null,
      incomingDeclared: incomingDecl.declared,
    };
    return { preempt: false, decision, event: priorityEvent({ decision }), current, incoming, legacy: true };
  }
  const decision = {
    at: now,
    code: verdict.code,
    reason: verdict.reason,
    from: current.id,
    to: incoming.id,
    incomingConsequence: incoming.consequence,
    incomingReversal: incoming.reversal,
    atAtomBoundary: true,
    currentDeclared: declaredCurrent !== null,
    incomingDeclared: incomingDecl.declared,
  };
  return {
    preempt: verdict.allowed,
    decision,
    event: priorityEvent({ decision }),
    current,
    incoming,
    legacy,
  };
}

/** 进程内 current 生命周期：begin → preempted → settle。 */
function archiveCurrent(state, status, extra = {}) {
  const current = state?.priority?.current;
  if (!current) return null;
  state.priority.settled ??= [];
  const archived = { ...current, finalStatus: status, ...extra, archivedAt: Date.now() };
  state.priority.settled.push(archived);
  state.priority.current = null;
  return archived;
}

export function beginCommitment(state, current, now = Date.now()) {
  state.priorityStats ??= { preempted: 0, legacy: 0, completed: 0, interrupted: 0, ineligible: 0, decisions: 0, reasoned: 0, sameAtomFailures: 0 };
  state.priority ??= { current: null, interruptions: [], settled: [] };
  state.priority.interruptions ??= [];
  state.priority.settled ??= [];
  // 旧 current 不能被静默覆盖：先记成 interrupted/lost。
  if (state.priority.current) {
    const old = state.priority.current;
    archiveCurrent(state, old.status === 'preempted' ? 'interrupted' : 'lost', { reason: 'superseded_by_new_commitment' });
  }
  state.priority.current = { ...current, status: 'active', since: now };
  return state.priority.current;
}

export function markPreempted(state, result) {
  if (!state?.priority) return null;
  const current = state.priority.current;
  if (!current) return null;
  current.status = 'preempted';
  current.interruptedBy = result?.decision?.to ?? null;
  current.interruptCode = result?.decision?.code ?? null;
  current.interruptedAt = result?.decision?.at ?? Date.now();
  return current;
}

export function settleCommitment(state, { ok = null, status = 'settled' } = {}) {
  if (!state?.priority) return null;
  const current = state.priority.current;
  if (!current) return null;
  const pendingMs = current.interruptedAt ? Math.max(0, Date.now() - current.interruptedAt) : null;
  const finalStatus = ok === true ? 'completed' : status;
  state.priorityStats ??= { preempted: 0, legacy: 0, completed: 0, interrupted: 0, ineligible: 0, decisions: 0, reasoned: 0, sameAtomFailures: 0 };
  if (finalStatus === 'completed') state.priorityStats.completed += 1;
  else state.priorityStats.interrupted += 1;
  const archived = archiveCurrent(state, finalStatus, { pendingMs });
  return archived;
}

/** 在当前 tick 记录被打断的承诺；不做持久化，持久化在 Phase C。 */
export function recordInterruption(state, result) {
  if (!state || !result) return null;
  state.priorityStats ??= { preempted: 0, legacy: 0, completed: 0, interrupted: 0, ineligible: 0, decisions: 0, reasoned: 0, sameAtomFailures: 0 };
  state.priority ??= { current: null, interruptions: [], settled: [] };
  state.priority.interruptions ??= [];
  state.priority.settled ??= [];
  if (!state.priority.current) {
    state.priority.current = { ...result.current, status: 'active', since: result.decision?.at ?? Date.now() };
  }
  state.priorityStats.decisions += 1;
  if (result.decision?.reason) state.priorityStats.reasoned += 1;
  if (result.legacy) state.priorityStats.legacy += 1;
  if (result.preempt) {
    state.priorityStats.preempted += 1;
    const key = `${result.decision?.from ?? ''}:${result.atomId ?? ''}`;
    if (state.priorityStats.lastPreemptKey === key) state.priorityStats.sameAtomFailures += 1;
    state.priorityStats.lastPreemptKey = key;
    markPreempted(state, result);
    const entry = {
      at: result.decision.at,
      from: result.decision.from,
      to: result.decision.to,
      code: result.decision.code,
      reason: result.decision.reason,
      incomingConsequence: result.incoming?.consequence ?? null,
      legacy: result.legacy,
    };
    state.priority.interruptions.push(entry);
    state.priority.lastInterruption = entry;
  }
  state.priority.lastDecision = result.decision;
  return result.decision;
}

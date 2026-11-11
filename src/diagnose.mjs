/**
 * Read-only plan/world diagnosis.
 *
 * This module never writes state and never dispatches actions. It answers one
 * question: is the plan actually progressing against the world?
 */

export const VERDICTS = Object.freeze([
  'progressing',
  'waiting',
  'stalled',
  'contradiction',
  'unknown',
]);

export const DEFAULT_STALL_MS = 20_000;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function hasWorldDelta(progress = {}) {
  if (Array.isArray(progress.blocksChanged) && progress.blocksChanged.length > 0) return true;
  if (progress.inventoryChanged === true) return true;
  return num(progress.worldDelta) > 0;
}

function hasStepsDelta(progress = {}) {
  return num(progress.stepsDelta) > 0 || progress.predicateAdvanced === true;
}

/**
 * @param {object} input
 * @param {number} [input.now]
 * @param {object|null} [input.plan]
 * @param {object|null} [input.current]
 * @param {object|null} [input.actionLock]
 * @param {object|null} [input.wait] { active, reason, recoverable, until }
 * @param {object} [input.progress] { stepsDelta, worldDelta, blocksChanged, inventoryChanged, predicateAdvanced, lastProgressAt }
 * @param {boolean} [input.contradiction]
 * @param {number} [input.stallMs]
 */
export function mergeDiagnosis(primary, secondary) {
  const a = primary || { verdict: 'unknown', reason: 'no primary' };
  const b = secondary || { verdict: 'unknown', reason: 'no secondary' };
  const rank = { contradiction: 5, stalled: 4, waiting: 3, progressing: 2, unknown: 1 };
  // Explicit wait beats a world-only stall: the plan may be legitimately parked.
  if (b.verdict === 'waiting' && b.evidence?.wait?.reason && a.verdict === 'stalled') return b;
  if (a.verdict === 'unknown') return b;
  if (b.verdict === 'contradiction') return b;
  if (a.verdict === 'waiting' && a.evidence?.wait?.reason) return a;
  return (rank[a.verdict] ?? 0) >= (rank[b.verdict] ?? 0) ? a : b;
}

export function diagnose(input = {}) {
  const now = num(input.now, Date.now());
  const plan = input.plan || null;
  const current = input.current || null;
  const lock = input.actionLock || null;
  const wait = input.wait || null;
  const progress = input.progress || {};
  const worldDeltaScope = input.worldDeltaScope || 'local';
  const worldDeltaOutOfScope = input.worldDeltaOutOfScope === true;
  const waitValid = Boolean(
    wait?.active === true &&
    wait.reason &&
    (wait.until != null || wait.blockedBy != null),
  );
  const stallMs = num(input.stallMs, DEFAULT_STALL_MS);
  const lastProgressAt = num(progress.lastProgressAt, plan?.startedAt ?? now);
  const elapsed = Math.max(0, now - lastProgressAt);
  const evidence = {
    planId: plan?.id ?? null,
    planStatus: plan?.status ?? null,
    cursor: plan?.cursor ?? null,
    goalId: current?.goalId ?? current?.id ?? null,
    currentMissing: input.currentMissing === true,
    actionLock: lock ? { owner: lock.owner ?? null, since: lock.since ?? null } : null,
    elapsedMs: elapsed,
    lastProgressAt,
    worldDeltaScope,
    worldDeltaOutOfScope,
    worldDelta: num(progress.worldDelta),
    stepsDelta: num(progress.stepsDelta),
    blocksChanged: progress.blocksChanged?.length ?? 0,
    inventoryChanged: progress.inventoryChanged === true,
    wait: wait ? {
      reason: wait.reason ?? null,
      recoverable: wait.recoverable ?? null,
      until: wait.until ?? null,
      blockedBy: wait.blockedBy ?? null,
    } : null,
  };

  const active = plan && String(plan.status) === 'active';
  const autoContradiction = active && !wait && !lock
    && input.currentMissing === true && elapsed >= 2000;
  if (input.contradiction === true || autoContradiction) {
    return {
      verdict: 'contradiction',
      reason: input.contradictionReason
        || (autoContradiction
          ? 'plan is active but no current action/lock/wait for >=2s'
          : 'plan/current/world evidence contradicts itself'),
      evidence,
      suggested: 'suspend_and_replan',
    };
  }

  if (wait?.active === true && !waitValid) {
    return {
      verdict: 'unknown',
      reason: 'wait is missing reason or until/blockedBy',
      evidence,
      suggested: 'collect_more',
    };
  }

  if (wait?.active === true && waitValid) {
    return {
      verdict: 'waiting',
      reason: `waiting: ${wait.reason}`,
      evidence,
      suggested: 'continue_waiting',
    };
  }

  if (hasStepsDelta(progress) || (!worldDeltaOutOfScope && hasWorldDelta(progress))) {
    return {
      verdict: 'progressing',
      reason: 'steps or world changed',
      evidence,
      suggested: 'continue',
    };
  }

  if (worldDeltaOutOfScope) {
    return {
      verdict: 'unknown',
      reason: 'world change is outside the declared snapshot scope',
      evidence,
      suggested: 'collect_more',
    };
  }

  if (lock) {
    return {
      verdict: 'waiting',
      reason: `blocked by action lock: ${lock.owner ?? 'unknown'}`,
      evidence,
      suggested: 'continue_waiting',
    };
  }

  if (active && elapsed >= stallMs) {
    return {
      verdict: 'stalled',
      reason: `plan active for ${Math.round(elapsed / 1000)}s with no step/world progress`,
      evidence,
      suggested: 'suspend_and_replan',
    };
  }

  return {
    verdict: 'unknown',
    reason: 'insufficient evidence for a safe verdict',
    evidence,
    suggested: 'collect_more',
  };
}

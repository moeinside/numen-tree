/**
 * P0-0a：动作事务。
 *
 * begin → settle → postcheck → commit / failed / unknown。
 * 反射可打断，但事务作废、结果 unknown，不携带 success；不锁槽。
 */
export const TX_STATUS = Object.freeze({
  BEGUN: 'begun',
  SETTLED: 'settled',
  COMMITTED: 'committed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  INTERRUPTED: 'interrupted',
});

export const SIDE_EFFECT_CLASS = Object.freeze({
  move: 'replayable',
  collect: 'replayable',
  open_container: 'replayable',
  place: 'rebuildable',
  consume: 'non_replayable',
  store: 'non_replayable',
});

let SEQ = 0;
export function nextTxId() {
  SEQ += 1;
  return `tx${Date.now().toString(36)}-${SEQ}`;
}

export function beginTx({
  action,
  expected = [],
  sideEffect = 'replayable',
  attempt = 1,
  generation = 1,
  consequence = 'reversible_need',
  reversal = 'resumable',
  goalId = null,
  atomId = null,
  parentTxId = null,
} = {}) {
  return {
    id: nextTxId(),
    action: String(action ?? 'unknown'),
    expected: Array.isArray(expected) ? expected : [],
    sideEffect: SIDE_EFFECT_CLASS[sideEffect] ?? sideEffect ?? 'replayable',
    consequence: String(consequence ?? 'reversible_need'),
    reversal: String(reversal ?? 'resumable'),
    goalId: goalId == null ? null : String(goalId),
    atomId: atomId == null ? null : String(atomId),
    parentTxId: parentTxId == null ? null : String(parentTxId),
    attempt: Number(attempt) || 1,
    generation: Number(generation) || 1,
    status: TX_STATUS.BEGUN,
    observations: 0,
    result: null,
    reason: null,
    startedAt: Date.now(),
  };
}

export function settleTx(tx, result = {}) {
  if (!tx || tx.status !== TX_STATUS.BEGUN) return tx;
  tx.status = TX_STATUS.SETTLED;
  tx.settledAt = Date.now();
  tx.actionOk = result.ok !== false;
  tx.actionKind = result.kind ?? null;
  tx.actionMessage = result.message ?? null;
  return tx;
}

/** 反射/外部打断：结果只能 unknown，不得携带 success。 */
export function interruptTx(tx, reason = 'interrupted', { by = null, incomingConsequence = null } = {}) {
  if (!tx) return tx;
  tx.status = TX_STATUS.UNKNOWN;
  tx.reason = String(reason);
  tx.actionOk = null; // 不保留 success
  tx.interruptedAt = Date.now();
  tx.interruptedBy = by == null ? null : String(by);
  tx.incomingConsequence = incomingConsequence == null ? null : String(incomingConsequence);
  tx.recovery = tx.reversal === 'irreversible' ? 'needs_settle' : 'reconcile';
  return tx;
}

/** postcheck：passed=false → failed；无证据/超时 → unknown；未知重观测最多 2 次。 */
export function postcheckTx(tx, { passed, evidence = null, uncertain = false } = {}) {
  if (!tx) return tx;
  if (tx.status === TX_STATUS.UNKNOWN) return tx;
  if (tx.status !== TX_STATUS.SETTLED) return tx;
  if (uncertain) {
    tx.observations = Number(tx.observations || 0) + 1;
    tx.status = TX_STATUS.UNKNOWN;
    tx.reason = 'postcheck_uncertain';
    tx.evidence = evidence;
    if (tx.observations >= 2) tx.reason = 'info_missing';
    return tx;
  }
  if (passed === true) {
    tx.status = TX_STATUS.COMMITTED;
    tx.committedAt = Date.now();
    tx.evidence = evidence;
    return tx;
  }
  tx.status = TX_STATUS.FAILED;
  tx.reason = 'postcheck_failed';
  tx.evidence = evidence;
  return tx;
}

/** 再次 postcheck（unknown 生命周期内最多 2 次）。 */
export function repostcheckTx(tx, { passed, evidence = null, uncertain = false } = {}) {
  if (!tx || tx.status !== TX_STATUS.UNKNOWN) return tx;
  tx.observations = Number(tx.observations || 0) + 1;
  if (uncertain) {
    if (tx.observations >= 2) tx.reason = 'info_missing';
    return tx;
  }
  if (passed === true) {
    tx.status = TX_STATUS.COMMITTED;
    tx.evidence = evidence;
    tx.committedAt = Date.now();
    return tx;
  }
  // 第二次观测明确为假：可以判失败，不再挂 unknown
  tx.status = TX_STATUS.FAILED;
  tx.reason = 'postcheck_failed';
  tx.evidence = evidence;
  return tx;
}

export function txOutcome(tx) {
  if (!tx) return { ok: false, kind: 'unknown', reason: 'no_tx' };
  if (tx.status === TX_STATUS.COMMITTED) return { ok: true, kind: 'committed', tx };
  if (tx.status === TX_STATUS.FAILED) return { ok: false, kind: 'postcheck_failed', tx };
  if (tx.status === TX_STATUS.UNKNOWN) {
    return { ok: false, kind: tx.reason === 'info_missing' ? 'info_missing' : 'unknown', tx };
  }
  return { ok: false, kind: 'unknown', tx };
}

/** unknown 事务不允许自动重做；副作用不可重放的尤其禁止。 */
export function canAutoReenter(tx) {
  if (!tx) return false;
  if (tx.status !== TX_STATUS.UNKNOWN) return false;
  if (tx.sideEffect === 'non_replayable') return false;
  return false; // P0-0a：unknown 一律不自动重入；只允许人工/上层重规划
}

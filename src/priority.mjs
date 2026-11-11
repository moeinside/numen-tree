/**
 * P0-0b：具身优先度契约（Phase A）。
 *
 * 只做决策排序，不执行游戏动作、不改现有 lane/arbiter 行为。
 *
 * 排序：
 *   死亡风险 > 不可逆损失 > 可逆需求
 *
 * 抢占：
 *   - 只允许在幂等原子边界；
 *   - 不可逆段在原子内不被任何候选抢占；
 *   - 同后果层按 priority 比较，低优先不抢高优先；
 *   - 每次决策返回可追溯 reason/code。
 */

export const CONSEQUENCE = Object.freeze({
  DEATH_RISK: 'death_risk',
  IRREVERSIBLE_LOSS: 'irreversible_loss',
  REVERSIBLE_NEED: 'reversible_need',
  UNDECLARED: 'undeclared',
});

export const REVERSAL = Object.freeze({
  IRREVERSIBLE: 'irreversible',
  COMPENSABLE: 'compensable',
  RESUMABLE: 'resumable',
});

const CONSEQUENCE_RANK = Object.freeze({
  [CONSEQUENCE.DEATH_RISK]: 3,
  [CONSEQUENCE.IRREVERSIBLE_LOSS]: 2,
  [CONSEQUENCE.REVERSIBLE_NEED]: 1,
  [CONSEQUENCE.UNDECLARED]: 0,
});

const REVERSAL_VALUES = new Set(Object.values(REVERSAL));
const CONSEQUENCE_VALUES = new Set(Object.values(CONSEQUENCE));

export function isConsequence(value) {
  return CONSEQUENCE_VALUES.has(value);
}

export function isReversal(value) {
  return REVERSAL_VALUES.has(value);
}

export function consequenceRank(value) {
  return CONSEQUENCE_RANK[value] ?? 0;
}

/**
 * 现有中断/目标用数字 priority（0~100）。
 * Phase B 的兼容映射；后续动作声明应直接给 consequence，不再依赖这个阈值。
 */
export function consequenceFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return CONSEQUENCE.REVERSIBLE_NEED;
  if (n >= 90) return CONSEQUENCE.DEATH_RISK;
  if (n >= 70) return CONSEQUENCE.IRREVERSIBLE_LOSS;
  return CONSEQUENCE.REVERSIBLE_NEED;
}

/** 候选至少要能给出 eligible/priority/reversal；consequence 缺失时标记为无效，不静默降级。 */
export function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const consequenceDeclared = isConsequence(candidate.consequence);
  const consequence = consequenceDeclared ? candidate.consequence : null;
  const reversal = isReversal(candidate.reversal) ? candidate.reversal : REVERSAL.RESUMABLE;
  const priority = Number.isFinite(Number(candidate.priority)) ? Number(candidate.priority) : 0;
  return {
    ...candidate,
    consequence,
    consequenceDeclared,
    reversal,
    priority,
    eligible: typeof candidate.eligible === 'function' ? candidate.eligible : () => true,
  };
}

function eligible(candidate, ctx) {
  try {
    return !!candidate.eligible(ctx);
  } catch {
    return false;
  }
}

function compareCandidates(a, b) {
  const byConsequence = consequenceRank(b.consequence) - consequenceRank(a.consequence);
  if (byConsequence !== 0) return byConsequence;
  const byPriority = b.priority - a.priority;
  if (byPriority !== 0) return byPriority;
  return String(a.id).localeCompare(String(b.id));
}

export function createPriorityState(now = Date.now()) {
  return {
    currentId: null,
    current: null,
    currentSince: now,
    lastDecision: null,
    decisions: 0,
    preemptions: 0,
    denials: 0,
    invalidConsequences: 0,
    invalidConsequenceKeys: new Set(),
  };
}

/**
 * 判断 incoming 是否可抢占 current。
 * @returns {{allowed:boolean, code:string, reason:string}}
 */
export function canPreempt(current, incoming, { atAtomBoundary = false } = {}) {
  if (!current) return { allowed: true, code: 'no_current', reason: '没有在途承诺' };
  if (!atAtomBoundary) {
    return { allowed: false, code: 'atomic_boundary_required', reason: '不在幂等原子边界，禁止抢占' };
  }
  if (current.consequence === CONSEQUENCE.UNDECLARED || incoming.consequence === CONSEQUENCE.UNDECLARED) {
    return { allowed: false, code: 'undeclared_consequence', reason: '缺少显式 consequence，禁止抢占' };
  }
  const currentRank = consequenceRank(current.consequence);
  const incomingRank = consequenceRank(incoming.consequence);
  if (incomingRank < currentRank) {
    return { allowed: false, code: 'lower_consequence', reason: '后果等级低于在途承诺' };
  }
  if (incomingRank === currentRank && incoming.priority <= current.priority) {
    return { allowed: false, code: 'not_higher_priority', reason: '同后果层未高于在途优先度' };
  }
  if (current.reversal === REVERSAL.IRREVERSIBLE && incomingRank <= currentRank) {
    return { allowed: false, code: 'irreversible_commitment', reason: '不可逆段只允许更高后果（死亡风险）在边界抢占' };
  }
  return { allowed: true, code: 'preempt', reason: '更高后果/优先度且位于原子边界' };
}

/**
 * 选一个当前候选。
 * @param {Array} candidates 候选（id/consequence/reversal/priority/eligible）
 * @param {object} ctx eligible 上下文
 * @param {object} state createPriorityState()
 * @param {{now?:number, atAtomBoundary?:boolean}} opts
 * @returns {{choice:object|null, previous:object|null, decision:object, evals:Array}}
 */
export function choosePriority(candidates, ctx, state, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const atAtomBoundary = opts.atAtomBoundary === true;
  const evals = (candidates || [])
    .map(normalizeCandidate)
    .filter(Boolean)
    .map((candidate) => {
      const invalidConsequence = candidate.consequenceDeclared !== true;
      if (invalidConsequence) {
        const key = `${candidate.id}\u0000${String(candidate.consequence)}`;
        if (!state.invalidConsequenceKeys.has(key)) {
          state.invalidConsequenceKeys.add(key);
          state.invalidConsequences += 1;
        }
      }
      return {
        id: candidate.id,
        candidate,
        invalidConsequence,
        eligible: !invalidConsequence && eligible(candidate, ctx),
      };
    })
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return compareCandidates(a.candidate, b.candidate);
    });

  const eligibleList = evals.filter((e) => e.eligible).map((e) => e.candidate);
  const storedCurrent = state.current && state.currentId === state.current.id ? state.current : null;
  const currentEval = storedCurrent ? evals.find((e) => e.id === storedCurrent.id) : null;
  const currentEligible = currentEval ? currentEval.eligible : storedCurrent ? eligible(storedCurrent, ctx) : false;
  const needsRelease = !!storedCurrent && !currentEligible;
  const pendingRelease = needsRelease && !atAtomBoundary;
  const currentReleased = needsRelease && atAtomBoundary;
  const current = pendingRelease ? storedCurrent : currentEligible ? storedCurrent : null;
  const top = eligibleList[0] ?? null;
  const fromId = needsRelease ? storedCurrent.id : (current?.id ?? null);

  if (pendingRelease) {
    const decision = {
      at: now,
      code: 'pending_release',
      reason: 'current 已失效，但不在原子边界：等边界再释放',
      from: fromId,
      to: null,
      atAtomBoundary,
    };
    state.lastDecision = decision;
    state.decisions += 1;
    state.denials += 1;
    return { choice: storedCurrent, previous: storedCurrent, decision, evals };
  }

  if (currentReleased) {
    if (storedCurrent.reversal === REVERSAL.IRREVERSIBLE) {
      const decision = {
        at: now,
        code: 'irreversible_release_blocked',
        reason: '不可逆 current 失效也必须等世界 postcheck，不能直接释放',
        from: fromId,
        to: top?.id ?? null,
        atAtomBoundary,
      };
      state.lastDecision = decision;
      state.decisions += 1;
      state.denials += 1;
      return { choice: storedCurrent, previous: storedCurrent, decision, evals };
    }
    state.currentId = null;
    state.current = null;
  }

  if (!top) {
    state.currentId = null;
    state.current = null;
    const decision = {
      at: now,
      code: 'no_eligible',
      reason: '没有可用候选',
      from: fromId,
      to: null,
      atAtomBoundary,
    };
    state.lastDecision = decision;
    state.decisions += 1;
    return { choice: null, previous: current, decision, evals };
  }

  if (current && current.id === top.id) {
    const decision = {
      at: now,
      code: 'keep_current',
      reason: '当前仍是最高候选',
      from: current.id,
      to: current.id,
      atAtomBoundary,
    };
    state.lastDecision = decision;
    state.decisions += 1;
    return { choice: current, previous: current, decision, evals };
  }

  const preemption = canPreempt(current, top, { atAtomBoundary });
  if (currentReleased) {
    preemption.allowed = true;
    preemption.code = 'current_ineligible';
    preemption.reason = '在途候选已不满足 eligible，释放后重选';
  }
  if (!preemption.allowed) {
    const decision = {
      at: now,
      code: preemption.code,
      reason: preemption.reason,
      from: fromId,
      to: top.id,
      atAtomBoundary,
    };
    state.lastDecision = decision;
    state.decisions += 1;
    state.denials += 1;
    return { choice: current, previous: current, decision, evals };
  }

  if (current) state.preemptions += 1;
  state.currentId = top.id;
  state.current = top;
  state.currentSince = now;
  const decision = {
    at: now,
    code: preemption.code,
    reason: preemption.reason,
    from: fromId,
    to: top.id,
    atAtomBoundary,
  };
  state.lastDecision = decision;
  state.decisions += 1;
  return { choice: top, previous: currentReleased ? storedCurrent : current, decision, evals };
}

/** 统一的可观测事件；Phase B 接入 trace。 */
export function priorityEvent(result) {
  const decision = result?.decision ?? {};
  return {
    type: 'priority/decision',
    code: decision.code ?? 'unknown',
    reason: decision.reason ?? '',
    from: decision.from ?? null,
    to: decision.to ?? null,
    incomingConsequence: decision.incomingConsequence ?? null,
    incomingReversal: decision.incomingReversal ?? null,
    atAtomBoundary: decision.atAtomBoundary === true,
    at: decision.at ?? null,
  };
}

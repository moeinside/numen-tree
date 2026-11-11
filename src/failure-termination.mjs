/**
 * 失败终止语义（纯函数，不执行动作）。
 *
 * 规则（docs/101）：
 * - 同参数失败 ≤2 → 可 retry/switch；
 * - 同原子失败 ≥3 → 必须 abandon 或 help；
 * - abandon 是合法终态，带 reason；
 * - 不允许无限重试。
 */
export const TERMINATION_ACTION = Object.freeze({
  RETRY: 'retry',
  SWITCH: 'switch',
  WAIT: 'wait',
  HELP: 'help',
  TERMINATE: 'terminate',
  ABANDON: 'abandon',
});

export function createTerminationState() {
  return {
    byParam: {},
    byAtom: {},
    byWait: {},
    abandoned: {},
    total: 0,
  };
}

function bump(map, key) {
  map[key] = Number(map[key] ?? 0) + 1;
  return map[key];
}

export function recordTerminationAttempt(state, input = {}) {
  const s = state || createTerminationState();
  const kind = String(input.kind ?? 'unknown');
  const scope = String(input.scope ?? 'unknown');
  const paramKey = String(input.paramKey ?? `${scope}:${kind}`);
  const atomId = String(input.atomId ?? '');
  const hasAlternate = input.hasAlternate !== false;
  const now = Number(input.now ?? Date.now());

  s.total = Number(s.total || 0) + 1;
  const paramAttempts = bump(s.byParam, `${scope}\u0000${paramKey}`);
  const atomAttempts = atomId ? bump(s.byAtom, `${scope}\u0000${atomId}`) : 0;

  let action = TERMINATION_ACTION.RETRY;
  let reason = '首次失败，允许重试';
  let code = 'retry';

  if (['timeout', 'slot_blocked', 'smelter_busy', 'gui_busy'].includes(kind)) {
    const waitKey = `${scope}\u0000${paramKey}`;
    const waitCount = bump(s.byWait, waitKey);
    if (waitCount >= 3) {
      action = TERMINATION_ACTION.ABANDON;
      reason = `${kind} 已等待 ${waitCount} 次仍无进展，终止`;
      code = 'wait_limit';
    } else {
      action = TERMINATION_ACTION.WAIT;
      reason = `${kind}：有上限等待（${waitCount}/3）`;
      code = 'wait_bounded';
      const waitMs = Math.min(30_000, 1000 * 2 ** (waitCount - 1));
      return { state: s, action, code, reason, paramAttempts, atomAttempts, waitCount, waitMs, at: now };
    }
  } else if (kind === 'terminated' || kind === 'cancelled') {
    action = TERMINATION_ACTION.TERMINATE;
    reason = `${kind}：明确终止`;
    code = 'terminate';
  } else if (atomAttempts >= 3) {
    action = TERMINATION_ACTION.ABANDON;
    reason = `同一原子失败 ${atomAttempts} 次，终止`;
    code = 'atom_limit';
  } else if (paramAttempts >= 3) {
    action = TERMINATION_ACTION.ABANDON;
    reason = `同参数失败 ${paramAttempts} 次，终止`;
    code = 'param_limit';
  } else if (paramAttempts >= 2) {
    if (hasAlternate) {
      action = TERMINATION_ACTION.SWITCH;
      reason = `同参数失败 ${paramAttempts} 次，换策略`;
      code = 'param_switch';
    } else {
      action = TERMINATION_ACTION.HELP;
      reason = `同参数失败 ${paramAttempts} 次且无备选，求助`;
      code = 'param_help';
    }
  }

  if (action === TERMINATION_ACTION.ABANDON || action === TERMINATION_ACTION.HELP) {
    const key = `${scope}\u0000${paramKey}`;
    if (!s.abandoned[key]) {
      s.abandoned[key] = { scope, kind, paramKey, action, code, reason, at: now, attempts: paramAttempts };
    }
  }

  return { state: s, action, code, reason, paramAttempts, atomAttempts, at: now };
}

export function isBlocked(state, scope, paramKey) {
  const key = `${scope}\u0000${paramKey}`;
  return state?.abandoned?.[key] ?? null;
}

/** 成功/新状态后清除该参数的历史失败，避免永久 abandon。 */
export function clearTerminationAttempt(state, scope, paramKey) {
  if (!state) return;
  const p = `${scope}\u0000${paramKey}`;
  delete state.byParam[p];
  delete state.byWait[p];
  for (const key of Object.keys(state.abandoned ?? {})) {
    if (key === p) delete state.abandoned[key];
  }
}

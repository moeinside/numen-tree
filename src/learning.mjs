/**
 * 窄学习：策略成败统计 → 小幅度优先级反馈。
 *
 * 不是在线 RL，不发明战略；只做：
 *  - 记录每个战略/任务的成功/失败/耗时/失败类型；
 *  - 用 EWMA 成功率给候选一个很小的加成/惩罚；
 *  - 给后续离线归纳/调参提供数据。
 *
 * 真正的“学战略”走离线轨迹归纳（docs/42），不在这里。
 */
const MAX_EVENTS = 40;

export function createLearningState() {
  return { strategies: {}, updatedAt: null };
}

function statFor(state, id) {
  state.strategies ??= {};
  state.strategies[id] ??= {
    attempts: 0,
    success: 0,
    fail: 0,
    lastKind: null,
    lastAt: null,
    avgMs: 0,
    ewmaSuccess: 0.5,
    recent: [],
  };
  return state.strategies[id];
}

export function recordStrategyOutcome(state, { strategyId, ok, kind = null, ms = 0, now = Date.now() }) {
  if (!strategyId) return state;
  const s = statFor(state, strategyId);
  s.attempts += 1;
  if (ok) s.success += 1;
  else s.fail += 1;
  s.lastKind = kind;
  s.lastAt = new Date(now).toISOString();
  s.avgMs = s.avgMs ? s.avgMs * 0.8 + Number(ms || 0) * 0.2 : Number(ms || 0);
  s.ewmaSuccess = s.ewmaSuccess * 0.7 + (ok ? 1 : 0) * 0.3;
  s.recent = [...(s.recent || []), { ok: !!ok, kind, ms, at: now }].slice(-MAX_EVENTS);
  state.updatedAt = s.lastAt;
  return state;
}

/** 给优先度的很小反馈：样本少时几乎不生效，避免早期误学。 */
export function learningBonus(state, strategyId) {
  const s = state?.strategies?.[strategyId];
  if (!s || s.attempts < 3) return 0;
  // success 0..1 → -5..+5
  return Math.round((Number(s.ewmaSuccess) - 0.5) * 10);
}

export function describeLearning(state) {
  const out = {};
  for (const [id, s] of Object.entries(state?.strategies || {})) {
    out[id] = {
      attempts: s.attempts,
      success: s.success,
      fail: s.fail,
      successRate: s.attempts ? Number((s.success / s.attempts).toFixed(2)) : 0,
      ewmaSuccess: Number(Number(s.ewmaSuccess || 0).toFixed(2)),
      bonus: learningBonus(state, id),
      lastKind: s.lastKind,
    };
  }
  return { updatedAt: state?.updatedAt ?? null, strategies: out };
}

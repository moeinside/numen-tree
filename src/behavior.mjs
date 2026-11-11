/**
 * 行为表现层：疲劳 → 动作表现乘子。
 * 只做数值映射，不做决策；lane 决定怎么用它。
 */
export function fatigueFactor(drives) {
  const f = Math.max(0, Math.min(1, Number(drives?.fatigue) || 0));
  // 0 疲劳=1.0；1 疲劳=0.55（动作预算缩短/失败率上升）
  return 1 - 0.45 * f;
}

export function fatigueBand(drives) {
  const f = Math.max(0, Math.min(1, Number(drives?.fatigue) || 0));
  if (f >= 0.85) return 'exhausted';
  if (f >= 0.6) return 'tired';
  if (f >= 0.3) return 'weary';
  return 'fresh';
}

/** 疲劳越高，自动动作预算越短；LLM 显式目标不应用此乘子。 */
export function effectiveAutoTimeout(ms, drives) {
  return Math.max(5_000, Number(ms || 0) * fatigueFactor(drives));
}

/**
 * 本能线（instinct）：快、硬、可覆盖。
 *
 * 只输出“是否有硬信号 + 类型”，不在这里执行动作；
 * 执行仍由中断表/reflex/strategies 处理。
 */
export function instinctState(st = {}, facts = {}) {
  if (st?.inWater) {
    return { active: true, kind: 'drown', priority: 100, reason: '在水里/溺水风险' };
  }
  const hpPct = Number(facts.hpPct ?? 100);
  if (hpPct <= 15) {
    return { active: true, kind: 'near_death', priority: 100, reason: `HP ${Math.round(hpPct)}%` };
  }
  if (Number(facts.hostileCount || 0) > 0 && Number(facts.hostileDistance ?? 999) <= 6) {
    return { active: true, kind: 'threat_close', priority: 95, reason: '敌对贴脸' };
  }
  return { active: false, kind: null, priority: 0, reason: null };
}

/**
 * 注意力（attention）：决定“什么进入考虑桌、权重多少”。
 *
 * 不是第三个决策者；输出 salience/焦点/是否被强刺激捕获。
 */
export function attentionState(facts = {}, drives = {}, { currentIntent = null, plan = null } = {}) {
  const s = {};
  // 外源显著：威胁、低血、溺水
  s.threat = Number(facts.hostileCount || 0) > 0 ? 100 : 0;
  s.pain = Number(facts.hpPct ?? 100) <= 35 ? 80 : 0;

  // 内源偏向：压力 → 对应类别更显眼
  s.food = Math.round(Number(drives.hunger || 0) * 100);
  s.gear = Math.round(Number(drives.resource || 0) * 80);
  s.night = Math.round(Number(drives.fatigue || 0) * 80);
  s.safety = Math.round(Number(drives.safety || 0) * 100);

  // 聚焦：当前意图获得额外显著度，避免被弱刺激拉走
  const focus = currentIntent || (plan?.intent ?? plan?.recipeId ?? null);
  if (focus) s[focusCategory(focus)] = Math.min(100, (s[focusCategory(focus)] || 0) + 15);

  // 强捕获：威胁/疼痛可以触发注意切换
  const captured =
    s.threat >= 90 || s.pain >= 80
      ? { kind: 'threat_or_pain', salience: Math.max(s.threat, s.pain) }
      : null;

  return { salience: s, focus, captured };
}

export function focusCategory(intent) {
  const s = String(intent || '');
  if (s.includes('food') || s.includes('feed') || s.includes('fish')) return 'food';
  if (s.includes('gear') || s.includes('weapon') || s.includes('tool') || s.includes('craft')) return 'gear';
  if (s.includes('night') || s.includes('sleep') || s.includes('prepare')) return 'night';
  if (s.includes('safety') || s.includes('stuck') || s.includes('escape')) return 'safety';
  return 'general';
}

/** 需求 → 注意类别 */
export function attentionBonusForNeed(needId, attention) {
  const s = attention?.salience || {};
  const cat = {
    food_low: 'food',
    get_weapon: 'gear',
    get_tools: 'gear',
    night_safety: 'night',
    night_chase: 'night',
    safety_hold: 'safety',
    stuck_escape: 'safety',
  }[needId];
  return cat ? Math.round((Number(s[cat]) || 0) * 0.25) : 0;
}

/**
 * 失败三分：可重试 / 换策略 / 求助。
 * 纯函数 + 小型全局预算；不执行动作。
 */
const RETRY = new Set(['timeout', 'slot_blocked', 'interrupted', 'failed', 'unknown', 'error', 'deferred_field_guarded']);
const SWITCH = new Set([
  'not_found',
  'no_path',
  'out_of_reach',
  'no_material',
  'no_chest',
  'no_food',
  'no_sea',
  'no_water',
  'no_bed',
  'no_fuel',
  'no_torch',
]);
const HELP = new Set([
  'no_rod',
  'ice_no_pickaxe',
  'chest_blocked',
  'rod_unavailable',
  'owner_offline',
  'need_tools',
  'need_gear',
  'no_home',
  'denied',
  'bad_argument',
]);

export function createFailureState() {
  return { total: 0, byKind: {}, byOwner: {}, recent: [], helpAt: 0, unreachable: null };
}

/** 三分；attempts 是同类失败次数（含本次）。 */
export function classifyFailure(kind, { attempts = 1, hasAlternate = true } = {}) {
  const k = String(kind ?? 'unknown');
  if (HELP.has(k)) return 'help';
  if (SWITCH.has(k)) return attempts >= 2 && !hasAlternate ? 'help' : 'switch';
  if (RETRY.has(k)) return attempts >= 2 && hasAlternate ? 'switch' : 'retry';
  return attempts >= 2 ? 'switch' : 'retry';
}

export function recordFailure(state, kind, { scope = 'unknown', now = Date.now(), hasAlternate = true } = {}) {
  const s = state || createFailureState();
  s.total = Number(s.total || 0) + 1;
  const k = String(kind ?? 'unknown');
  s.byKind[k] = Number(s.byKind[k] || 0) + 1;
  s.byOwner[scope] = Number(s.byOwner[scope] || 0) + 1;
  s.recent = [...(s.recent || []), { kind: k, scope, at: now }].slice(-30);
  const cls = classifyFailure(k, { attempts: s.byKind[k], hasAlternate });
  const shouldHelp = cls === 'help' || s.byKind[k] >= 3;
  // 只有 milestone 层有权宣布目标不可达；plan/strategy 只能升级。
  const unreachable =
    scope === 'milestone' && s.byKind[k] >= 3
      ? { kind: k, at: now, attempts: s.byKind[k] }
      : null;
  if (unreachable) s.unreachable = unreachable;
  return { state: s, cls, attempts: s.byKind[k], shouldHelp, unreachable };
}

/** 全局失败预算：窗口内失败太多 → 降级（调用方决定具体降级动作）。 */
export function failureBudgetExceeded(state, { windowMs = 5 * 60_000, max = 8, now = Date.now() } = {}) {
  const recent = (state?.recent || []).filter((r) => now - Number(r.at || 0) <= windowMs);
  return { exceeded: recent.length >= max, count: recent.length, max, windowMs };
}

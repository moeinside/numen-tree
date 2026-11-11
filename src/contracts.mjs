/**
 * 三个契约 + 适配器（docs/36）。
 *
 *  - Profile：战略包/战略表的内容描述；
 *  - Facts：优先度/战略共用的只读事实；
 *  - Candidate：优先度唯一输入。
 *
 * 目标：改优先度机制不批量改战略内容；改战略不动优先度。
 */
export const PROFILE_SCHEMA_VERSION = 1;

export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['not_object'] };
  if (Number(profile.schemaVersion) !== PROFILE_SCHEMA_VERSION) {
    errors.push(`schemaVersion:${profile.schemaVersion ?? 'missing'}`);
  }
  if (!profile.id || typeof profile.id !== 'string') errors.push('id');
  if (!Array.isArray(profile.intents) || profile.intents.length === 0) errors.push('intents');
  if (!Array.isArray(profile.steps) && !profile.acceptance) errors.push('steps_or_acceptance');
  return { ok: errors.length === 0, errors };
}

function timeBonus(hints, facts) {
  const table = hints?.timePhase;
  if (!table || !facts?.timePhase) return 0;
  const v = table[facts.timePhase];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/** Profile → Candidate。优先度只认这个结果。 */
export function profileToCandidate(profile, facts = {}) {
  const hints = profile?.scoreHints || {};
  const base = Number(hints.base ?? profile?.basePriority ?? 50);
  const required = Array.isArray(profile?.requires) ? profile.requires : [];
  return {
    id: profile.id,
    intentKey: profile.intentKey || profile.intents?.[0] || profile.id,
    profileId: profile.id,
    kind: profile.kind || 'routine',
    hard: profile.hard === true,
    hardPriority: Number(profile.hardPriority ?? 0),
    eligible: (f = {}) => {
      if (typeof profile.eligible === 'function') {
        try {
          return !!profile.eligible(f);
        } catch {
          return false;
        }
      }
      return required.every((k) => f[k] != null || k in f);
    },
    score: (f = facts) => {
      const bonus = timeBonus(hints, f);
      const total = Math.max(0, Math.min(100, base + bonus));
      return { total, parts: { base, timePhase: bonus } };
    },
    minRunSeconds: Number(profile.commitment?.minRunSeconds ?? profile.minRunSeconds ?? 0),
    switchCost: Number(profile.commitment?.switchCost ?? profile.switchCost ?? 0),
    cooldownSeconds: Number(profile.commitment?.cooldownSeconds ?? profile.cooldownSeconds ?? 0),
  };
}

/** Intent（轻量描述）→ Candidate，兼容现有 intents.mjs。 */
export function candidateFromIntent(intent, facts = {}) {
  const base = Number(intent?.basePriority ?? intent?.priority ?? 50);
  return {
    id: intent.id,
    intentKey: intent.id,
    profileId: null,
    kind: 'intent',
    hard: intent.hard === true,
    hardPriority: Number(intent.hardPriority ?? 0),
    eligible: () => true,
    score: () => ({ total: base, parts: { base } }),
    minRunSeconds: Number(intent.minRunSeconds ?? 0),
    switchCost: Number(intent.switchCost ?? 0),
    cooldownSeconds: Number(intent.cooldownSeconds ?? 0),
  };
}

/** 最小 Fact 默认值：新增字段必须在这里有默认，避免战略批量迁移。 */
export const FACT_DEFAULTS = {
  hp: 20,
  maxHp: 20,
  hpPct: 100,
  hunger: 20,
  foodCount: 0,
  hasWeapon: false,
  hasPickaxe: false,
  hasAxe: false,
  homeDistance: null,
  timePhase: null,
  dark: false,
  hostileCount: 0,
  ownerDistance: null,
  canFish: false,
  hasRod: false,
};

export function withFactDefaults(facts = {}) {
  return { ...FACT_DEFAULTS, ...(facts || {}) };
}

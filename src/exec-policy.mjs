/**
 * 执行策略层（docs/20 §10）：safe-batch / field-guarded。
 *
 * 设计要点（用户确认）：
 *  - "安全"是行为证据，不是地理位置；不用基地范围判定；
 *  - 硬风险（reflex/被打断/受伤/敌对贴近/主人危险）立即降档；
 *  - 打断后强制 field-guarded 冷却（默认 60s）；
 *  - 回到 safe-batch 需安静窗口（默认 30s，防抖）；
 *  - 长动作三查：preflight（新鲜观测）→ 事中看门狗（lane 负责）→ postflight（强制重观测）。
 */
export const EXEC_DEFAULTS = {
  batchMaxSeconds: 60,
  quietSeconds: 30,
  downgradeCooldownSeconds: 60,
  dangerHostileDistance: 16,
  ownerDangerWindowSeconds: 60,
  preflight: {
    requireFreshMs: 3000,
    hostileRadius: 24,
    minHpPercent: 60,
    minHunger: 8,
    quietMs: 30_000,
  },
};

const HARD_INTERRUPT_KINDS = ['preempted', 'timeout', 'detached', 'slot_blocked'];

/**
 * 长黑盒/长动作技能：field-guarded 下禁止自主派发（等环境安全或显式高优先级）。
 * 短/安全技能（eat/equip/find_block/scan_ground/collect_items/idle/index/place_block/retreat/approach_owner）不在名单。
 */
export const LONG_SKILLS = new Set([
  'craft',
  'mine_nearby',
  'dig_nearby',
  'dig_cells',
  'forage',
  'seek_food',
  'explore',
  'go_to',
  'smelt',
  'store_items',
  'fetch_items',
  'follow_owner',
  'pave_forward',
  'place_build',
]);

export function isLongSkill(skill) {
  return LONG_SKILLS.has(String(skill || ''));
}

function normalizePolicy(policy) {
  const p = policy || {};
  return {
    ...EXEC_DEFAULTS,
    ...p,
    preflight: { ...EXEC_DEFAULTS.preflight, ...(p.preflight || {}) },
  };
}

function hpPct(state) {
  const max = Number(state?.maxHp ?? 20) || 20;
  const hp = Number(state?.hp ?? max);
  return (hp / max) * 100;
}

function hostileNear(state, radius, { allowNullDistance = false } = {}) {
  const count = Number(state?.hostileCount ?? 0);
  if (count <= 0) return false;
  const d = state?.hostileDistance;
  if (d == null) return allowNullDistance;
  return Number(d) <= radius;
}

export function createExecState(now = Date.now()) {
  return {
    mode: 'safe-batch',
    reason: 'init',
    since: now,
    lastObservedAt: 0,
    lastRiskAt: 0,
    lastInterruptAt: 0,
    cooldownUntil: 0,
    risks: [],
  };
}

export function noteObservation(exec, now = Date.now()) {
  exec.lastObservedAt = now;
  return exec;
}

export function noteRisk(exec, reason, now = Date.now(), { cooldownSeconds } = {}) {
  const cd = Number(cooldownSeconds ?? EXEC_DEFAULTS.downgradeCooldownSeconds);
  exec.lastRiskAt = now;
  if (exec.mode !== 'field-guarded') {
    exec.mode = 'field-guarded';
    exec.since = now;
  }
  exec.reason = reason;
  exec.cooldownUntil = Math.max(exec.cooldownUntil, now + cd * 1000);
  exec.risks.push({ reason, at: now });
  if (exec.risks.length > 12) exec.risks.splice(0, exec.risks.length - 12);
  return exec;
}

export function noteInterrupt(exec, kind, now = Date.now()) {
  if (!HARD_INTERRUPT_KINDS.includes(String(kind))) return exec;
  exec.lastInterruptAt = now;
  return noteRisk(exec, `interrupt:${kind}`, now);
}

/**
 * 每 tick 调用：根据观测快照更新档位。
 * @returns {{mode,reason,since,cooldownUntil,lastRiskAt,lastObservedAt}}
 */
export function evaluateMode(exec, state, now = Date.now(), policy) {
  const p = normalizePolicy(policy);
  const reasons = [];

  if (state?.lastReflexAt && now - state.lastReflexAt <= p.preflight.quietMs) reasons.push('reflex');
  if (hostileNear(state, p.dangerHostileDistance)) reasons.push('hostile_close');
  if (hpPct(state) <= 50) reasons.push('hp_low');
  if (
    state?.ownerDangerAt &&
    now - state.ownerDangerAt <= p.ownerDangerWindowSeconds * 1000
  ) {
    reasons.push('owner_danger');
  }

  if (reasons.length) {
    noteRisk(exec, reasons[0], now, { cooldownSeconds: p.downgradeCooldownSeconds });
  } else if (now < exec.cooldownUntil) {
    if (exec.mode !== 'field-guarded') {
      exec.mode = 'field-guarded';
      exec.since = now;
    }
    exec.reason = 'cooldown';
  } else {
    const quietStart = Math.max(
      exec.lastRiskAt || 0,
      exec.lastInterruptAt || 0,
      state?.lastReflexAt || 0,
    );
    const quietFor = now - quietStart;
    if (exec.mode !== 'safe-batch' && quietFor >= p.quietSeconds * 1000) {
      exec.mode = 'safe-batch';
      exec.since = now;
      exec.reason = 'quiet';
    }
  }
  return describeExec(exec);
}

/**
 * 长动作 preflight：必须在刚做过新鲜观测后调用。
 * taskRisk: 'low' | 'medium' | 'high'
 */
export function preflight(exec, state, { taskRisk = 'low', now = Date.now(), policy } = {}) {
  const p = normalizePolicy(policy);
  const reasons = [];
  if (taskRisk === 'high') reasons.push('action_risk_high');
  if (exec.mode !== 'safe-batch') reasons.push(`mode:${exec.mode}`);
  if (!exec.lastObservedAt || now - exec.lastObservedAt > p.preflight.requireFreshMs) {
    reasons.push('observation_stale');
  }
  if (hostileNear(state, p.preflight.hostileRadius, { allowNullDistance: true })) {
    reasons.push('hostile_near');
  }
  if (hpPct(state) < p.preflight.minHpPercent) reasons.push('hp_low');
  if (Number(state?.hunger ?? 0) < p.preflight.minHunger) reasons.push('hunger_low');
  if (now - (exec.lastRiskAt || 0) < p.preflight.quietMs) reasons.push('recent_risk');
  if (
    state?.ownerDangerAt &&
    now - state.ownerDangerAt <= p.ownerDangerWindowSeconds * 1000
  ) {
    reasons.push('owner_danger');
  }
  return { ok: reasons.length === 0, reasons, taskRisk };
}

/** 长动作结束/急刹后强制重观测后调用；发现异常则标记风险。 */
export function postflight(exec, state, before = {}, { now = Date.now() } = {}) {
  const reasons = [];
  if (Number(before.hp ?? state?.hp ?? 0) - Number(state?.hp ?? 0) >= 2) reasons.push('hp_dropped');
  if (hostileNear(state, EXEC_DEFAULTS.dangerHostileDistance)) reasons.push('hostile_close');
  const b = before.pos;
  const a = state?.pos;
  if (b && a) {
    const dx = Number(a.x ?? 0) - Number(b.x ?? 0);
    const dy = Number(a.y ?? 0) - Number(b.y ?? 0);
    const dz = Number(a.z ?? 0) - Number(b.z ?? 0);
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 12) reasons.push('pos_jump');
  }
  if (reasons.length) noteRisk(exec, `postflight:${reasons[0]}`, now);
  return { ok: reasons.length === 0, reasons };
}

export function describeExec(exec) {
  return {
    mode: exec.mode,
    reason: exec.reason,
    since: exec.since,
    cooldownUntil: exec.cooldownUntil,
    lastRiskAt: exec.lastRiskAt,
    lastObservedAt: exec.lastObservedAt,
    risks: exec.risks.slice(-3),
  };
}

/**
 * 压力池（drives）：稳态内驱力的工程简化版。
 *
 * 不是“需求阈值”，而是持续累积的压力；满足后清零 + 饱腹/不应期。
 * 只维护数值，不做决策；决策在 lane/arbiter。
 */

const DEFAULTS = {
  hunger: 0,
  fatigue: 0,
  safety: 0,
  resource: 0,
  satiation: {},
  lastAt: 0,
};

export function createDriveState(now = Date.now()) {
  return { ...DEFAULTS, lastAt: now, satiation: {} };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function isSated(drives, key, now) {
  return Number(drives.satiation?.[key] || 0) > now;
}

function setSated(drives, key, now, ms) {
  drives.satiation ??= {};
  drives.satiation[key] = now + Math.max(0, ms);
}

/**
 * @param {object} drives 上一帧 driveState
 * @param {object} facts factsOf() 输出
 * @param {number} now
 * @param {object} st 原始 state（读 dark/gameTime）
 */
export function updateDrives(drives, facts, now = Date.now(), st = {}) {
  const d = drives || createDriveState(now);
  const last = Number(d.lastAt || now);
  const dt = Math.max(0, Math.min(10, (now - last) / 1000)); // 秒，限幅防跳变
  d.lastAt = now;
  d.satiation ??= {};

  const hunger = Number(facts?.hunger ?? 20);
  const hpPct = Number(facts?.hpPct ?? 100);
  const hostiles = Number(facts?.hostileCount ?? 0);
  const missingGear = !facts?.hasWeapon || !facts?.hasPickaxe;
  const dark = !!facts?.dark;

  // 饥饿：低饥饿时压力增长；吃饱后清零 + 饱腹
  if (hunger >= 18) {
    d.hunger = 0;
    setSated(d, 'hunger', now, 60_000);
  } else if (!isSated(d, 'hunger', now)) {
    const rate = hunger <= 6 ? 0.02 : hunger <= 12 ? 0.01 : 0.004;
    d.hunger = clamp01(d.hunger + rate * dt);
  }

  // 疲劳/夜晚：天黑时增长，白天衰减
  d.fatigue = clamp01(d.fatigue + (dark ? 0.008 : -0.004) * dt);

  // 安全：有敌对/低血时增长，安全时衰减
  const safetyRate = hostiles > 0 ? 0.02 : hpPct <= 35 ? 0.01 : -0.006;
  d.safety = clamp01(d.safety + safetyRate * dt);

  // 资源：缺武器/工具时缓慢增长，齐了衰减
  d.resource = clamp01(d.resource + (missingGear ? 0.003 : -0.004) * dt);

  return d;
}

/** 需求/意图 → 压力分量（0~100 加成）。 */
export function driveBonusForNeed(needId, drives) {
  const d = drives || {};
  const map = {
    food_low: Number(d.hunger || 0) * 45,
    get_weapon: Number(d.resource || 0) * 25,
    get_tools: Number(d.resource || 0) * 20,
    safety_hold: Number(d.safety || 0) * 35,
    stuck_escape: Number(d.safety || 0) * 30,
    night_safety: Number(d.fatigue || 0) * 25,
    night_chase: Number(d.safety || 0) * 30,
  };
  return Math.round(map[needId] ?? 0);
}

/** 给 UI/日志的简洁快照。 */
export function describeDrives(drives) {
  const d = drives || {};
  return {
    hunger: Number((d.hunger || 0).toFixed?.(3) ?? d.hunger ?? 0),
    fatigue: Number((d.fatigue || 0).toFixed?.(3) ?? d.fatigue ?? 0),
    safety: Number((d.safety || 0).toFixed?.(3) ?? d.safety ?? 0),
    resource: Number((d.resource || 0).toFixed?.(3) ?? d.resource ?? 0),
    satiation: Object.fromEntries(
      Object.entries(d.satiation || {}).map(([k, v]) => [k, Math.max(0, Math.round((Number(v) - Date.now()) / 1000))]),
    ),
  };
}

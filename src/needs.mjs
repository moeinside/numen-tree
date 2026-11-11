/**
 * 动态需求板（docs/22）：把"当前最该做什么"做成随状态升降的需求，而不是固定战略队列。
 *
 * 纯函数，不碰 lane；lane 每 tick 用 evaluateNeeds() 决定：
 *  - 哪些需求激活（按 priority 排序）
 *  - 哪些需求已满足（对应目标要降到最低/取消）
 *
 * 三个紧急需求：
 *  - get_weapon：无武器（死后/丢了）→ P1/P2；拿到任意武器 → 立即降 P5
 *  - get_tools：缺镐/斧 → P2/P3；拿到 → 降 P5
 *  - night_chase：夜里被追/离家太远 → P1；天亮/脱战/到家 → 降 P5
 */
export const NEED_FLOOR_PRIORITY = 5;

import { isToolBroken } from './tool-health.mjs';

/** 世界天数（game_time / 24000）；未知返回 null。 */
export function worldDayIndex(state) {
  const t = Number(state?.gameTime);
  return Number.isFinite(t) ? Math.floor(t / 24000) : null;
}

/** 当天时刻（0~23999）：6000 中午，12000 日落，13000 入夜。 */
export function worldDayTime(state) {
  let t = Number(state?.gameTime);
  if (!Number.isFinite(t)) t = Number(state?.tentacleDayTime);
  if (!Number.isFinite(t)) return null;
  return ((t % 24000) + 24000) % 24000;
}

/** 白天准备过夜的窗口：中午之后、天黑之前；夜里不再做“准备”。 */
export function inNightPrepWindow(state) {
  if (state?.dark) return false;
  const t = worldDayTime(state);
  if (t == null) return true; // 没有时间信息时按白天处理
  return t >= 6000 && t < 13000;
}

const WEAPON_RE = /(_sword|_axe|_bow|_crossbow|_trident|_staff|_wand)$/;
const PICKAXE_RE = /_pickaxe$/;
const AXE_RE = /_axe$/;

function itemsOf(state) {
  return Array.isArray(state?.inventory) ? state.inventory : [];
}

export function hasWeapon(state) {
  if (state?.weapon) return true;
  if (state?.catalog?.labels) {
    for (const [id, lab] of Object.entries(state.catalog.labels)) {
      if (lab?.weapon && itemsOf(state).some((s) => s.item === id && (s.count ?? 0) > 0)) return true;
    }
  }
  return itemsOf(state).some((s) => (s.count ?? 0) > 0 && WEAPON_RE.test(String(s.item ?? '')));
}

export function hasPickaxe(state) {
  if (isToolBroken(state, 'pickaxe')) return false;
  return itemsOf(state).some((s) => (s.count ?? 0) > 0 && PICKAXE_RE.test(String(s.item ?? '')));
}

export function hasAxe(state) {
  if (isToolBroken(state, 'axe')) return false;
  return itemsOf(state).some((s) => (s.count ?? 0) > 0 && AXE_RE.test(String(s.item ?? '')));
}

export function hasTools(state) {
  return hasPickaxe(state) && hasAxe(state);
}

/** 兼容 lane 的“可用工具”判断；坏工具不算可用。 */
export function hasUsableTool(state, kind) {
  if (kind === 'pickaxe') return hasPickaxe(state);
  if (kind === 'axe') return hasAxe(state);
  return itemsOf(state).some((s) => (s.count ?? 0) > 0 && String(s.item ?? '').endsWith(`_${kind}`));
}

export const NEED_DEFS = [
  {
    id: 'get_weapon',
    level: 2,
    title: '获得武器',
    strategies: ['recover_death_drops', 'craft_weapon'],
    done: (st) => hasWeapon(st),
    priority: (st, opt) => {
      if (hasWeapon(st)) return NEED_FLOOR_PRIORITY;
      let p = 65; // P2
      const hostileNear =
        Number(st?.hostileCount ?? 0) > 0 &&
        st?.hostileDistance != null &&
        Number(st.hostileDistance) <= 16;
      if (hostileNear) p = 85; // P1
      if (opt?.deathRecent) p = Math.max(p, 80);
      if (st?.dark) p = Math.min(90, p + 5);
      return p;
    },
  },
  {
    id: 'get_tools',
    level: 2,
    title: '获得工具（镐/斧）',
    strategies: ['recover_death_drops', 'craft_tools'],
    done: (st) => hasTools(st),
    priority: (st, opt) => {
      if (hasTools(st)) return NEED_FLOOR_PRIORITY;
      let p = 50; // P3
      if (!hasPickaxe(st) && !hasAxe(st)) p = 55;
      if (opt?.working) p = Math.max(p, 65); // 正在干活却缺工具
      return p;
    },
  },
  {
    id: 'night_chase',
    level: 3,
    title: '夜里被追/离家太远',
    strategies: ['night_hold', 'return_home'],
    done: (st, opt) => {
      if (!st?.dark) return true;
      if (Number(st?.hostileCount ?? 0) === 0) return true;
      if (opt?.homeDistance != null && Number(opt.homeDistance) <= 16) return true;
      return false;
    },
    priority: (st, opt) => {
      if (!st?.dark || Number(st?.hostileCount ?? 0) === 0) return NEED_FLOOR_PRIORITY;
      let p = 85; // P1
      if (opt?.reflexRecent) p = 90;
      return p;
    },
  },
  {
    id: 'safety_hold',
    level: 2,
    title: '回安全点（空手/离基地太远）',
    strategies: ['safety_hold'],
    done: (st, opt) => opt?.homeInside === true,
    priority: (st, opt) => {
      const now = Date.now();
      if (st.homeDwellUntil && now < Number(st.homeDwellUntil)) return NEED_FLOOR_PRIORITY;
      if (opt?.homeInside === true) return NEED_FLOOR_PRIORITY;
      let p = 60;
      if (!hasWeapon(st)) p = 75;
      if (st?.dark) p = Math.min(90, p + 5);
      if (st?.timePhase === 'dusk') p = Math.min(90, p + 5);
      if (st?.timePhase === 'night' || st?.timePhase === 'midnight') p = Math.min(90, p + 5);
      // 空间成本：离家越远，回家压力越大；不是硬圈，是软评分。
      const hd = Number(opt?.homeDistance ?? NaN);
      if (Number.isFinite(hd) && hd > 16) p = Math.max(p, 55 + Math.min(20, (hd - 16) / 4));
      if (Number.isFinite(hd) && hd > 32) p = Math.max(p, 80);
      if (st.homeCommitUntil && now < Number(st.homeCommitUntil)) p = Math.max(p, 85);
      const hpPct = (Number(st?.hp ?? 20) / (Number(st?.maxHp ?? 20) || 20)) * 100;
      if (hpPct <= 40) p = Math.max(p, 85);
      if (Number(st?.hostileCount ?? 0) > 0) p = Math.max(p, 85);
      return p;
    },
  },
  {
    id: 'night_safety',
    level: 3,
    title: '白天/黄昏准备过夜（夜里交给守家）',
    strategies: ['prepare_for_night'],
    done: (st) => {
      if (st?.dark) return true; // 夜里不再准备，守家/保命优先
      const day = worldDayIndex(st);
      if (day == null) return false;
      return Number(st?.nightPrepDay) === day; // 今天已经准备过 → 最低优先度
    },
    priority: (st) => {
      if (st?.dark) return NEED_FLOOR_PRIORITY;
      if (!inNightPrepWindow(st)) return NEED_FLOOR_PRIORITY;
      const day = worldDayIndex(st);
      if (day != null && Number(st?.nightPrepDay) === day) return NEED_FLOOR_PRIORITY;
      const t = worldDayTime(st);
      if (t == null) return 55;
      if (t >= 12000) return 80; // 快天黑了，抓紧
      if (t >= 10000) return 65;
      return 50; // 中午后先检查一次，不急
    },
  },
  {
    id: 'stuck_escape',
    level: 2,
    title: '移动失败/卡住需要脱困',
    strategies: ['escape_stuck'],
    done: (st) => {
      if (st?.inWater) return false;
      if (!st?.stuckSince) return true;
      const a = st.stuckAnchorPos;
      const p = st.pos;
      if (!a || !p) return false;
      return Math.hypot(Number(p.x) - Number(a.x), Number(p.z) - Number(a.z)) > 2.5;
    },
    priority: (st) => {
      if (st?.inWater) return 95; // 溺水/泡水：优先浮出水面
      if (Date.now() < Number(st?.stuckEscapeCooldownUntil || 0)) return NEED_FLOOR_PRIORITY;
      if (!st?.stuckSince) return NEED_FLOOR_PRIORITY;
      return Date.now() - Number(st.stuckSince) >= 5000 ? 75 : NEED_FLOOR_PRIORITY;
    },
  },
  {
    id: 'food_low',
    level: 3,
    title: '饥饿/低血需要食物',
    strategies: ['secure_food'],
    done: (st) => Number(st?.hunger ?? 20) >= 16,
    priority: (st) => {
      const hunger = Number(st?.hunger ?? 20);
      const hp = Number(st?.hp ?? 20);
      const maxHp = Number(st?.maxHp ?? 20) || 20;
      if (hunger > 8 && (hp / maxHp) * 100 >= 40) return NEED_FLOOR_PRIORITY;
      if (hunger <= 2) return 90;
      if (hunger <= 5) return 80;
      if (hunger <= 8) return 65;
      return 55;
    },
  },
];

export function getNeedDef(id) {
  return NEED_DEFS.find((n) => n.id === id) || null;
}

/**
 * 评估所有需求。
 * @returns {Array<{id,title,level,done,priority,strategies}>} 按 priority 降序（已完成的排最后）
 */
export function evaluateNeeds(state, opt = {}) {
  const entries = NEED_DEFS.map((def) => {
    const done = !!def.done(state, opt);
    const priority = done ? NEED_FLOOR_PRIORITY : Number(def.priority(state, opt));
    return {
      id: def.id,
      title: def.title,
      level: def.level,
      done,
      priority,
      strategies: def.strategies,
    };
  });
  return entries.sort((a, b) => b.priority - a.priority);
}

/** 需要处理的需求（未完成且优先级高于地板） */
export function activeNeeds(state, opt = {}) {
  return evaluateNeeds(state, opt).filter((n) => !n.done && n.priority > NEED_FLOOR_PRIORITY);
}

/** 已完成的需求（用来取消/降级对应目标） */
export function satisfiedNeeds(state, opt = {}) {
  return evaluateNeeds(state, opt).filter((n) => n.done);
}

/** 优先级 → 等级名（P0..P5） */
export function priorityBand(p) {
  const n = Number(p) || 0;
  if (n >= 90) return 'P0';
  if (n >= 80) return 'P1';
  if (n >= 60) return 'P2';
  if (n >= 40) return 'P3';
  if (n >= 20) return 'P4';
  return 'P5';
}

/**
 * 恢复装备（去死亡点捡武器/工具）的硬前置。
 * 用户修正（2026-11-08）：夜里死后不能立刻出去捡，否则跑远/再死 → 死循环。
 *
 * @param {object} state 同伴状态（hp/hunger/dark/hostileCount/hostileDistance）
 * @param {object} opt {deathsRecent, deathDistance, lastRecoveryFailed, retryAllowed}
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function gearRecoveryGate(state, opt = {}) {
  const reasons = [];
  if (state?.dark) reasons.push('night');
  const hp = Number(state?.hp ?? 20);
  const maxHp = Number(state?.maxHp ?? 20) || 20;
  if ((hp / maxHp) * 100 < 60) reasons.push('hp_low');
  if (Number(state?.hunger ?? 20) < 8) reasons.push('hunger_low');
  const hostiles = Number(state?.hostileCount ?? 0);
  const dist = state?.hostileDistance;
  if (hostiles > 0 && (dist == null || Number(dist) <= 24)) reasons.push('hostile_near');
  if (Number(opt.deathsRecent ?? 0) >= 2) reasons.push('death_loop_risk');
  if (opt.deathDistance != null && Number(opt.deathDistance) > 160) reasons.push('too_far');
  if (opt.lastRecoveryFailed && !opt.retryAllowed) reasons.push('recent_failure');
  return { ok: reasons.length === 0, reasons };
}

/**
 * 死后获取装备的决策：
 *  - 白天 + 安全 → recover（去死亡点捡）
 *  - 否则 → wait（守家/等天亮；夜里不出去）
 *  - 可选：safeAtBase + craft 条件由战略层决定，这里只给 wait 并附原因。
 */
export function gearRecoveryDecision(state, opt = {}) {
  const gate = gearRecoveryGate(state, opt);
  if (gate.ok) return { action: 'recover', reasons: [] };
  return {
    action: 'wait',
    reasons: gate.reasons,
    hint:
      gate.reasons.includes('night')
        ? '夜里不出去捡：先守家/等天亮，天亮且安全再恢复'
        : gate.reasons.includes('death_loop_risk')
          ? '最近连续死亡：延后恢复，先恢复血/食物或改为合成'
          : '当前不安全：先保命/等待，恢复装备延后',
  };
}

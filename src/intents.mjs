/**
 * 意图归并（优先度 MVP 第一步）。
 *
 * 目的：同一件事只允许一个 owner，避免：
 *  - get_weapon / get_tools 各自 enqueue 一个 secure_gear；
 *  - bootstrap_kit / craft_tools 自动计划与 secure_gear 目标互相抢；
 *  - secure_food 与旧 feed 计划同时跑；
 *  - prepare_for_night / night_hold 各排各的。
 *
 * 这里只定义“意图 → 需求/计划/战略”的映射；选择与承诺仍交给 lane/arbiter。
 */
export const INTENTS = {
  gear_recovery: {
    id: 'gear_recovery',
    label: '补装备（武器/工具）',
    needs: ['get_weapon', 'get_tools'],
    strategy: 'secure_gear',
    plans: ['bootstrap_kit', 'craft_tools', 'craft_gear'],
    minRunSeconds: 20,
    switchCost: 12,
    cooldownSeconds: 30,
  },
  food_security: {
    id: 'food_security',
    label: '食物安全',
    needs: ['food_low'],
    strategy: 'secure_food',
    plans: ['feed'],
    minRunSeconds: 15,
    switchCost: 10,
    cooldownSeconds: 45,
  },
  safety_hold: {
    id: 'safety_hold',
    label: '回安全点',
    needs: ['safety_hold'],
    strategy: 'safety_hold',
    plans: [],
    minRunSeconds: 10,
    switchCost: 8,
    cooldownSeconds: 30,
  },
  night_safety: {
    id: 'night_safety',
    label: '过夜安全',
    needs: ['night_safety'],
    strategy: 'prepare_for_night',
    plans: [],
    minRunSeconds: 20,
    switchCost: 12,
    cooldownSeconds: 60,
  },
  stuck_escape: {
    id: 'stuck_escape',
    label: '脱困',
    needs: ['stuck_escape'],
    strategy: 'escape_stuck',
    plans: ['escape_stuck'],
    minRunSeconds: 5,
    switchCost: 3,
    cooldownSeconds: 30,
    hard: true,
  },
  night_defense: {
    id: 'night_defense',
    label: '夜战/守家',
    needs: ['night_chase'],
    strategy: 'night_hold',
    plans: ['go_home'],
    minRunSeconds: 10,
    switchCost: 8,
    cooldownSeconds: 30,
    hard: true,
  },
};

const NEED_TO_INTENT = new Map();
for (const it of Object.values(INTENTS)) {
  for (const n of it.needs) NEED_TO_INTENT.set(n, it.id);
}

const PLAN_TO_INTENT = new Map();
for (const it of Object.values(INTENTS)) {
  for (const p of it.plans) PLAN_TO_INTENT.set(p, it.id);
}

export function intentForNeed(needId) {
  return NEED_TO_INTENT.get(needId) || null;
}

export function intentById(id) {
  return INTENTS[id] || null;
}

export function intentForPlan(recipeId) {
  return PLAN_TO_INTENT.get(recipeId) || null;
}

/** 当前正在执行/排队的意图（按 goals + plan）。 */
export function activeIntents(state) {
  const out = new Set();
  for (const g of state?.goals || []) {
    if (g.status === 'pending' || g.status === 'running') {
      if (g.intent) out.add(g.intent);
    }
  }
  const plan = state?.plan;
  if (plan && (plan.status === 'running' || plan.status === 'suspended')) {
    const it = intentForPlan(plan.recipeId);
    if (it) out.add(it);
  }
  return out;
}

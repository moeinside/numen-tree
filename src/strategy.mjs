/**
 * 战略包（docs/20 §7）：目标 + 依赖规划 + 战术编排 + 降级。
 *
 * v1：make_item（L2，仅合成、材料已备）
 * v2：secure_gear（L3，死后/无装备时恢复：先捡死亡点，夜里等待）
 */
import { gearRecoveryDecision, hasTools, hasWeapon } from './needs.mjs';
import { LOG_ITEMS, PLANK_ITEMS } from './crafttree.mjs';
import { edibleInInventory, foodInfo, isEdible, rawInInventory } from './food.mjs';
import { escapeStuck } from './strategies/escape_stuck.mjs';
import { safetyHold, returnHome } from './strategies/safety.mjs';
import { secureFood, eatToRecover } from './strategies/food.mjs';
import { secureGear, makeItem, pickCraftable, ensureWorkbench, craftWoodenGear } from './strategies/craft.mjs';
import { ensureSticks, mineCoal, makeCharcoal } from './strategies/fuel.mjs';
import { sleepThroughNight, lightBase, prepareForNight, nightHold } from './strategies/night.mjs';
import {
  storeMaterials,
  storeMaterialsCandidate,
  materialsInInventory,
  stockBackup,
} from './strategies/storage.mjs';

export { storeMaterialsCandidate, materialsInInventory };

export const STRATEGIES = {
  make_item: {
    schemaVersion: 1,
    id: 'strategy.make_item',
    title: '战略：做一个有依赖的物品（v1 仅合成、材料已备）',
    level: 2, // L2 功能战略：单一交付物 + 可数验收
    defaultPriority: 40,
    preemptible: true,
    params: { item: 'string', count: 'number=1' },
    acceptance: 'inventory.count(item) >= count',
    timeOfDay: 'any',
    priorityByTime: { day: 40, night: 20 },
    nightFallback: 'hold',
    maxTactics: 16,
    maxSeconds: 45,
  },
  secure_gear: {
    schemaVersion: 1,
    id: 'strategy.secure_gear',
    title: '战略：死后/无装备时恢复武器与工具（先捡死亡点，夜里等待）',
    level: 3, // L3 工程/恢复战略
    defaultPriority: 80,
    preemptible: true,
    params: {},
    acceptance: 'hasWeapon && hasTools',
    timeOfDay: 'day',
    priorityByTime: { day: 80, night: 5 },
    nightFallback: 'wait',
    requiresDaylight: true,
    maxTactics: 24,
    maxSeconds: 90,
  },
  night_hold: {
    schemaVersion: 1,
    id: 'strategy.night_hold',
    title: '战略：夜里被追/离家远 → 回家或就近守住（不跑远）',
    level: 3,
    defaultPriority: 85,
    preemptible: true,
    params: {},
    acceptance: '!dark || hostiles==0 || homeDistance<=16',
    timeOfDay: 'night',
    priorityByTime: { day: 5, night: 85 },
    nightFallback: 'hold',
    maxTactics: 6,
    maxSeconds: 30,
  },
  stock_backup: {
    schemaVersion: 1,
    id: 'strategy.stock_backup',
    title: '战略：基地至少留一份备用工具（背包≥2 才存 1）',
    level: 2,
    defaultPriority: 18,
    preemptible: true,
    params: {},
    acceptance: 'chest has one backup per tool category',
    timeOfDay: 'any',
    priorityByTime: { day: 20, night: 5 },
    nightFallback: 'hold',
    maxTactics: 24,
    maxSeconds: 90,
  },
  store_materials: {
    schemaVersion: 1,
    id: 'strategy.store_materials',
    title: '战略：把背包里的素材存进家里的箱子（效用型）',
    level: 2,
    defaultPriority: 25,
    preemptible: true,
    params: { limit: 'number=6' },
    acceptance: 'materials moved > 0',
    timeOfDay: 'any',
    priorityByTime: { day: 30, night: 10 },
    nightFallback: 'hold',
    maxTactics: 20,
    maxSeconds: 80,
  },
  eat_to_recover: {
    schemaVersion: 1,
    id: 'strategy.eat_to_recover',
    title: '战略：吃到饥饿目标（回血/解除饥饿）',
    level: 2,
    defaultPriority: 55,
    preemptible: true,
    params: { targetHunger: 'number=18' },
    acceptance: 'hunger >= targetHunger',
    timeOfDay: 'any',
    priorityByTime: { day: 55, night: 60 },
    nightFallback: 'hold',
    maxTactics: 12,
    maxSeconds: 40,
  },
  sleep_through_night: {
    schemaVersion: 1,
    id: 'strategy.sleep_through_night',
    title: '战略：找床睡到天亮',
    level: 2,
    defaultPriority: 70,
    preemptible: true,
    params: {},
    acceptance: '!dark',
    timeOfDay: 'night',
    priorityByTime: { day: 5, night: 70 },
    nightFallback: 'hold',
    maxTactics: 12,
    maxSeconds: 40,
  },
  safety_hold: {
    schemaVersion: 1,
    id: 'strategy.safety_hold',
    title: '战略：回安全点（空手/离基地太远），到家后再巡逻',
    level: 2,
    defaultPriority: 75,
    preemptible: true,
    params: { radius: 'number=12' },
    acceptance: 'homeDistance <= 12',
    timeOfDay: 'any',
    priorityByTime: { day: 60, night: 80 },
    nightFallback: 'hold',
    maxTactics: 12,
    maxSeconds: 45,
  },
  return_home: {
    schemaVersion: 1,
    id: 'strategy.return_home',
    title: '战略：回家（分片移动，到家附近）',
    level: 2,
    defaultPriority: 60,
    preemptible: true,
    params: {},
    acceptance: 'homeDistance <= 8',
    timeOfDay: 'any',
    priorityByTime: { day: 40, night: 65 },
    nightFallback: 'hold',
    maxTactics: 12,
    maxSeconds: 40,
  },
  light_base: {
    schemaVersion: 1,
    id: 'strategy.light_base',
    title: '战略：给基地放火把（现成/箱子/现做）',
    level: 2,
    defaultPriority: 60,
    preemptible: true,
    params: { count: 'number=4' },
    acceptance: 'placed torches > 0',
    timeOfDay: 'any',
    priorityByTime: { day: 35, night: 65 },
    nightFallback: 'hold',
    maxTactics: 20,
    maxSeconds: 60,
  },
  prepare_for_night: {
    schemaVersion: 1,
    id: 'strategy.prepare_for_night',
    title: '战略：过夜准备（床→火把→回家→上报）',
    level: 3,
    defaultPriority: 75,
    preemptible: true,
    params: {},
    acceptance: 'slept || base lit',
    timeOfDay: 'day',
    priorityByTime: { day: 75, night: 5 },
    nightFallback: 'hold',
    maxTactics: 30,
    maxSeconds: 90,
  },
  mine_coal: {
    schemaVersion: 1,
    id: 'strategy.mine_coal',
    title: '战略：挖煤（找煤矿→走过去→挖一小簇）',
    level: 2,
    defaultPriority: 45,
    preemptible: true,
    params: { count: 'number=4' },
    acceptance: 'coal count > 0',
    timeOfDay: 'day',
    priorityByTime: { day: 45, night: 5 },
    nightFallback: 'wait',
    maxTactics: 12,
    maxSeconds: 50,
  },
  make_charcoal: {
    schemaVersion: 1,
    id: 'strategy.make_charcoal',
    title: '战略：烧木炭（挖石→熔炉→烧原木）',
    level: 2,
    defaultPriority: 45,
    preemptible: true,
    params: {},
    acceptance: 'charcoal count > 0',
    timeOfDay: 'day',
    priorityByTime: { day: 45, night: 5 },
    nightFallback: 'wait',
    maxTactics: 30,
    maxSeconds: 90,
  },
  secure_food: {
    schemaVersion: 1,
    id: 'strategy.secure_food',
    title: '战略：多来源解决食物（背包/箱子/烹饪/猎杀/急救）',
    level: 3,
    defaultPriority: 80,
    preemptible: true,
    params: { targetHunger: 'number=16' },
    acceptance: 'hunger >= targetHunger',
    timeOfDay: 'any',
    priorityByTime: { day: 80, night: 65 },
    nightFallback: 'hold',
    maxTactics: 30,
    maxSeconds: 90,
  },
  escape_stuck: {
    schemaVersion: 1,
    id: 'strategy.escape_stuck',
    title: '战略：自主脱困（走/跳/挖，不传送）',
    level: 2,
    defaultPriority: 70,
    preemptible: true,
    params: {},
    acceptance: 'moved > 2.5 blocks',
    timeOfDay: 'any',
    priorityByTime: { day: 70, night: 70 },
    nightFallback: 'hold',
    maxTactics: 24,
    maxSeconds: 50,
  },
};

export function getStrategy(id) {
  const key = String(id || '').replace(/^strategy\./, '');
  return STRATEGIES[key] || null;
}

/** 按昼夜返回战略建议优先级（未声明则用 defaultPriority）。 */
export function strategyTimePriority(strategy, state) {
  const s = typeof strategy === 'string' ? getStrategy(strategy) : strategy;
  const by = s?.priorityByTime;
  if (by) return Number(state?.dark ? (by.night ?? s.defaultPriority ?? 30) : (by.day ?? s.defaultPriority ?? 30));
  return Number(s?.defaultPriority ?? 30);
}

/** 当前昼夜是否允许启动该战略（day/night/any）。 */
export function strategyAllowedNow(strategy, state) {
  const s = typeof strategy === 'string' ? getStrategy(strategy) : strategy;
  const t = s?.timeOfDay ?? 'any';
  if (t === 'day') return !state?.dark;
  if (t === 'night') return !!state?.dark;
  return true;
}

/** 从战术返回里取 vars 的便捷函数。 */

/**
 * @param {string} id
 * @param {object} params
 * @param {{callTactic: (id:string,params:object)=>Promise<any>, trace?: Function, budget?: {maxTactics?:number,maxSeconds?:number}}} ctx
 */
export async function runStrategy(id, params = {}, ctx) {
  const strat = getStrategy(id);
  if (!strat) return { ok: false, kind: 'unknown_strategy', message: `没有这个战略包：${id}`, steps: [] };
  const started = Date.now();
  const maxTactics = Number(ctx.budget?.maxTactics ?? strat.maxTactics ?? 16);
  const maxMs = Number(ctx.budget?.maxSeconds ?? strat.maxSeconds ?? 45) * 1000;
  let tactics = 0;
  const steps = [];
  const callTactic = async (tid, tparams) => {
    if (tactics >= maxTactics) throw Object.assign(new Error('strategy 战术数超预算'), { strategyBudget: 'maxTactics' });
    if (Date.now() - started > maxMs) throw Object.assign(new Error('strategy 时间超预算'), { strategyBudget: 'maxSeconds' });
    tactics += 1;
    const r = await ctx.callTactic(tid, tparams);
    steps.push({ tactic: tid, ok: !!r?.ok, kind: r?.kind ?? 'ok' });
    return r;
  };

  try {
    const key = String(strat.id).replace(/^strategy\./, '');
    if (key === 'make_item') {
      const out = await makeItem(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'secure_gear') {
      const out = await secureGear(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'night_hold') {
      const out = await nightHold(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'stock_backup') {
      const out = await stockBackup(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'store_materials') {
      const out = await storeMaterials(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'eat_to_recover') {
      const out = await eatToRecover(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'sleep_through_night') {
      const out = await sleepThroughNight(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'safety_hold') {
      const out = await safetyHold(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'return_home') {
      const out = await returnHome(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'light_base') {
      const out = await lightBase(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'prepare_for_night') {
      const out = await prepareForNight(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'mine_coal') {
      const out = await mineCoal(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'make_charcoal') {
      const out = await makeCharcoal(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'secure_food') {
      const out = await secureFood(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    if (key === 'escape_stuck') {
      const out = await escapeStuck(params, ctx, callTactic);
      return { ...out, strategy: strat.id, tactics, steps, ms: Date.now() - started };
    }
    return { ok: false, kind: 'unknown_strategy', message: `未实现：${id}`, steps };
  } catch (e) {
    return {
      ok: false,
      kind: e?.strategyBudget ? 'budget' : 'error',
      message: String(e?.message ?? e).slice(0, 300),
      strategy: strat.id,
      tactics,
      steps,
      ms: Date.now() - started,
    };
  }
}

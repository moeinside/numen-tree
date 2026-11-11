/**
 * 就绪层（readiness）：装备/工具/后勤检查。
 *
 * 纯函数：只读 state/chestCounts，不执行动作、不改变优先级。
 * 输出缺失项和建议，由 lane/优先度决定是否转 gear_recovery / safety_hold。
 */
import { hasWeapon, hasPickaxe, hasAxe } from './needs.mjs';

const BASE_NEEDS = ['weapon', 'pickaxe', 'axe'];
const STOCK_TARGETS = { food: 8, torch: 8 };

function countItem(state, predicate) {
  return (Array.isArray(state?.inventory) ? state.inventory : [])
    .filter((s) => (s.count ?? 0) > 0 && predicate(String(s.item ?? '')))
    .reduce((a, s) => a + Number(s.count ?? 0), 0);
}

export function evaluateReadiness(state, { chestCounts = {}, needRod = false } = {}) {
  const missing = [];
  if (!hasWeapon(state)) missing.push({ key: 'weapon', label: '武器', intent: 'gear_recovery' });
  if (!hasPickaxe(state)) missing.push({ key: 'pickaxe', label: '镐', intent: 'gear_recovery' });
  if (!hasAxe(state)) missing.push({ key: 'axe', label: '斧', intent: 'gear_recovery' });
  if (needRod && !countItem(state, (it) => it.endsWith('fishing_rod'))) {
    missing.push({ key: 'rod', label: '钓竿', intent: 'gear_recovery' });
  }

  const food = Number(state?.foodCount ?? 0);
  const torch = countItem(state, (it) => it === 'minecraft:torch');
  const stockGaps = [];
  if (food < STOCK_TARGETS.food && Number(chestCounts.food ?? 0) < STOCK_TARGETS.food) {
    stockGaps.push({ key: 'food', label: '食物储备', have: food + Number(chestCounts.food ?? 0) });
  }
  if (torch < STOCK_TARGETS.torch && Number(chestCounts.torch ?? 0) < STOCK_TARGETS.torch) {
    stockGaps.push({ key: 'torch', label: '火把储备', have: torch + Number(chestCounts.torch ?? 0) });
  }

  return {
    ok: missing.length === 0,
    missing,
    stockGaps,
    has: {
      weapon: hasWeapon(state),
      pickaxe: hasPickaxe(state),
      axe: hasAxe(state),
      rod: countItem(state, (it) => it.endsWith('fishing_rod')) > 0,
      food,
      torch,
    },
    targets: { ...STOCK_TARGETS, backupTools: 1 },
  };
}

/** 任务前预检：只做“该任务需要的工具”检查。 */
export function preflight(task, state) {
  const t = String(task || '');
  const missing = [];
  if (/(mine|dig|stone|ore|coal)/.test(t) && !hasPickaxe(state)) missing.push('pickaxe');
  if (/(chop|wood|gather|log)/.test(t) && !hasAxe(state)) missing.push('axe(可手挖降级)');
  if (/(fish|fishing)/.test(t) && countItem(state, (it) => it.endsWith('fishing_rod')) === 0) {
    missing.push('fishing_rod');
  }
  if (/(fight|guard|combat)/.test(t) && !hasWeapon(state)) missing.push('weapon');
  return { ok: missing.length === 0, task: t, missing };
}

/** 天亮审计去重：同一天只返回一次 true。 */
export function shouldAuditDawn(state, dayIndex) {
  if (state?.timePhase !== 'dawn') return false;
  if (dayIndex == null) return false;
  return Number(state?.readinessAuditDay) !== Number(dayIndex);
}

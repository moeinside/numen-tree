/**
 * P0-0b：consequence/reversal 的显式声明表（Phase B）。
 * 真实 trace 前必须用本表，不再用数字 priority 猜后果。
 */
import { CONSEQUENCE, REVERSAL, isConsequence, isReversal } from './priority.mjs';

export const PRIORITY_CLASS_CONSEQUENCE = Object.freeze({
  P0: CONSEQUENCE.DEATH_RISK,
  P1: CONSEQUENCE.IRREVERSIBLE_LOSS,
  P2: CONSEQUENCE.REVERSIBLE_NEED,
  P3: CONSEQUENCE.REVERSIBLE_NEED,
  P4: CONSEQUENCE.REVERSIBLE_NEED,
});

/** 与 interrupts.mjs 的 id 一一对应；新增中断必须在这里声明。 */
export const INTERRUPT_CONSEQUENCE = Object.freeze({
  near_death: CONSEQUENCE.DEATH_RISK,
  outnumbered: CONSEQUENCE.DEATH_RISK,
  night_danger: CONSEQUENCE.IRREVERSIBLE_LOSS,
  stuck: CONSEQUENCE.REVERSIBLE_NEED,
  owner_danger_help: CONSEQUENCE.IRREVERSIBLE_LOSS,
  owner_danger_hide: CONSEQUENCE.IRREVERSIBLE_LOSS,
  hostile_close_fight: CONSEQUENCE.IRREVERSIBLE_LOSS,
  hostile_close_flee: CONSEQUENCE.IRREVERSIBLE_LOSS,
});

/** 中断本身只负责抢占；默认 resumable，由上层决定恢复。 */
export const INTERRUPT_REVERSAL = Object.freeze({
  near_death: REVERSAL.RESUMABLE,
  outnumbered: REVERSAL.RESUMABLE,
  night_danger: REVERSAL.COMPENSABLE,
  stuck: REVERSAL.RESUMABLE,
  owner_danger_help: REVERSAL.RESUMABLE,
  owner_danger_hide: REVERSAL.RESUMABLE,
  hostile_close_fight: REVERSAL.RESUMABLE,
  hostile_close_flee: REVERSAL.RESUMABLE,
});

export function consequenceForPriorityClass(value) {
  return PRIORITY_CLASS_CONSEQUENCE[String(value)] ?? null;
}

export function priorityClassForConsequence(consequence) {
  if (consequence === CONSEQUENCE.DEATH_RISK) return 'P0';
  if (consequence === CONSEQUENCE.IRREVERSIBLE_LOSS) return 'P1';
  if (consequence === CONSEQUENCE.REVERSIBLE_NEED) return 'P2';
  return null;
}

/** 策略 id → 显式声明；新增策略必须在这里声明。 */
export const STRATEGY_DECLARATIONS = Object.freeze({
  make_item: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P3' },
  secure_gear: { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.RESUMABLE, priorityClass: 'P1' },
  night_hold: { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.RESUMABLE, priorityClass: 'P1' },
  stock_backup: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P3' },
  store_materials: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P3' },
  eat_to_recover: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P2' },
  sleep_through_night: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.COMPENSABLE, priorityClass: 'P2' },
  safety_hold: { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.RESUMABLE, priorityClass: 'P1' },
  return_home: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P2' },
  light_base: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P2' },
  prepare_for_night: { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.COMPENSABLE, priorityClass: 'P1' },
  mine_coal: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P3' },
  make_charcoal: { consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, priorityClass: 'P3' },
  secure_food: { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.RESUMABLE, priorityClass: 'P1' },
  escape_stuck: { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.RESUMABLE, priorityClass: 'P1' },
});

export function declarationForStrategy(strategyId) {
  const declaration = STRATEGY_DECLARATIONS[String(strategyId)] ?? null;
  return declaration ?? { consequence: null, reversal: REVERSAL.RESUMABLE, priorityClass: null, declared: false };
}

export function declarationForInterrupt(entry) {
  const id = String(entry?.id ?? '');
  const consequence = isConsequence(entry?.consequence)
    ? entry.consequence
    : INTERRUPT_CONSEQUENCE[id] ?? null;
  const reversal = isReversal(entry?.reversal)
    ? entry.reversal
    : INTERRUPT_REVERSAL[id] ?? REVERSAL.RESUMABLE;
  return { id, consequence, reversal, declared: consequence !== null };
}

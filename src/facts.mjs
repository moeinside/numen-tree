/**
 * 事实层：优先度系统/战略包共用的只读事实。
 *
 * 原则：
 *  - 只从 state 派生，不读游戏、不调 numen；
 *  - 新字段给默认值，避免战略批量迁移；
 *  - 优先度/战略都只读 Facts，不互相读内部状态。
 */
import { hasWeapon, hasPickaxe, hasAxe } from './needs.mjs';
import { statePhase } from './time.mjs';

export function factsOf(state, { homeDistance = null } = {}) {
  const st = state || {};
  const maxHp = Number(st.maxHp ?? 20) || 20;
  const hp = Number(st.hp ?? maxHp);
  return {
    hp,
    maxHp,
    hpPct: Math.max(0, Math.min(100, (hp / maxHp) * 100)),
    hunger: Number(st.hunger ?? 20),
    foodCount: Number(st.foodCount ?? 0),
    hasWeapon: !!hasWeapon(st),
    hasPickaxe: !!hasPickaxe(st),
    hasAxe: !!hasAxe(st),
    homeDistance: homeDistance == null ? null : Number(homeDistance),
    ownerPos: st.ownerPos ? { ...st.ownerPos } : null,
    homeRadius: st.homeRadius == null ? null : Number(st.homeRadius),
    timePhase: st.timePhase ?? statePhase(st),
    dark: !!st.dark,
    hostileCount: Number(st.hostileCount ?? 0),
    hostileDistance: st.hostileDistance == null ? null : Number(st.hostileDistance),
    ownerDistance: st.ownerDistance == null ? null : Number(st.ownerDistance),
    canFish: false, // 由后续感知补齐；先给默认值
    hasRod: Array.isArray(st.inventory)
      ? st.inventory.some((s) => String(s.item ?? '').endsWith('fishing_rod') && (s.count ?? 0) > 0)
      : false,
  };
}

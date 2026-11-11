/**
 * 游戏内时间阶段（0~23999）。
 *
 * 用途：优先度/战略判断“现在适合做什么”，比只有 dark 更细：
 *  - dawn/morning/noon/afternoon → 干活
 *  - dusk → 回家/准备过夜/停止远行
 *  - night/midnight → 守家/保命/不钓鱼不打猎
 *
 * 数据来源：st.gameTime（numen 观测）优先；Lua 槽被占时用触手 day_time 兜底。
 */
export const TIME_PHASES = ['dawn', 'morning', 'noon', 'afternoon', 'dusk', 'night', 'midnight'];

export const PHASE_LABELS = {
  dawn: '黎明',
  morning: '上午',
  noon: '中午',
  afternoon: '下午',
  dusk: '黄昏',
  night: '夜晚',
  midnight: '深夜',
};

export function dayPhase(dayTime) {
  const t = Number(dayTime);
  if (!Number.isFinite(t)) return null;
  const x = ((t % 24000) + 24000) % 24000;
  if (x < 1000 || x >= 23000) return 'dawn';
  if (x < 5000) return 'morning';
  if (x < 7000) return 'noon';
  if (x < 11000) return 'afternoon';
  if (x < 13000) return 'dusk';
  if (x < 18000) return 'night';
  return 'midnight';
}

/** 从 state 推断阶段：优先世界 day_time，其次触手 day_time，最后 dark 保守态。 */
export function statePhase(state) {
  const dt = Number(state?.dayTime ?? state?.tentacleDayTime);
  if (Number.isFinite(dt)) return dayPhase(dt);
  if (state?.dark === true) return 'night';
  if (state?.dark === false) return 'day';
  return 'unknown';
}

export function isDuskOrNight(phase) {
  return phase === 'dusk' || phase === 'night' || phase === 'midnight';
}

export function isDayWorkPhase(phase) {
  return phase === 'dawn' || phase === 'morning' || phase === 'noon' || phase === 'afternoon';
}

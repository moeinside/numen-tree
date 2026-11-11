/**
 * 空间谓词：3D 距离 / 体积归属 / 同层。
 * 只做纯数学，不读游戏。
 */

export function asPos(p) {
  if (!p) return null;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

export function distance3(a, b) {
  const p = asPos(a);
  const q = asPos(b);
  if (!p || !q) return null;
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

export function verticalDelta(a, b) {
  const p = asPos(a);
  const q = asPos(b);
  if (!p || !q) return null;
  return Math.abs(p.y - q.y);
}

export function sameLevel(a, b, tolerance = 2) {
  const dy = verticalDelta(a, b);
  return dy != null && dy <= Number(tolerance);
}

/**
 * 先支持“中心 + 半径 + 层高”的体积；bbox 后续扩展。
 */
export function isInsideRegion(pos, region) {
  const p = asPos(pos);
  if (!p || !region) return false;
  const center = asPos(region.center ?? region);
  if (!center) return false;
  const radius = Math.max(0, Number(region.radius ?? 0));
  const yTolerance = Math.max(0, Number(region.yTolerance ?? 2));
  return distance3(p, center) <= radius && verticalDelta(p, center) <= yTolerance;
}

/** 家/庇护判定：3D 半径 + 同层，缺一不可。 */
export function atHome(pos, home, { radius = 3, yTolerance = 2 } = {}) {
  const center = home?.pos ?? home;
  return isInsideRegion(pos, { center, radius, yTolerance });
}

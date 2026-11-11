/**
 * 基地范围：3D bbox 并集。
 * 只读 places，不读游戏。
 */

const BASE_HALF = 5;
const BASE_Y = 5;

function num(v, d = 0) {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 家/基地的保守默认范围：
 * - 名称含“家” → 以 home 为中心的小盒，覆盖 9×9 房间
 * - 其它 base → 20×20 基地盒
 * - place.radius 存在时，作为水平半径覆盖默认
 */
export function baseRegions(placeBook) {
  const list = placeBook?.list?.({ kind: 'base' }) || [];
  return list.filter((p) => p?.pos).map((p) => {
    const isHome = String(p.name || '').includes('家');
    // 当前阶段统一：基地/家周围 10×10×10 禁挖。
    const half = num(p.radius, BASE_HALF);
    const yMin = num(p.pos.y) - BASE_Y;
    const yMax = num(p.pos.y) + BASE_Y;
    return {
      id: p.id,
      name: p.name,
      x: num(p.pos.x),
      y: num(p.pos.y),
      z: num(p.pos.z),
      half,
      yMin,
      yMax,
      isHome,
    };
  });
}

export function isInsideBase(pos, regions) {
  const x = num(pos?.x, NaN);
  const y = num(pos?.y, NaN);
  const z = num(pos?.z, NaN);
  if (![x, y, z].every(Number.isFinite)) return false;
  return (regions || []).some(
    (r) =>
      Math.abs(x - r.x) <= r.half &&
      Math.abs(z - r.z) <= r.half &&
      y >= r.yMin && y <= r.yMax,
  );
}

export function luaRegions(regions) {
  const rows = (regions || []).map(
    (r) => `{ x=${r.x}, z=${r.z}, half=${r.half}, yMin=${r.yMin}, yMax=${r.yMax} }`,
  );
  return `{ ${rows.join(', ')} }`;
}

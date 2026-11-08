import { LUA_PRELUDE } from './prelude.mjs';

/**
 * scan_ground —— 只读探测若干列的地面高度（找"从上往下第一个非空气方块"）。
 *
 * 用途：建房子/放地基前确认地形——固定 y 建墙会在坡地出现"悬空/埋半截"；
 * 先用它量出每列地面高度，再算需要补的地基格子（用 place_build cells 补）。
 *
 * params:
 *   points  array [{x,z}]（必填；≤32 个，控制 Lua API 调用数）
 *   yStart  number = 66（从这一层往下探测）
 *   depth   number = 4（最多往下探几格，1~6）
 *
 * 返回：{ok:1, points:[{x,z,top}]}（top=该列最高非空气方块的 y；没探到 = -999）
 */
export default {
  id: 'scan_ground',
  title: '探测地面高度（只读）',
  params: {
    points: 'array [{x,z}]（必填，≤32）',
    yStart: 'number = 66',
    depth: 'number = 4',
  },
  meta: { gives: ['ground-heights'], risk: 'low', budgetMs: 60_000 },
  build(ctx, params = {}) {
    const pts = Array.isArray(params.points) ? params.points : [];
    const clean = pts
      .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z)))
      .slice(0, 32)
      .map((p) => ({ x: Math.floor(Number(p.x)), z: Math.floor(Number(p.z)) }));
    if (!clean.length) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 points 参数", "示例 points=[{x:-59,z:99}]")`,
        timeoutMs: 5000,
      };
    }
    const yStart = Math.floor(Number(params.yStart ?? 66)) || 66;
    const depth = Math.max(1, Math.min(6, Math.floor(Number(params.depth ?? 4)) || 4));
    const pointsLua = `{ ${clean.map((p) => `{ x = ${p.x}, z = ${p.z} }`).join(', ')} }`;

    const code = `${LUA_PRELUDE}
-- skill: scan_ground
local POINTS = ${pointsLua}
local YSTART = ${yStart}
local DEPTH = ${depth}

local ok, r = pcall(function()
  local parts = {}
  for _, p in ipairs(POINTS) do
    local top = -999
    for dy = 0, DEPTH do
      local y = YSTART - dy
      local b = numen.scan.block({ x = p.x, y = y, z = p.z })
      if b and b.is_air ~= true then
        top = y
        break
      end
    end
    parts[#parts + 1] = '{"x":' .. p.x .. ',"z":' .. p.z .. ',"top":' .. top .. '}'
  end
  return '{"ok":1,"points":[' .. table.concat(parts, ",") .. ']}'
end)
if not ok then return FAIL(r) end
return r
`;
    return { code, timeoutMs: 60_000 };
  },
};

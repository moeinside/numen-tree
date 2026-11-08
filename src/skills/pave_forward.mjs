import { LUA_PRELUDE } from './prelude.mjs';

/**
 * pave_forward —— 朝目标方向"直线推进"，走不通就垫方块（搭桥/垫台阶），不再依赖 mod 的
 * 长距离寻路（实测 go_to 遇山/沟会绕远、乱跳，甚至往反方向走）。
 *
 * 每段最多走 N 步（相邻 1 格），走不动就尝试：
 *   - 前方是空气、下方也是空气（沟）→ 在下方垫一块当桥，再走；
 *   - 前方脚部有方块（台阶/坡）→ 直接往上走一格；上不去就垫台阶再上。
 * 段间会先跑中断检查；没到就 partial 续派。
 *
 * params:
 *   target {x,y,z}（必填；只用 x/z 判到达，y 作为参考）
 *   item   string = minecraft:spruce_log（垫路方块；背包里要有）
 *   maxSteps number = 3（单段最多走几格）
 *   reach  number = 2.5（水平距离 ≤ 这个就算到达）
 *
 * 返回：arrived=true 或 partial=true + remaining + moved；完全走不动 → no_path/failed。
 * 注意：-- skill: pave_forward（回放识别标记）
 */
export default {
  id: 'pave_forward',
  title: '直线推进（走不通就垫方块）',
  params: {
    target: '{x,y,z}（必填）',
    item: 'string = minecraft:spruce_log',
    maxSteps: 'number = 3',
    reach: 'number = 2.5',
  },
  meta: { needs: ['block-item'], gives: ['moved'], risk: 'medium', budgetMs: 120_000 },
  build(ctx, params = {}) {
    const t = params.target || {};
    if (![t.x, t.y, t.z].every((v) => Number.isFinite(Number(v)))) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少/非法 target", "示例 target={x:-55,y:65,z:103}")`,
        timeoutMs: 5000,
      };
    }
    const item = (() => {
      const s = String(params.item ?? 'minecraft:spruce_log').trim();
      return s.includes(':') ? s : `minecraft:${s}`;
    })();
    const maxSteps = Math.max(1, Math.min(6, Math.floor(Number(params.maxSteps ?? 3)) || 3));
    const reach = Math.max(1, Math.min(8, Number(params.reach ?? 2.5) || 2.5));
    const code = `${LUA_PRELUDE}
-- skill: pave_forward
local TARGET = { x = ${Math.floor(Number(t.x))}, y = ${Math.floor(Number(t.y))}, z = ${Math.floor(Number(t.z))} }
local ITEM = '${item.replace(/'/g, "\\'")}'
local MAXSTEPS = ${maxSteps}
local REACH = ${reach}

local function isAir(p)
  local b = numen.scan.block(p)
  return b == nil or b.is_air == true
end
local function placeAt(p)
  return pcall(numen.build.place, { { name = ITEM, pos = p } })
end
local function walkTo(p)
  return pcall(numen.move.to, p, { arrive = "near" })
end

local ok, r = pcall(function()
  if (numen.inv.count(ITEM) or 0) <= 0 then
    error({ kind = "no_material", message = "背包里没有垫路方块 " .. ITEM })
  end
  local moved = 0
  local blocked = false
  for i = 1, MAXSTEPS do
    local me = numen.status.self().pos
    local dx, dz = TARGET.x - me.x, TARGET.z - me.z
    if (dx * dx + dz * dz) <= (REACH * REACH) then
      return { arrived = true, moved = moved, remaining = 0 }
    end
    local sx, sz = 0, 0
    if math.abs(dx) >= math.abs(dz) then
      sx = (dx > 0) and 1 or -1
    else
      sz = (dz > 0) and 1 or -1
    end
    local fy = math.floor(me.y)
    local fx = math.floor(me.x) + sx
    local fz = math.floor(me.z) + sz
    local feet = { x = fx, y = fy, z = fz }
    local below = { x = fx, y = fy - 1, z = fz }
    local above = { x = fx, y = fy + 1, z = fz }

    local stepOk = false
    if isAir(feet) then
      if isAir(below) then placeAt(below) end          -- 沟：垫桥
      stepOk = walkTo({ x = fx + 0.5, y = fy, z = fz + 0.5 })
    elseif isAir(above) then
      -- 脚前有方块：先试着直接上台阶；不行就垫一块再上
      stepOk = walkTo({ x = fx + 0.5, y = fy + 1, z = fz + 0.5 })
      if not stepOk then
        placeAt({ x = fx, y = fy, z = fz })
        stepOk = walkTo({ x = fx + 0.5, y = fy + 1, z = fz + 0.5 })
      end
    end
    if stepOk then
      moved = moved + 1
    else
      blocked = true
      break
    end
  end
  local me2 = numen.status.self().pos
  local ddx, ddz = TARGET.x - me2.x, TARGET.z - me2.z
  local remaining = math.sqrt(ddx * ddx + ddz * ddz)
  if remaining <= REACH then return { arrived = true, moved = moved, remaining = 0 } end
  return { arrived = false, moved = moved, remaining = remaining, blocked = blocked }
end)
if not ok then return FAIL(r) end
if r.arrived then
  return J({ { "arrived", "true" }, { "moved", N(r.moved) } })
end
return J({
  { "partial", "true" },
  { "moved", N(r.moved) },
  { "remaining", N(r.remaining) },
})
`;
    return { code, timeoutMs: 120_000 };
  },
};

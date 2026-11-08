import { LUA_PRELUDE, luaLiteral } from './prelude.mjs';

/**
 * place_block —— 放一个方块。
 *
 * params:
 *   item  string（必填，方块 id，如 minecraft:crafting_table；背包里要有）
 *   where string|object = "beside"（默认：脚边找一个空气+有支撑的格子）
 *                        | {x,y,z}（指定坐标）
 *
 * 只做一件小事：找位置 → 校验背包/目标格/支撑 → numen.build.place 放一块。
 * "放哪、什么时候放"由配方/大脑决定，不写在这里。
 */
export default {
  id: 'place_block',
  title: '放一个方块',
  params: {
    item: 'string（必填，方块 id）',
    where: 'string = beside | {x,y,z}',
  },
  meta: {
    needs: ['block-item', 'free-cell'],
    gives: ['placed-block'],
    risk: 'medium',
    budgetMs: 60_000,
  },
  build(ctx, params = {}) {
    const item = String(params.item || '');
    if (!item) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 item 参数", "示例 minecraft:crafting_table")`,
        timeoutMs: 5000,
      };
    }
    // 危险方块黑名单：岩浆/水/TNT/火/重生锚/末影水晶/床 之类默认禁放
    const blacklist = (ctx?.cfg?.build?.blockBlacklist || []).map((x) => String(x));
    if (blacklist.includes(item)) {
      return {
        code: `${LUA_PRELUDE}return F("denied", "这个方块在黑名单里，不能放：${item.replace(/'/g, "\\'")}", "危险方块（岩浆/水/TNT/火/床…）默认禁放；要改改 tree.config.json 的 build.blockBlacklist")`,
        timeoutMs: 5000,
      };
    }
    const where = params.where ?? 'beside';
    const whereLua =
      typeof where === 'string' && where !== 'beside'
        ? `'${where.replace(/'/g, "\\'")}'`
        : luaLiteral(where);

    const code = `${LUA_PRELUDE}
local ITEM = '${item.replace(/'/g, "\\'")}'
local WHERE = ${whereLua}

local function posOf(v)
  if type(v) == "table" and v.x and v.y and v.z then
    return { x = math.floor(v.x), y = math.floor(v.y), z = math.floor(v.z) }
  end
  return nil
end

-- 脚边候选格：只要求是空气（numen.build.place 不会替换占位方块）；
-- 支撑/贴不贴得上去交给 build.place 判断，失败就换下一个候选
local function besideCandidates()
  local me = numen.status.self().pos
  local x, y, z = math.floor(me.x), math.floor(me.y), math.floor(me.z)
  local dirs = { {1,0}, {-1,0}, {0,1}, {0,-1}, {1,1}, {-1,1}, {1,-1}, {-1,-1} }
  local out = {}
  for _, dy in ipairs({ 0, 1, -1 }) do
    for _, d in ipairs(dirs) do
      local cell = { x = x + d[1], y = y + dy, z = z + d[2] }
      local here = numen.scan.block(cell)
      if here and here.is_air == true then
        out[#out + 1] = cell
      end
    end
  end
  return out
end

local ok, r = pcall(function()
  local have = tonumber(numen.inv.count(ITEM)) or 0
  if have <= 0 then
    error({ kind = "no_material", message = "背包里没有 " .. ITEM })
  end

  -- 候选：显式坐标只有 1 个；"beside" 拿脚边一批空气格，逐个试
  local candidates = {}
  if type(WHERE) == "table" then
    local p = posOf(WHERE)
    if p then candidates[1] = p end
  elseif WHERE == "beside" or WHERE == nil then
    candidates = besideCandidates()
  end
  if #candidates == 0 then
    error({ kind = "not_found", message = "脚边找不到空气格可放" })
  end

  local lastErr = nil
  for i = 1, math.min(#candidates, 8) do
    local cell = candidates[i]
    local here = numen.scan.block(cell)
    if here and here.is_air == true then
      local okp, err = pcall(function()
        return numen.build.place({ { name = ITEM, pos = cell } })
      end)
      local after = tonumber(numen.inv.count(ITEM)) or 0
      if okp and after < have then
        local left = 0
        if type(err) == "table" then left = tonumber(err.left) or 0 else left = tonumber(err) or 0 end
        return { before = have, after = after, left = left, pos = cell }
      end
      if not okp and type(err) == "table" then
        lastErr = tostring(err.message or err.kind or "")
      end
    end
  end
  error({ kind = "not_found", message = "脚边试了 " .. math.min(#candidates, 8) .. " 个格子都放不上", hint = lastErr or "" })
end)
if not ok then return FAIL(r) end

if r.before == r.after then
  return F("denied", "方块没有放下去", "目标格被占/无支撑/没权限")
end
return J({
  { "item", S(ITEM) },
  { "placed", N(r.before - r.after) },
  { "left", N(r.left) },
  { "x", N(r.pos.x) }, { "y", N(r.pos.y) }, { "z", N(r.pos.z) },
})
`;
    return { code, timeoutMs: 60_000 };
  },
};

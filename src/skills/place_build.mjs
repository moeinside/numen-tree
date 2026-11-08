import { LUA_PRELUDE, luaLiteral } from './prelude.mjs';

/**
 * place_build —— 一次放多块方块（一排 / 一面墙 / 指定格子列表）。
 *
 * mod 的 `numen.build.place(cells)` 接受一串 {name,pos}，所以多块放在**一次 API 调用**里完成，
 * 不会撞 200 次 Lua API 上限。
 *
 * params:
 *   item      string（必填，方块 id；背包里有多少就放多少）
 *   shape     string = 'line' | 'wall' | 'cells'（默认 line）
 *   anchor    string|object = 'beside'（默认，从脚边开始）| {x,y,z}
 *   direction string = 'north' | 'south' | 'east' | 'west'（默认 north = z-1）
 *   length    number = 4  （line/wall 的长度）
 *   height    number = 2  （wall 的高度）
 *   maxBlocks number = 64 （安全上限，一次最多放多少）
 *   cells     array      （shape='cells' 时显式给 [{x,y,z}, ...]）
 */
export default {
  id: 'place_build',
  title: '连续放方块（一排 / 墙 / 指定格子）',
  params: {
    item: 'string（必填，方块 id）',
    shape: "string = line | wall | cells",
    anchor: "string = beside | {x,y,z}",
    direction: "string = north | south | east | west",
    length: 'number = 4',
    height: 'number = 2',
    maxBlocks: 'number = 64',
    cells: 'array（shape=cells 时用）',
  },
  meta: {
    needs: ['block-item', 'free-space'],
    gives: ['placed-blocks'],
    risk: 'medium',
    budgetMs: 120_000,
  },
  build(ctx, params = {}) {
    const item = String(params.item || '');
    if (!item) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 item 参数", "示例 minecraft:oak_planks")`,
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
    const shape = String(params.shape || 'line');
    const direction = String(params.direction || 'north');
    const length = Math.max(1, Math.min(128, Number(params.length ?? 4)));
    const height = Math.max(1, Math.min(16, Number(params.height ?? 2)));
    const cfgMax = Number(ctx?.cfg?.build?.maxBlocks ?? 64);
    const maxBlocks = Math.max(1, Math.min(cfgMax, Number(params.maxBlocks ?? cfgMax)));
    const anchor = params.anchor ?? 'beside';
    const anchorLua =
      typeof anchor === 'string' && anchor !== 'beside'
        ? `'${anchor.replace(/'/g, "\\'")}'`
        : luaLiteral(anchor);
    const cellsLua = Array.isArray(params.cells) ? luaLiteral(params.cells) : 'nil';

    const code = `${LUA_PRELUDE}
local ITEM = '${item.replace(/'/g, "\\'")}'
local SHAPE = '${shape.replace(/'/g, "\\'")}'
local DIR = '${direction.replace(/'/g, "\\'")}'
local LEN = ${length}
local HEIGHT = ${height}
local MAXB = ${maxBlocks}
local ANCHOR = ${anchorLua}
local CELLS = ${cellsLua}

local function floorOf(v)
  if type(v) == "table" and v.x and v.y and v.z then
    return { x = math.floor(v.x), y = math.floor(v.y), z = math.floor(v.z) }
  end
  return nil
end

-- 脚边候选：只要求空气（build.place 不会替换占位方块），支撑交给 mod 判断
local function besideCell()
  local me = numen.status.self().pos
  local x, y, z = math.floor(me.x), math.floor(me.y), math.floor(me.z)
  local dirs = { {1,0}, {-1,0}, {0,1}, {0,-1}, {1,1}, {-1,1}, {1,-1}, {-1,-1} }
  for _, dy in ipairs({ 0, 1, -1 }) do
    for _, d in ipairs(dirs) do
      local cell = { x = x + d[1], y = y + dy, z = z + d[2] }
      local here = numen.scan.block(cell)
      if here and here.is_air == true then return cell end
    end
  end
  return nil
end

local function dirDelta(d)
  if d == "east" then return 1, 0 end
  if d == "west" then return -1, 0 end
  if d == "south" then return 0, 1 end
  return 0, -1 -- north 默认
end

local ok, r = pcall(function()
  local have = tonumber(numen.inv.count(ITEM)) or 0
  if have <= 0 then
    error({ kind = "no_material", message = "背包里没有 " .. ITEM })
  end

  local cells = {}
  if SHAPE == "cells" and type(CELLS) == "table" then
    for _, c in ipairs(CELLS) do
      local p = floorOf(c)
      if p then cells[#cells + 1] = p end
    end
  else
    local anchorCell = nil
    if type(ANCHOR) == "table" then anchorCell = floorOf(ANCHOR) end
    if anchorCell == nil then anchorCell = besideCell() end
    if anchorCell == nil then
      error({ kind = "not_found", message = "找不到起点格" })
    end
    local dx, dz = dirDelta(DIR)
    if SHAPE == "wall" then
      for h = 0, HEIGHT - 1 do
        for i = 0, LEN - 1 do
          cells[#cells + 1] = { x = anchorCell.x + dx * i, y = anchorCell.y + h, z = anchorCell.z + dz * i }
        end
      end
    else -- line
      for i = 0, LEN - 1 do
        cells[#cells + 1] = { x = anchorCell.x + dx * i, y = anchorCell.y, z = anchorCell.z + dz * i }
      end
    end
  end

  if #cells == 0 then
    error({ kind = "bad_argument", message = "没有可放置的格子" })
  end

  -- 跳过非空气格（前 48 个做检查，避免 Lua API 调用过多）
  local filtered, skipped = {}, 0
  for i, c in ipairs(cells) do
    if i > 48 then
      filtered[#filtered + 1] = c
    else
      local here = numen.scan.block(c)
      if here and here.is_air == true then
        filtered[#filtered + 1] = c
      else
        skipped = skipped + 1
      end
    end
  end
  cells = filtered
  if #cells == 0 then
    error({ kind = "not_found", message = "可放置的格子都被占住了（被挡 " .. skipped .. " 格）" })
  end

  -- 上限 + 背包数量
  local wanted = #cells
  if wanted > MAXB then wanted = MAXB end
  local batch = {}
  for i = 1, wanted do batch[#batch + 1] = cells[i] end
  if #batch > have then
    local trimmed = {}
    for i = 1, have do trimmed[#trimmed + 1] = batch[i] end
    batch = trimmed
  end
  if #batch == 0 then
    error({ kind = "no_material", message = "背包里的 " .. ITEM .. " 不够放" })
  end

  local list = {}
  for _, c in ipairs(batch) do
    list[#list + 1] = { name = ITEM, pos = c }
  end
  local out = numen.build.place(list)
  local left = tonumber(out and out.left) or 0
  local after = tonumber(numen.inv.count(ITEM)) or 0
  return { before = have, after = after, left = left, wanted = wanted, cells = #batch }
end)
if not ok then return FAIL(r) end

local placed = r.before - r.after
if placed <= 0 then
  return F("denied", "方块没有放下去（left=" .. tostring(r.left) .. "）", "检查目标格是否被占/无支撑/背包够不够")
end
return J({
  { "item", S(ITEM) },
  { "placed", N(placed) },
  { "wanted", N(r.wanted) },
  { "left", N(r.left) },
})
`;
    return { code, timeoutMs: 120_000 };
  },
};

import { LUA_PRELUDE, luaLiteral } from './prelude.mjs';

/**
 * store_items —— 找最近的箱子/木桶，走过去打开，把背包里的指定物品放进去。
 *
 * 流程（全部都包在 pcall 里，失败带 kind）：
 *   1) scan.blocks({chest, trapped_chest, barrel}, {radius}) 找最近容器；
 *      数组形式不被支持时退化成逐个 id 扫（最多 4 次 API 调用）；
 *   2) move.to(at, {arrive="use"}) → use.block(at) 开窗；拿不到 w/w.slots 算 not_found；
 *   3) w:put(item, count)（count 省略 = 全部）；失败转 numen.gui.put；再失败报 failed 并带原文；
 *   4) 无论成败都 pcall(gui.close)（开过窗口才关）；
 *   5) 返回 {"ok":1,"moved":N,"chest":{x,y,z},"kept":M}，kept = 背包前后数量差。
 *
 * 纪律（docs/12 §5、docs/10 §12）：
 *  - 不用 numen.task.timer（URGENT 事件会打断程序）；
 *  - 单次程序 API 调用数很小（扫描 ≤4、inv.count 2、move/use/put/close 各 1）；
 *  - 元数据：needs container / gives stored / risk low / budgetMs 120000。
 *
 * params:
 *   item   string（必填，如 minecraft:oak_log；不带命名空间会补 minecraft:）
 *   count  number（可选；默认全部）
 *   radius number = 24（找容器的半径）
 */
export default {
  id: 'store_items',
  title: '把东西存进箱子',
  params: {
    item: 'string（必填，如 minecraft:oak_log）',
    count: 'number（可选，默认全部）',
    radius: 'number = 24',
  },
  meta: { needs: ['container'], gives: ['stored'], risk: 'low', budgetMs: 120_000 },
  build(ctx, params = {}) {
    const rawItem = params.item == null ? '' : String(params.item).trim();
    if (!rawItem) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 item 参数", "示例 minecraft:oak_log")`,
        timeoutMs: 5000,
      };
    }
    const item = rawItem.includes(':') ? rawItem : `minecraft:${rawItem}`;
    let count = null;
    if (params.count != null && params.count !== '') {
      const n = Math.floor(Number(params.count));
      count = Number.isFinite(n) && n > 0 ? n : null;
    }
    const radius = Math.min(64, Math.max(4, Math.floor(Number(params.radius ?? 24)) || 24));

    const code = `${LUA_PRELUDE}
local ITEM = ${luaLiteral(item)}
local WANT = ${count == null ? 'nil' : String(count)}
local RADIUS = ${radius}
local CHESTS = { "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel" }

-- 从 scan.blocks 的返回里取最近的一格坐标（Cluster.nearest / blocks[1]，或本身就是 Block）
local function firstPos(found)
  if type(found) ~= "table" or #found == 0 then return nil end
  local cluster = found[1]
  local at = cluster and (cluster.nearest or (cluster.blocks and cluster.blocks[1]))
  if at == nil then at = cluster end
  if type(at) ~= "table" then return nil end
  local p = at.pos or at
  if type(p) ~= "table" or p.x == nil or p.y == nil or p.z == nil then return nil end
  return { x = p.x, y = p.y, z = p.z }
end

-- 一次扫三种容器 id；数组形式不被支持（或没扫到）再逐个 id 退路扫一遍
local function findContainer(r)
  local ok, found = pcall(numen.scan.blocks, CHESTS, { radius = r })
  if ok then
    local at = firstPos(found)
    if at ~= nil then return at end
  end
  for _, cid in ipairs(CHESTS) do
    local ok2, found2 = pcall(numen.scan.blocks, cid, { radius = r })
    if ok2 then
      local at = firstPos(found2)
      if at ~= nil then return at end
    end
  end
  return nil
end

local opened = false
local ok, r = pcall(function()
  if ITEM == nil or ITEM == "" then
    error({ kind = "bad_argument", message = "item is required", hint = "示例 minecraft:oak_log" })
  end
  local at = findContainer(RADIUS)
  if at == nil then
    error({ kind = "not_found", message = "no chest/barrel within " .. tostring(RADIUS) .. " blocks",
      hint = "换个地方找，或先 craft(chest) 做一个箱子" })
  end
  local before = numen.inv.count(ITEM)
  if before <= 0 then
    -- 背包里没有可存的东西：这是"这一步做不了"，不是"没有箱子"——
    -- 用 failed 而不是 not_found，免得配方把它当成"没箱子"去 craft(chest)。
    error({ kind = "failed", message = "nothing to store: no " .. ITEM .. " in inventory",
      hint = "先挖/捡到 " .. ITEM })
  end
  numen.move.to(at, { arrive = "use" })
  -- use.block 打不开时会 raise，这里统一折成 not_found（配方才能走"先做个箱子"的替代分支）
  local useOk, useRes = pcall(numen.use.block, at)
  local w = useOk and useRes or nil
  if not useOk or not w or not w.slots or #w.slots == 0 then
    error({ kind = "not_found", message = "container at target did not open a window: "
        .. tostring(useOk and "no window slots" or useRes),
      hint = "右键没开成：可能被方块挡住，或那不是容器" })
  end
  opened = true
  -- 主路径：inv.lua 的 w:put(item, count)；没有该方法再退到 numen.gui.put
  local putOk, putRes = pcall(function()
    if type(w.put) == "function" then
      if WANT ~= nil then return w:put(ITEM, WANT) end
      return w:put(ITEM)
    end
    if WANT ~= nil then return numen.gui.put(ITEM, WANT) end
    return numen.gui.put(ITEM)
  end)
  if not putOk then
    error({ kind = "failed", message = "put failed: " .. tostring(putRes),
      hint = "容器满了 / 物品不可放入 / 窗口中途关闭" })
  end
  return { at = at, before = before, moved = tonumber(putRes) or 0 }
end)

-- 关窗：开过窗口才关（close 对没开的窗口返回 false，不会出错）
if opened then pcall(numen.gui.close) end
if not ok then return FAIL(r) end

-- 背包前后差 = 没存进去的（count 读不到就退回 before - moved 估）
local cntOk, after = pcall(numen.inv.count, ITEM)
if not cntOk or type(after) ~= "number" then after = r.before - r.moved end
local kept = r.before - after
if kept < 0 then kept = 0 end
return J({
  { "moved", N(r.moved) },
  { "chest", '{"x":' .. N(r.at.x) .. ',"y":' .. N(r.at.y) .. ',"z":' .. N(r.at.z) .. '}' },
  { "kept", N(kept) },
})
`;
    return { code, timeoutMs: 120_000 };
  },
};

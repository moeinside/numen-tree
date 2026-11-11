import { LUA_PRELUDE, luaLiteral } from './prelude.mjs';

/**
 * fetch_items —— 找最近的箱子/木桶，走过去打开，把里面的指定物品取到背包（store_items 的镜像）。
 *
 * 流程（全部都包在 pcall 里，失败带 kind）：
 *   1) scan.blocks({chest, trapped_chest, barrel}, {radius}) 找容器，最多取 3 个不同坐标；
 *      数组形式不被支持/不够 3 个时退化成逐个 id 扫（最多 4 次 API 调用）；
 *   2) 逐个容器：move.to(at, {arrive="use"}) → use.block(at) 开窗；
 *   3) 容器侧数量先看 w:count，没有该方法退 numen.gui.count；
 *      有货就 w:take(item, count)，没有该方法退 numen.gui.take；
 *   4) 最近的容器没货（或没取够 count）就换下一个容器，最多试 3 个；
 *   5) 无论成败都 pcall(gui.close)（开过窗口才关，换容器前先关）；
 *   6) 返回 {"ok":1,"got":N,"chest":{x,y,z},"item":"...","left":N}，
 *      got 以背包前后差为准（读不到退回 take 自报数），left = 还想拿但没拿到的数量。
 *
 * 纪律（docs/12 §5、docs/10 §12）：
 *  - 不用 numen.task.timer（URGENT 事件会打断程序）；
 *  - 单次程序 API 调用数很小（扫描 ≤4、inv.count 2、每个容器 move/use/count/take/close 各 1，最多 3 个容器）；
 *  - 元数据：needs container / gives item / risk low / budgetMs 120000。
 *
 * params:
 *   item   string（必填，如 minecraft:oak_log；不带命名空间会补 minecraft:）
 *   count  number（可选；默认全部可取）
 *   radius number = 24（找容器的半径，4~64）
 */
export default {
  id: 'fetch_items',
  title: '从箱子取东西',
  params: {
    item: 'string（必填，如 minecraft:oak_log）',
    count: 'number（可选，默认全部可取）',
    radius: 'number = 24',
  },
  meta: { needs: ['container'], gives: ['item'], risk: 'low', budgetMs: 120_000 },
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
local MAX_TRY = 3
local CHESTS = { "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel" }

-- 坐标归一化：Cluster.nearest / blocks[i] / Block 自身，统一成 {x,y,z}
local function posOf(at)
  if type(at) ~= "table" then return nil end
  local p = at.pos or at
  if type(p) ~= "table" or p.x == nil or p.y == nil or p.z == nil then return nil end
  return { x = p.x, y = p.y, z = p.z }
end

local function addPos(out, seen, at)
  if at == nil then return end
  local k = at.x .. "," .. at.y .. "," .. at.z
  if seen[k] then return end
  seen[k] = true
  out[#out + 1] = at
end

-- 把一个 scan.blocks 返回（Cluster[]）里的容器坐标按"簇内由近到远"追加，最多 MAX_TRY 个
local function collect(out, seen, found)
  if type(found) ~= "table" then return end
  for _, cluster in ipairs(found) do
    local nearest, blocks = nil, nil
    if type(cluster) == "table" then
      nearest = cluster.nearest
      blocks = cluster.blocks
    end
    if nearest == nil then nearest = cluster end
    addPos(out, seen, posOf(nearest))
    if #out >= MAX_TRY then return end
    if type(blocks) == "table" then
      for _, b in ipairs(blocks) do
        addPos(out, seen, posOf(b))
        if #out >= MAX_TRY then return end
      end
    end
  end
end

-- 一次扫三种容器 id；数组形式不被支持（或没凑够 3 个候选）再逐个 id 退路扫
local function findContainers(r)
  local out, seen = {}, {}
  local ok, found = pcall(numen.scan.blocks, CHESTS, { radius = r })
  if ok then collect(out, seen, found) end
  if #out < MAX_TRY then
    for _, cid in ipairs(CHESTS) do
      if #out >= MAX_TRY then break end
      local ok2, found2 = pcall(numen.scan.blocks, cid, { radius = r })
      if ok2 then collect(out, seen, found2) end
    end
  end
  return out
end

local opened = false      -- 当前是否开着窗口（保证每条路径都能关）
local openedAny = false   -- 是否成功开过至少一个窗口
local takenAt = nil       -- 真正取到东西的容器
local taken = 0           -- take 自报的个数（背包前后差读不到时兜底）
local sawItem = false     -- 是否有容器里确实有该物品
local takeFail = nil      -- 取失败原文
local openFails = {}      -- 开窗/移动失败原文（失败时带出去）
local alreadyHave = false

local ok, r = pcall(function()
  if ITEM == nil or ITEM == "" then
    error({ kind = "bad_argument", message = "item is required", hint = "示例 minecraft:oak_log" })
  end
  local have = numen.inv.count(ITEM)
  if type(have) == "number" and have > 0 and (WANT == nil or have >= WANT) then
    alreadyHave = true
    return { before = have }
  end
  local ats = findContainers(RADIUS)
  if #ats == 0 then
    error({ kind = "not_found", message = "no chest/barrel within " .. tostring(RADIUS) .. " blocks",
      hint = "换个地方找，或先 craft(chest) 做一个箱子" })
  end

  -- 背包基线：取完后用前后差算实际进包数量（比 take 自报更可靠）
  local bOk, before = pcall(numen.inv.count, ITEM)
  if not bOk or type(before) ~= "number" then before = 0 end

  -- 开箱：准星被挡时不要长时间挖墙，直接返回 chest_blocked，让树短报玩家清理
  local function openAt(at)
    local useOk, useRes = pcall(numen.use.block, at)
    if not useOk then return nil, tostring(useRes) end
    if type(useRes) == "table" and useRes.slots and #useRes.slots > 0 then
      return useRes, nil
    end
    local bp = type(useRes) == "table" and useRes.block and useRes.block.pos or nil
    if bp then
      return nil, string.format("chest_blocked at %d,%d,%d", bp.x, bp.y, bp.z)
    end
    return nil, "no window slots"
  end

  for _, at in ipairs(ats) do
    -- 指定了 count 且已经取够，就不用再开下一个容器
    if WANT ~= nil and taken >= WANT then break end

    -- 每换一个容器都要重新开窗；移动失败也记下来，换下一个容器
    local mvOk, mvRes = pcall(numen.move.to, at, { arrive = "use" })
    local w, openErr = nil, nil
    if not mvOk then
      openErr = "move: " .. tostring(mvRes)
    else
      w, openErr = openAt(at)
    end

    if openErr ~= nil then
      -- 自研开窗失败（常见：准星被挡/no window slots）→ 退 numen.inv.fetch 原生“走近+开箱+取出+关箱”
      local fOk, fRes = pcall(numen.inv.fetch, at, ITEM, WANT)
      local got = fOk and (tonumber(fRes) or 0) or 0
      if got > 0 then
        taken = taken + got
        sawItem = true
        opened = true
        openedAny = true
        takenAt = at
        break
      end
      openFails[#openFails + 1] = openErr
    else
      opened = true
      openedAny = true
      -- 容器侧数量：Window 有 count 就用 w:count，否则退 numen.gui.count（都是"容器侧"）
      local avail = 0
      local cOk, cRes = pcall(function()
        if type(w.count) == "function" then return w:count(ITEM) end
        return nil
      end)
      if cOk and type(cRes) == "number" then
        avail = cRes
      else
        local gOk, gRes = pcall(numen.gui.count, ITEM)
        if gOk and type(gRes) == "number" then avail = gRes end
      end

      if avail > 0 then
        sawItem = true
        local want = nil
        if WANT ~= nil then want = WANT - taken end
        local tOk, tRes = pcall(function()
          if type(w.take) == "function" then
            if want ~= nil then return w:take(ITEM, want) end
            return w:take(ITEM)
          end
          if want ~= nil then return numen.gui.take(ITEM, want) end
          return numen.gui.take(ITEM)
        end)
        if not tOk then
          takeFail = tostring(tRes)
        else
          local n = tonumber(tRes) or 0
          if n > 0 then
            taken = taken + n
            takenAt = at
            -- 没指定 count = 全部可取：这个容器拿空了就收工
            if WANT == nil then
              pcall(numen.gui.close)
              opened = false
              break
            end
          end
        end
      end
    end

    -- 无论本容器成败都关窗（没开过时 close 返回 false，不报错；换容器前必须关）
    if opened then
      pcall(numen.gui.close)
      opened = false
    end
  end

  -- 兜底关窗（循环里 break 时可能还开着）
  if opened then
    pcall(numen.gui.close)
    opened = false
  end

  if takenAt == nil then
    if takeFail ~= nil then
      error({ kind = "failed", message = "take failed: " .. takeFail,
        hint = "背包满 / 物品不可取 / 窗口中途关闭" })
    end
    if #openFails > 0 and not openedAny then
      error({ kind = "failed", message = "container did not open: " .. table.concat(openFails, " | "),
        hint = "右键没开成：可能被方块挡住，或那不是容器" })
    end
    if sawItem then
      error({ kind = "failed", message = "container has " .. ITEM .. " but take returned 0",
        hint = "背包满或窗口中途关闭" })
    end
    error({ kind = "not_found", message = "no " .. ITEM .. " in nearby container(s)",
      hint = "容器里确实没有：先确认箱子里有货，或扩大 radius" })
  end
  return { before = before }
end)

-- 关窗收尾（正常路径已经关过，这里只兜底；close 对没开的窗口返回 false，不会出错）
if opened then pcall(numen.gui.close) end
if not ok then return FAIL(r) end
if alreadyHave then
  return J({
    { "got", N(0) },
    { "item", S(ITEM) },
    { "left", N(0) },
    { "already", "true" },
  })
end

-- 实际进包数量以背包前后差为准；读不到就退回 take 自报的个数
local aOk, after = pcall(numen.inv.count, ITEM)
if not aOk or type(after) ~= "number" then after = r.before + taken end
local got = after - r.before
if got < 0 then got = 0 end
if got < taken then got = taken end
local left = 0
if WANT ~= nil and WANT > got then left = WANT - got end
return J({
  { "got", N(got) },
  { "chest", '{"x":' .. N(takenAt.x) .. ',"y":' .. N(takenAt.y) .. ',"z":' .. N(takenAt.z) .. '}' },
  { "item", S(ITEM) },
  { "left", N(left) },
})
`;
    return { code, timeoutMs: 120_000 };
  },
};

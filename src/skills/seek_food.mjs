import { LUA_PRELUDE } from './prelude.mjs';

/**
 * seek_food —— 附近没吃的、也没猎物时的"找吃行动"：
 *   1) 扫附近 24 格内的箱子/木桶，走过去开箱，把里面的食物全拿走；
 *   2) 都没找到（或箱子里没食物）就朝一个方向探索一段，去撞生物群系。
 *
 * 纪律（两次实机教训）：
 *  - 沙箱对每次程序有 **200 次 Lua API 调用上限**，热循环里不能反复调 numen.*；
 *  - `numen.task.timer` 的定时器触发的是**紧急事件，会打断当前程序**，不能当进度上报用。
 *  ⇒ 预算一律用"固定次数的小段循环"表达，不用墙钟、不用 timer。
 *
 * params:
 *   radius  number = 24  找箱子的半径
 *   seconds number = 40  探索走多久（按 8 秒一段切成固定段数）
 */
export default {
  id: 'seek_food',
  title: '找食物（搜箱子 / 探索）',
  params: { radius: 'number = 24', seconds: 'number = 40', maxRoam: 'number = 48' },
  build(ctx, params = {}) {
    const radius = Math.max(8, Number(params.radius ?? 24));
    const seconds = Math.min(120, Math.max(8, Number(params.seconds ?? 40)));
    const chunks = Math.max(1, Math.min(12, Math.round(seconds / 8))); // 固定段数，调用数有界
    // 找吃的也不许跑离主人太远：每走一小段就量一次和主人的距离，超了就掉头
    const maxRoam = Math.max(16, Number(params.maxRoam ?? 48));

    const code = `${LUA_PRELUDE}
local FOODS = {
  bread = 1, apple = 1, carrot = 1, potato = 1, baked_potato = 1, beetroot = 1,
  beetroot_soup = 1, mushroom_stew = 1, rabbit_stew = 1, melon_slice = 1,
  sweet_berries = 1, glow_berries = 1, pumpkin_pie = 1, cookie = 1,
  golden_apple = 1, enchanted_golden_apple = 1, dried_kelp = 1, honey_bottle = 1,
  cooked_beef = 1, cooked_porkchop = 1, cooked_chicken = 1, cooked_mutton = 1,
  cooked_rabbit = 1, cooked_cod = 1, cooked_salmon = 1,
  beef = 1, porkchop = 1, chicken = 1, mutton = 1, rabbit = 1, cod = 1, salmon = 1,
  rotten_flesh = 1,
}
local CHESTS = { "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel" }

local function foodInBag()
  local n = 0
  for _, it in ipairs(numen.inv.items() or {}) do
    local name = tostring(it.item or it.id or it.name or "")
    local short = name:match("([%w_]+)$") or name
    if FOODS[short] then n = n + (tonumber(it.count or it.n) or 1) end
  end
  return n
end

local function findChest(r)
  for _, cid in ipairs(CHESTS) do
    local ok, found = pcall(numen.scan.blocks, cid, { radius = r })
    if ok and type(found) == "table" and #found > 0 then
      if found[1].nearest then return found[1].nearest end
      if found[1].blocks and found[1].blocks[1] then return found[1].blocks[1] end
    end
  end
  return nil
end

local ok, r = pcall(function()
  local before = foodInBag()
  local found_chest, explored = false, 0

  local at = findChest(${radius})
  if at then
    found_chest = true
    numen.move.to(at, { arrive = "use" })
    local w = numen.use.block(at)
    if w and w.slots then
      for _, s in ipairs(w.slots) do
        local name = tostring(s.item or "")
        local short = name:match("([%w_]+)$") or name
        if FOODS[short] and (tonumber(s.count) or 0) > 0 then
          pcall(numen.gui.quick, s.index)
        end
      end
    end
    pcall(numen.gui.close)
  end

  local after_chest = foodInBag()
  local lastErr = nil
  if after_chest <= before then
    -- 没箱子 / 箱子里没吃的：分小段出去走，撞生物群系；每段后检查离主人多远
    local dirs = { "north", "south", "east", "west" }
    local dir = dirs[math.random(#dirs)]
    for _ = 1, ${chunks} do
      local okd, od = pcall(function() return numen.status.owner().distance end)
      if okd and od and od > ${maxRoam} then
        lastErr = "距离主人 " .. tostring(math.floor(od)) .. " 格，超过 " .. ${maxRoam} .. "，停止外探"
        break
      end
      -- until_ 必须给：move.explore 每跳后会调用它，不给会直接报错
      local okc, errc = pcall(numen.move.explore, dir, {
        seconds = 6,
        hop = 12,
        until_ = function() return nil end,
      })
      if okc then
        explored = explored + 6
      elseif lastErr == nil then
        lastErr = tostring(errc)
      end
    end
  end
  return {
    food_before = before,
    food = foodInBag(),
    chest = found_chest,
    explored = explored,
    err = lastErr,
  }
end)
if not ok then return FAIL(r) end
if r.food <= r.food_before and r.explored == 0 then
  return F("failed", "找不到食物也走不动：" .. tostring(r.err or "explore 没有产生位移"),
    "检查是否被卡住/被围；下一轮换个方向")
end
return J({
  { "food_before", N(r.food_before) },
  { "food", N(r.food) },
  { "chest", r.chest and "true" or "false" },
  { "explored_s", N(r.explored) },
})
`;
    return { code, timeoutMs: (seconds + 90) * 1000 };
  },
};

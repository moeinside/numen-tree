import { LUA_PRELUDE } from './prelude.mjs';

/**
 * fish_once —— 长动作：找/打开水域 → 手持钓竿 → 抛竿钓鱼。
 *
 * 为什么是技能而不是原子：numen.work.fish() 会等咬钩，可能十几秒到几十秒，
 * 超过原子 15s 上限；必须走长动作协议（预算/超时/事后 settle）。
 *
 * params:
 *   count  number = 1（最多 3 次抛竿）
 *   radius number = 32（找水/冰的半径）
 *   item   string = minecraft:fishing_rod
 */
export default {
  id: 'fish_once',
  title: '钓鱼（长动作：找水/破冰/抛竿/收杆）',
  params: {
    count: 'number = 1（最多 3）',
    radius: 'number = 32',
    item: 'string = minecraft:fishing_rod',
  },
  meta: { needs: ['water', 'fishing_rod'], gives: ['fish'], risk: 'low', budgetMs: 180_000 },
  build(ctx, params = {}) {
    const count = Math.min(3, Math.max(1, Math.floor(Number(params.count ?? 1)) || 1));
    const radius = Math.min(48, Math.max(8, Math.floor(Number(params.radius ?? 32)) || 32));
    const rod = String(params.item || 'minecraft:fishing_rod').trim();
    const safeRod = rod.replace(/'/g, "\\'");
    const code = `${LUA_PRELUDE}
local ROD = '${safeRod}'
local COUNT = ${count}
local RADIUS = ${radius}

local function cnt(item)
  local ok, v = pcall(numen.inv.count, item)
  if not ok then return 0 end
  return tonumber(v) or 0
end

local function blockAt(p)
  local ok, b = pcall(numen.scan.block, { x = p.x, y = p.y, z = p.z })
  if not ok then return nil end
  return b
end

-- 在 water 簇里找一个“水面”：优先开放水（上方空气），其次冰面（需镐）
local function findSurface()
  local ok, clusters = pcall(numen.scan.blocks, "minecraft:water", { radius = RADIUS })
  if not ok or type(clusters) ~= "table" then return nil, nil end
  local iceAt = nil
  local inspected = 0
  for _, c in ipairs(clusters) do
    local blocks = c.blocks or { c.nearest }
    for _, b in ipairs(blocks) do
      if inspected >= 48 then break end
      inspected = inspected + 1
      local p = b and (b.pos or b)
      if p and p.x and p.y and p.z then
        local above = blockAt({ x = p.x, y = p.y + 1, z = p.z })
        if above then
          if above.air then return { x = p.x, y = p.y, z = p.z }, false end
          local n = tostring(above.name or "")
          if not iceAt and (n == "minecraft:ice" or n == "minecraft:frosted_ice"
            or n == "minecraft:packed_ice" or n == "minecraft:blue_ice") then
            iceAt = { x = p.x, y = p.y, z = p.z }
          end
        end
      end
    end
    if inspected >= 48 then break end
  end
  if iceAt then return iceAt, true end
  return nil, nil
end

local function pickName()
  for _, name in ipairs({
    "minecraft:wooden_pickaxe", "minecraft:stone_pickaxe", "minecraft:iron_pickaxe",
    "minecraft:golden_pickaxe", "minecraft:diamond_pickaxe", "minecraft:netherite_pickaxe",
  }) do
    if cnt(name) > 0 then return name end
  end
  return nil
end
if cnt(ROD) <= 0 then
  error({ kind = "no_rod", message = "背包里没有钓竿", hint = "先 craft 钓竿（木棍+线）" })
end
pcall(numen.gear.hold, ROD)

local at, ice = findSurface()
if at == nil then
  error({ kind = "no_water", message = "附近没有可钓的水面", hint = "找河流/湖泊，或破开冰面" })
end
-- 先走到水边！注意目标用“水块 + arrive=near”，不要站到冰面/水面上；
-- 否则会站在要破的冰上，numen 拒绝挖脚下方块。
local nearTarget = { x = at.x, y = at.y, z = at.z }
local moved = false
for _, opt in ipairs({ { arrive = "near" }, { arrive = "use" } }) do
  local okMove = pcall(numen.move.to, nearTarget, opt)
  if okMove then moved = true; break end
end
if not moved then
  pcall(numen.move.to, { x = at.x, y = at.y + 1, z = at.z }, { arrive = "near" })
end
if ice then
  -- 破冰：先换镐（有的话），再 dig/连点；最后换回钓竿
  local iceCell = { x = at.x, y = at.y + 1, z = at.z }
  local pick = pickName()
  if pick then pcall(numen.gear.hold, pick) end
  pcall(numen.work.dig, iceCell, { count = 1 })
  for _ = 1, 8 do
    pcall(numen.use.hit, iceCell)
  end
  pcall(numen.work.collect, { radius = 4 })
  pcall(numen.gear.hold, ROD)
end

local caught = {}
for i = 1, COUNT do
  local ok, res = pcall(numen.work.fish)
  if not ok then
    error({ kind = "fish_failed", message = "钓鱼失败：" .. tostring(res),
      hint = "可能没水/冰面/钓竿没拿/被挡住" })
  end
  if type(res) == "table" then
    for _, it in ipairs(res) do
      if it ~= nil and tostring(it) ~= "" then caught[#caught + 1] = tostring(it) end
    end
  elseif res ~= nil and tostring(res) ~= "" then
    caught[#caught + 1] = tostring(res)
  end
end

return J({
  { "ok", "true" },
  { "caught", N(#caught) },
  { "items", S(table.concat(caught, ",")) },
  { "water", at and S(at.x .. "," .. at.y .. "," .. at.z) or "null" },
  { "ice", ice and "true" or "false" },
})
`;
    return { code, timeoutMs: (count * 70 + 40) * 1000 };
  },
};

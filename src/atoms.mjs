/**
 * 原子动作注册表（tree 的"最底层一步"）。
 *
 * 纪律（docs/19）：
 *  - 一个原子 = 一次 Lua 程序，必须几秒内返回；超过 15s 的一律不许当原子。
 *  - 共享执行壳：统一 prelude / 参数安全注入 / 结构化回执 / 超时。
 *    build(params) 只返回 Lua（引用已校验过的变量），不在外面拼任意代码。
 *  - 原子不认识战术包/计划，只做一件事；调度器负责编排。
 */
import { LUA_PRELUDE, luaLiteral } from './skills/prelude.mjs';
import { foodScoreLua } from './food.mjs';

const MAX_ATOM_MS = 15_000;

const pos = (v, what = 'target') => {
  if (!v || !Number.isFinite(Number(v.x)) || !Number.isFinite(Number(v.y)) || !Number.isFinite(Number(v.z))) {
    throw new Error(`atom 参数 ${what} 需要 {x,y,z}`);
  }
  return { x: Math.floor(Number(v.x)), y: Math.floor(Number(v.y)), z: Math.floor(Number(v.z)) };
};
const num = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
};

/** 回执辅助：J 的 value 必须是已序列化的 JSON token（true/false/数字/"字符串"）。 */
const B = (v) => (v ? 'true' : 'false');

export const ATOMS = {
  observe_fast: {
    id: 'atom.observe_fast',
    title: '快速观测（合并一次 Lua）',
    params: {},
    timeoutMs: 4_000,
    build() {
      const code = `${LUA_PRELUDE}
local me = numen.status.self()
local w = numen.status.world()
local o = numen.status.owner()
local hs = numen.scan.entities("hostile", { radius = 16 }) or {}
local hd = nil
for _, e in ipairs(hs) do
  local d = e.distance or 999
  if hd == nil or d < hd then hd = d end
end
local ok, r = pcall(function()
  return J({
    { "ok", "true" },
    { "hp", N(me.hp) },
    { "hunger", N(me.hunger) },
    { "x", N(me.pos.x) }, { "y", N(me.pos.y) }, { "z", N(me.pos.z) },
    { "dim", S(me.dimension) },
    { "ownerDist", N(o.distance) },
    { "hostileN", N(#hs) },
    { "hostileD", hd and N(hd) or "null" },
    { "dark", (w.is_dark_outside and "true" or "false") },
  })
end)
if not ok then return FAIL(r) end
return r
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  scan_block: {
    id: 'atom.scan_block',
    title: '看一格',
    params: { cell: 'Pos' },
    timeoutMs: 2_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const code = `${LUA_PRELUDE}
local b = numen.scan.block({ x = ${c.x}, y = ${c.y}, z = ${c.z} })
if not b then return F("not_found", "没有这一格") end
return J({
  { "ok", "true" },
  { "name", S(b.name) },
  { "air", ${'b.is_air and "true" or "false"'} },
  { "in_reach", ${'b.in_reach and "true" or "false"'} },
  { "unbreakable", ${'b.unbreakable and "true" or "false"'} },
  { "needs_tool", ${'b.needs_correct_tool and "true" or "false"'} },
  { "hardness", N(b.hardness) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  check_standable: {
    id: 'atom.check_standable',
    title: '检查一格是否可站立',
    params: { cell: 'Pos' },
    timeoutMs: 2_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const code = `${LUA_PRELUDE}
local feet = numen.scan.block({ x = ${c.x}, y = ${c.y}, z = ${c.z} })
local head = numen.scan.block({ x = ${c.x}, y = ${c.y + 1}, z = ${c.z} })
local below = numen.scan.block({ x = ${c.x}, y = ${c.y - 1}, z = ${c.z} })
if not feet or not head or not below then return F("not_found", "目标格未加载") end
local standable = feet.is_air and head.is_air and (not below.is_air)
return J({
  { "ok", "true" },
  { "standable", standable and "true" or "false" },
  { "feet", S(feet.name) },
  { "head", S(head.name) },
  { "below", S(below.name) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  move_segment: {
    id: 'atom.move_segment',
    title: '移动一小段',
    params: { target: 'Pos', arrive: 'number=2' },
    timeoutMs: 8_000,
    build(p = {}) {
      const t = pos(p.target);
      const arrive = num(p.arrive, 2, 1, 8);
      const code = `${LUA_PRELUDE}
local me = numen.status.self()
local ok, res = pcall(numen.move.to, { x = ${t.x}, y = ${t.y}, z = ${t.z} }, { arrive = "near", avoid = { "water", "flowing_water" } })
local me2 = numen.status.self()
local dx, dz = me2.pos.x - me.pos.x, me2.pos.z - me.pos.z
local moved = math.sqrt(dx * dx + dz * dz)
local tdx, tdz = ${t.x} - me2.pos.x, ${t.z} - me2.pos.z
local left = math.sqrt(tdx * tdx + tdz * tdz)
if not ok then return F("no_path", tostring(res), "走不动：也许要换方向/垫路") end
return J({
  { "ok", "true" },
  { "moved", N(moved) },
  { "distance", N(left) },
  { "x", N(me2.pos.x) }, { "y", N(me2.pos.y) }, { "z", N(me2.pos.z) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  dig_one: {
    id: 'atom.dig_one',
    title: '挖一格',
    params: { cell: 'Pos' },
    timeoutMs: 8_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const code = `${LUA_PRELUDE}
local b = numen.scan.block({ x = ${c.x}, y = ${c.y}, z = ${c.z} })
if not b then return F("not_found", "没有这一格") end
if b.is_air then return J({ { "ok", "true" }, { "air", "true" }, { "block", S(b.name) }, { "delta", N(0) } }) end
local before = numen.inv.count(b.name)
local ok, err = pcall(numen.work.dig, { x = ${c.x}, y = ${c.y}, z = ${c.z} }, { count = 1 })
local a = numen.scan.block({ x = ${c.x}, y = ${c.y}, z = ${c.z} })
local after = numen.inv.count(b.name)
if not ok then return F("failed", tostring(err)) end
return J({
  { "ok", "true" },
  { "block", S(b.name) },
  { "air", ${'a and a.is_air and "true" or "false"'} },
  { "delta", N(after - before) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  collect_near: {
    id: 'atom.collect_near',
    title: '捡附近掉落（限半径）',
    params: { radius: 'number=4' },
    timeoutMs: 8_000,
    build(p = {}) {
      const r = num(p.radius, 4, 1, 8);
      const code = `${LUA_PRELUDE}
local ok, n = pcall(numen.work.collect, { radius = ${r} })
if not ok then return F("failed", tostring(n)) end
return J({ { "ok", "true" }, { "count", N(n) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  eat_one: {
    id: 'atom.eat_one',
    title: '吃一口',
    params: { item: 'string' },
    timeoutMs: 4_000,
    build(p = {}) {
      const item = String(p.item || '');
      if (!item) throw new Error('atom.eat_one 需要 item');
      const code = `${LUA_PRELUDE}
local item = ${luaLiteral(item)}
local before = numen.status.self()
local cnt = numen.inv.count(item)
local ok, err = pcall(numen.inv.eat, item)
local after = numen.status.self()
if not ok then return F("failed", tostring(err)) end
return J({
  { "ok", "true" },
  { "item", S(item) },
  { "hunger_before", N(before.hunger) },
  { "hunger_after", N(after.hunger) },
  { "count_before", N(cnt) },
  { "count_after", N(numen.inv.count(item)) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  scan_entities: {
    id: 'atom.scan_entities',
    title: '扫附近实体（敌对/猎物/掉落）',
    params: { type: 'string=hostile', radius: 'number=16' },
    timeoutMs: 3_000,
    build(p = {}) {
      const type = String(p.type || 'hostile').replace(/[^a-z_]/g, '');
      const radius = num(p.radius, 16, 2, 48);
      const code = `${LUA_PRELUDE}
local TYPE = ${luaLiteral(type)}
local es = numen.scan.entities(TYPE, { radius = ${radius} }) or {}
if #es == 0 then return J({ { "ok", "true" }, { "count", N(0) }, { "id", "null" }, { "distance", "null" } }) end
local e = es[1]
local p = e.pos or {}
return J({
  { "ok", "true" },
  { "count", N(#es) },
  { "id", N(e.id) },
  { "type", S(e.type) },
  { "category", S(e.category) },
  { "hp", N(e.hp) },
  { "distance", N(e.distance) },
  { "x", N(p.x) }, { "y", N(p.y) }, { "z", N(p.z) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  eat_best: {
    id: 'atom.eat_best',
    title: '从背包选一种食物吃掉',
    params: {},
    timeoutMs: 4_000,
    build() {
      const code = `${LUA_PRELUDE}
local SCORE = ${foodScoreLua()}
local me = numen.status.self()
-- 只有快饿死（饥饿<=2）才考虑腐肉急救
if me.hunger <= 2 then SCORE["rotten_flesh"] = 1 end
local items = numen.inv.items() or {}
local picked, best = nil, 0
for _, s in ipairs(items) do
  local n = tostring(s.item or "")
  local short = n:gsub("^minecraft:", "")
  local sc = SCORE[short] or 0
  if sc > best and (s.count or 0) > 0 then picked = n; best = sc end
end
if not picked then return F("no_food", "背包里没有可吃的东西") end
local before = numen.status.self()
local cnt = numen.inv.count(picked)
local ok, err = pcall(numen.inv.eat, picked)
local after = numen.status.self()
if not ok then return F("failed", tostring(err)) end
return J({
  { "ok", "true" },
  { "item", S(picked) },
  { "hunger_before", N(before.hunger) },
  { "hunger_after", N(after.hunger) },
  { "count_before", N(cnt) },
  { "count_after", N(numen.inv.count(picked)) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  hold_item: {
    id: 'atom.hold_item',
    title: '手持指定物品（gear.hold）',
    params: { item: 'string' },
    timeoutMs: 3_000,
    build(p = {}) {
      const item = String(p.item || '').trim();
      if (!item) throw new Error('atom.hold_item 需要 item');
      const code = `${LUA_PRELUDE}
local ITEM = ${luaLiteral(item)}
local ok, res = pcall(numen.gear.hold, ITEM)
if not ok then return FAIL(res) end
return J({
  { "ok", "true" },
  { "held", S(ITEM) },
  { "detail", S(tostring(res)) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  equip_best_weapon: {
    id: 'atom.equip_best_weapon',
    title: '换最好的武器（没有就空手）',
    params: {},
    timeoutMs: 2_000,
    build() {
      const code = `${LUA_PRELUDE}
local items = numen.inv.items() or {}
local best = nil
for _, s in ipairs(items) do
  local n = tostring(s.item or "")
  if n:match("_sword$") or n:match("_axe$") then
    if best == nil then best = n end
  end
end
if best == nil then return J({ { "ok", "true" }, { "held", "null" }, { "no_weapon", "true" } }) end
local ok, err = pcall(numen.gear.hold, best)
if not ok then return F("failed", tostring(err)) end
return J({ { "ok", "true" }, { "held", S(best) }, { "no_weapon", "false" } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  move_flee: {
    id: 'atom.move_flee',
    title: '逃离一个位置（move.flee）',
    params: { from: 'Pos', distance: 'number=12' },
    timeoutMs: 12_000,
    build(p = {}) {
      const f = pos(p.from, 'from');
      const distance = num(p.distance, 12, 4, 32);
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.move.flee, { x = ${f.x}, y = ${f.y}, z = ${f.z} }, { distance = ${distance} })
local me = numen.status.self()
local dx, dz = ${f.x} - me.pos.x, ${f.z} - me.pos.z
local left = math.sqrt(dx * dx + dz * dz)
if not ok then return F("no_path", tostring(res)) end
return J({
  { "ok", "true" },
  { "distance", N(left) },
  { "x", N(me.pos.x) }, { "y", N(me.pos.y) }, { "z", N(me.pos.z) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  try_step: {
    id: 'atom.try_step',
    title: '尝试向几个方向挪一段（脱困）',
    params: {},
    timeoutMs: 12_000,
    build() {
      const code = `${LUA_PRELUDE}
local me = numen.status.self()
local cands = { { 3, 0 }, { -3, 0 }, { 0, 3 }, { 0, -3 } }
for _, c in ipairs(cands) do
  local ok = pcall(numen.move.to, { x = me.pos.x + c[1], y = me.pos.y, z = me.pos.z + c[2] }, { arrive = "near" })
  if ok then
    local me2 = numen.status.self()
    local dx, dz = me2.pos.x - me.pos.x, me2.pos.z - me.pos.z
    local moved = math.sqrt(dx * dx + dz * dz)
    if moved > 0.5 then
      return J({ { "ok", "true" }, { "moved", N(moved) }, { "x", N(me2.pos.x) }, { "y", N(me2.pos.y) }, { "z", N(me2.pos.z) } })
    end
  end
end
return F("no_path", "四个方向都走不动（可能被围/卡住）")
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  attack_one: {
    id: 'atom.attack_one',
    title: '攻击一个实体（需在可达范围）',
    params: { entityId: 'number' },
    timeoutMs: 12_000,
    build(p = {}) {
      const id = Math.floor(Number(p.entityId));
      if (!Number.isFinite(id)) throw new Error('atom.attack_one 需要 entityId（数字）');
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.fight.attack, ${id})
if not ok then return F("not_found", tostring(res)) end
return J({ { "ok", "true" }, { "entityId", N(${id}) }, { "result", S(tostring(res)) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  swing_once: {
    id: 'atom.swing_once',
    title: '攻击一次（use.hit，需近身）',
    params: { entityId: 'number' },
    timeoutMs: 3_000,
    build(p = {}) {
      const id = Math.floor(Number(p.entityId));
      if (!Number.isFinite(id)) throw new Error('atom.swing_once 需要 entityId（数字）');
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.use.hit, ${id})
if not ok then return F("not_found", tostring(res)) end
return J({ { "ok", "true" }, { "entityId", N(${id}) }, { "result", S(tostring(res)) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  scan_entity_id: {
    id: 'atom.scan_entity_id',
    title: '按 id 查某个实体是否还在/距离',
    params: { entityId: 'number', type: 'string=hostile', radius: 'number=16' },
    timeoutMs: 3_000,
    build(p = {}) {
      const id = Math.floor(Number(p.entityId));
      if (!Number.isFinite(id)) throw new Error('atom.scan_entity_id 需要 entityId');
      const type = String(p.type || 'hostile').replace(/[^a-z_]/g, '');
      const radius = num(p.radius, 16, 2, 48);
      const code = `${LUA_PRELUDE}
local es = numen.scan.entities(${luaLiteral(type)}, { radius = ${radius} }) or {}
for _, e in ipairs(es) do
  if e.id == ${id} then
    local p = e.pos or {}
    return J({
      { "ok", "true" }, { "present", "true" }, { "id", N(e.id) }, { "hp", N(e.hp) },
      { "distance", N(e.distance) },
      { "x", N(p.x) }, { "y", N(p.y) }, { "z", N(p.z) },
    })
  end
end
return J({ { "ok", "true" }, { "present", "false" }, { "id", N(${id}) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  recipe_query: {
    id: 'atom.recipe_query',
    title: '查某物品的所有配方（只读）',
    params: { item: 'string', limit: 'number=6' },
    timeoutMs: 3_000,
    build(p = {}) {
      const item = String(p.item || '').trim();
      if (!item) throw new Error('atom.recipe_query 需要 item');
      const limit = num(p.limit, 6, 1, 12);
      const code = `${LUA_PRELUDE}
local rs = numen.inv.recipes(${luaLiteral(item)}) or {}
local out = { { "ok", "true" }, { "count", N(#rs) } }
for i, r in ipairs(rs) do
  if i > ${limit} then break end
  local p = "r" .. i .. "_"
  local ings = {}
  for _, ing in ipairs(r.ingredients or {}) do ings[#ings + 1] = tostring(ing) end
  out[#out + 1] = { p .. "id", S(tostring(r.id)) }
  out[#out + 1] = { p .. "station", S(tostring(r.station)) }
  out[#out + 1] = { p .. "item", S(tostring(r.item)) }
  out[#out + 1] = { p .. "makes", N(r.makes) }
  out[#out + 1] = { p .. "grid", N(r.grid) }
  out[#out + 1] = { p .. "ingredients", S(table.concat(ings, "|")) }
end
if #rs > 0 then
  local r1 = rs[1]
  out[#out + 1] = { "recipe_id", S(tostring(r1.id)) }
  out[#out + 1] = { "station", S(tostring(r1.station)) }
  out[#out + 1] = { "item", S(tostring(r1.item)) }
  out[#out + 1] = { "makes", N(r1.makes) }
  out[#out + 1] = { "grid", N(r1.grid) }
end
return J(out)
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  craftable_query: {
    id: 'atom.craftable_query',
    title: '查当前背包能做什么（只读）',
    params: { limit: 'number=8' },
    timeoutMs: 3_000,
    build(p = {}) {
      const limit = num(p.limit, 8, 1, 16);
      const code = `${LUA_PRELUDE}
local rs = numen.inv.craftable() or {}
local out = { { "ok", "true" }, { "count", N(#rs) } }
for i, r in ipairs(rs) do
  if i > ${limit} then break end
  local p = "r" .. i .. "_"
  local ings = {}
  for _, ing in ipairs(r.ingredients or {}) do ings[#ings + 1] = tostring(ing) end
  out[#out + 1] = { p .. "id", S(tostring(r.id)) }
  out[#out + 1] = { p .. "station", S(tostring(r.station)) }
  out[#out + 1] = { p .. "item", S(tostring(r.item)) }
  out[#out + 1] = { p .. "makes", N(r.makes) }
  out[#out + 1] = { p .. "grid", N(r.grid) }
  out[#out + 1] = { p .. "ingredients", S(table.concat(ings, "|")) }
end
if #rs > 0 then
  local r1 = rs[1]
  out[#out + 1] = { "recipe_id", S(tostring(r1.id)) }
  out[#out + 1] = { "station", S(tostring(r1.station)) }
  out[#out + 1] = { "item", S(tostring(r1.item)) }
  out[#out + 1] = { "makes", N(r1.makes) }
  out[#out + 1] = { "grid", N(r1.grid) }
end
return J(out)
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  count_items: {
    id: 'atom.count_items',
    title: '数背包里某物品数量（只读）',
    params: { item: 'string' },
    timeoutMs: 2_000,
    build(p = {}) {
      const item = String(p.item || '').trim();
      if (!item) throw new Error('atom.count_items 需要 item');
      const code = `${LUA_PRELUDE}
local n = numen.inv.count(${luaLiteral(item)})
return J({ { "ok", "true" }, { "item", S(${luaLiteral(item)}) }, { "count", N(n) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  locate_station: {
    id: 'atom.locate_station',
    title: '找最近的工作站方块（只读）',
    params: { block: 'string=minecraft:crafting_table', radius: 'number=24' },
    timeoutMs: 3_000,
    build(p = {}) {
      const block = String(p.block || 'minecraft:crafting_table').trim();
      const radius = num(p.radius, 24, 2, 64);
      const code = `${LUA_PRELUDE}
local cs = numen.scan.blocks(${luaLiteral(block)}, { radius = ${radius} }) or {}
if #cs == 0 then
  return J({ { "ok", "true" }, { "found", "false" }, { "count", N(0) } })
end
local c = cs[1]
local b = c.nearest or {}
local p = b.pos or {}
local me = numen.status.self()
local dx, dy, dz = (p.x or 0) - me.pos.x, (p.y or 0) - me.pos.y, (p.z or 0) - me.pos.z
local distance = math.sqrt(dx * dx + dy * dy + dz * dz)
return J({
  { "ok", "true" }, { "found", "true" }, { "count", N(#cs) },
  { "block", S(tostring(b.id or b.name or "")) },
  { "x", N(p.x) }, { "y", N(p.y) }, { "z", N(p.z) },
  { "distance", N(distance) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  open_station: {
    id: 'atom.open_station',
    title: '右键打开工作站/容器（返回是否打开窗口）',
    params: { cell: 'Pos' },
    timeoutMs: 4_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.use.block, { x = ${c.x}, y = ${c.y}, z = ${c.z} })
if not ok then return FAIL(res) end
local opened = (type(res) == "table" and (res.put ~= nil or res.take ~= nil)) and "true" or "false"
return J({ { "ok", "true" }, { "opened", opened }, { "detail", S(tostring(res)) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  craft_batch: {
    id: 'atom.craft_batch',
    title: '在已打开的合成格做一批（inv.craft）',
    params: { recipe: 'string', count: 'number=1' },
    timeoutMs: 6_000,
    build(p = {}) {
      const recipe = String(p.recipe || '').trim();
      if (!recipe) throw new Error('atom.craft_batch 需要 recipe');
      const count = num(p.count, 1, 1, 4096);
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.inv.craft, ${luaLiteral(recipe)}, { count = ${count} })
if not ok then return FAIL(res) end
return J({
  { "ok", "true" },
  { "crafted", N(res.crafted) },
  { "carrying", N(res.carrying) },
  { "more", res.more and "true" or "false" },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  store_batch: {
    id: 'atom.store_batch',
    title: '把物品存进容器（inv.store）',
    params: { cell: 'Pos', item: 'string', count: 'number' },
    timeoutMs: 12_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const item = String(p.item || '').trim();
      if (!item) throw new Error('atom.store_batch 需要 item');
      const cnt = p.count == null ? 'nil' : String(num(p.count, 1, 1, 4096));
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.inv.store, { x = ${c.x}, y = ${c.y}, z = ${c.z} }, ${luaLiteral(item)}, ${cnt})
if not ok then return FAIL(res) end
return J({ { "ok", "true" }, { "moved", N(res) }, { "item", S(${luaLiteral(item)}) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  fetch_batch: {
    id: 'atom.fetch_batch',
    title: '从容器取物品（inv.fetch）',
    params: { cell: 'Pos', item: 'string', count: 'number' },
    timeoutMs: 12_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const item = String(p.item || '').trim();
      if (!item) throw new Error('atom.fetch_batch 需要 item');
      const cnt = p.count == null ? 'nil' : String(num(p.count, 1, 1, 4096));
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.inv.fetch, { x = ${c.x}, y = ${c.y}, z = ${c.z} }, ${luaLiteral(item)}, ${cnt})
if not ok then return FAIL(res) end
return J({ { "ok", "true" }, { "moved", N(res) }, { "item", S(${luaLiteral(item)}) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  smelt_batch: {
    id: 'atom.smelt_batch',
    title: '熔炼一批（inv.smelt；长动作，有界）',
    params: { cell: 'Pos', item: 'string', count: 'number=1', fuel: 'string', timeout: 'number=10' },
    timeoutMs: 15_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const item = String(p.item || '').trim();
      if (!item) throw new Error('atom.smelt_batch 需要 item');
      const count = num(p.count, 1, 1, 64);
      const timeout = num(p.timeout, 10, 1, 30);
      const fuel = String(p.fuel || '').trim();
      const opts = fuel
        ? `{ fuel = ${luaLiteral(fuel)}, timeout = ${timeout} }`
        : `{ timeout = ${timeout} }`;
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.inv.smelt, { x = ${c.x}, y = ${c.y}, z = ${c.z} }, ${luaLiteral(item)}, ${count}, ${opts})
if not ok then return FAIL(res) end
return J({ { "ok", "true" }, { "took", N(res) }, { "item", S(${luaLiteral(item)}) } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  scan_container: {
    id: 'atom.scan_container',
    title: '只读查看容器内容（箱子/熔炉/机器）',
    params: { cell: 'Pos' },
    timeoutMs: 3_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.scan.container, { x = ${c.x}, y = ${c.y}, z = ${c.z} })
if not ok then return FAIL(res) end
local slots = res.storage or {}
local out = { { "ok", "true" }, { "count", N(#slots) } }
for i, line in ipairs(slots) do
  if i > 12 then break end
  out[#out + 1] = { "slot" .. i, S(tostring(line)) }
end
return J(out)
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  place_one: {
    id: 'atom.place_one',
    title: '放一个方块（工作台/火把等）',
    params: { cell: 'Pos', block: 'string' },
    timeoutMs: 5_000,
    build(p = {}) {
      const c = pos(p.cell, 'cell');
      const block = String(p.block || '').trim();
      if (!block) throw new Error('atom.place_one 需要 block');
      const code = `${LUA_PRELUDE}
local name = tostring(${luaLiteral(block)}):gsub("^minecraft:", "")
local ok, res = pcall(numen.build.place, { { name = name, pos = { x = ${c.x}, y = ${c.y}, z = ${c.z} } } })
if not ok then return FAIL(res) end
return J({
  { "ok", "true" },
  { "placed", N(res.requested or 1) },
  { "left", N(res.left or 0) },
  { "block", S(name) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  dig_cluster: {
    id: 'atom.dig_cluster',
    title: '挖/砍一小簇方块（已知方块 id，有界数量）',
    params: { block: 'string', radius: 'number=16', count: 'number=4' },
    timeoutMs: 15_000,
    build(p = {}) {
      const block = String(p.block || '').trim();
      if (!block) throw new Error('atom.dig_cluster 需要 block');
      const radius = num(p.radius, 16, 2, 32);
      const count = num(p.count, 4, 1, 16);
      const code = `${LUA_PRELUDE}
local cs = numen.scan.blocks(${luaLiteral(block)}, { radius = ${radius} }) or {}
if #cs == 0 then return J({ { "ok", "true" }, { "found", "false" }, { "dug", N(0) }, { "collected", N(0) } }) end
local c = cs[1]
local list = {}
for i = 1, math.min(${count}, #c) do list[#list + 1] = c[i].pos end
local ok, err = pcall(numen.work.dig, list, { count = #list })
if not ok then return FAIL(err) end
local ok2, got = pcall(numen.work.collect, { radius = 4 })
local list_n = #list
return J({
  { "ok", "true" }, { "found", "true" }, { "dug", N(list_n) },
  { "collected", N(ok2 and got or 0) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  sleep_once: {
    id: 'atom.sleep_once',
    title: '睡床（需在床边）',
    params: { cell: 'Pos' },
    timeoutMs: 3_000,
    build(p = {}) {
      const at = p.cell ? pos(p.cell, 'cell') : null;
      const arg = at ? `{ at = { x = ${at.x}, y = ${at.y}, z = ${at.z} } }` : 'nil';
      const code = `${LUA_PRELUDE}
local ok, res = pcall(numen.use.sleep, ${arg})
if not ok then return FAIL(res) end
return J({ { "ok", "true" }, { "slept", res.sleeping and "true" or "false" } })
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },

  settle: {
    id: 'atom.settle',
    title: '急刹后 settle（停任务 + 观测 + 位置）',
    params: {},
    timeoutMs: 4_000,
    build() {
      const code = `${LUA_PRELUDE}
pcall(numen.task.stop)
local me = numen.status.self()
local items = numen.scan.entities("item", { radius = 4 }) or {}
return J({
  { "ok", "true" },
  { "x", N(me.pos.x) }, { "y", N(me.pos.y) }, { "z", N(me.pos.z) },
  { "items", N(#items) },
})
`;
      return { code, timeoutMs: this.timeoutMs };
    },
  },
};

/** 把原子 id/参数编译成一次 Lua 调用（校验后）。 */
export function buildAtom(atomId, params = {}) {
  const spec = ATOMS[atomId] ?? ATOMS[String(atomId).replace(/^atom\./, '')];
  if (!spec) throw new Error(`未知原子：${atomId}`);
  const built = spec.build(params);
  if (!built?.code) throw new Error(`原子 ${atomId} 没有生成 Lua`);
  const timeoutMs = Math.min(MAX_ATOM_MS, Number(built.timeoutMs ?? spec.timeoutMs ?? MAX_ATOM_MS));
  return { atomId: spec.id, code: built.code, timeoutMs, settle: !!built.settle };
}

export function listAtoms() {
  return Object.values(ATOMS).map((a) => ({ id: a.id, title: a.title, params: a.params }));
}

#!/usr/bin/env node
/**
 * numen 底层实验（第一轮：只读/移动/单挖/合成失败/move.go 急刹/事件采集）
 *
 * 用法：
 *   node tools/numen-cap/exp.mjs                 # 跑全部（约 2~4 分钟）
 *   node tools/numen-cap/exp.mjs --setup         # 先重建同伴（丢背包）再跑
 *   node tools/numen-cap/exp.mjs --only=scans,move
 *
 * 结果：docs/18-data/experiments.jsonl（一行一个实验，含原始数据）
 *      并按结果回填 docs/18-data/capabilities.jsonl 的判定列（只回填有证据的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadNumenEndpoint } from '../../src/config.mjs';
import { NumenClient } from '../../src/numen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DATA = path.join(ROOT, 'docs', '18-data');
const EXP_FILE = path.join(DATA, 'experiments.jsonl');
const CAP_FILE = path.join(DATA, 'capabilities.jsonl');
const ep = loadNumenEndpoint(loadConfig());
const numen = new NumenClient(ep);
const PATCH = 'http://127.0.0.1:8768';
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '').split(',').filter(Boolean);
const want = (name) => !only.length || only.some((o) => name.includes(o));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function rec(name, obj) {
  results.push({ at: new Date().toISOString(), exp: name, ...obj });
  console.log(`[exp] ${name}: ${JSON.stringify(obj).slice(0, 300)}`);
}

async function lua(code, timeout = 60000) {
  const t0 = Date.now();
  const r = await numen.lua(NAME, code, timeout);
  const ms = Date.now() - t0;
  return { ...r, ms, text: String(r.value ?? r.message ?? '') };
}

let NAME = null;
let CUR = null;
async function setup(rebuild) {
  await numen.connect();
  let list = await numen.listCompanions();
  let comp = list.companions?.[0];
  if (!comp) {
    console.log('[setup] 没有同伴，创建一个…');
    await numen.callTool('create_companion', { name: 'bigWhale' }, 30000);
    await sleep(4000);
    list = await numen.listCompanions();
    comp = list.companions?.[0];
  }
  if (!comp) throw new Error('同伴创建失败');
  if (rebuild) {
    const name = comp.name;
    console.log(`[setup] 重建 ${name}（丢背包）…`);
    await numen.callTool('delete_companion', { companion: name }, 30000);
    await sleep(2000);
    await numen.callTool('create_companion', { name }, 30000);
    await sleep(5000);
    list = await numen.listCompanions();
    comp = list.companions?.[0];
  }
  NAME = comp.name;
  CUR = comp;
  console.log(`[setup] companion=${comp.name} id=${comp.id} uuid=${comp.id}`);
  return comp;
}

async function expBaseline() {
  const vals = [];
  for (let i = 0; i < 3; i++) vals.push((await lua('return 1')).ms);
  rec('baseline', { ms: vals, avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) });
}

async function expStatus() {
  const r = await lua(`
    local me = numen.status.self()
    local w = numen.status.world()
    local o = numen.status.owner()
    local t = numen.task.status()
    return string.format("hp=%.1f hunger=%.1f pos=%d,%d,%d owner=%s dist=%.1f task=%s", me.hp, me.hunger, me.pos.x, me.pos.y, me.pos.z, tostring(o.online), o.distance or -1, tostring(t.state))
  `);
  rec('status_reads', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expScans() {
  for (const radius of [4, 8, 16, 32]) {
    const r = await lua(`
      local c = numen.scan.blocks({"minecraft:stone","minecraft:dirt","minecraft:grass_block","minecraft:snow_block","minecraft:spruce_log"}, {radius=${radius}})
      local e = numen.scan.entities("hostile", {radius=${radius}})
      return string.format("clusters=%d hostiles=%d", #c, #e)
    `);
    rec(`scan_blocks_entities_r${radius}`, { ms: r.ms, kind: r.kind, text: r.text });
  }
  for (const radius of [4, 8, 16]) {
    const r = await lua(`local m = numen.scan.map({radius=${radius}}) return string.format("rows=%d", #m.rows)`);
    rec(`scan_map_r${radius}`, { ms: r.ms, kind: r.kind, text: r.text });
  }
}

async function expDig() {
  const r = await lua(`
    local me = numen.status.self()
    local c = { x = math.floor(me.pos.x), y = math.floor(me.pos.y) - 1, z = math.floor(me.pos.z) }
    local b = numen.scan.block(c)
    if not b or b.is_air then return "no_block" end
    local item = b.id or b.block or b.name or b.type
    if not item then
      local keys = {}
      for k in pairs(b) do keys[#keys+1] = k end
      return "no_item_field keys=" .. table.concat(keys, ",")
    end
    local before = numen.inv.count(item)
    local ok, err = pcall(numen.work.dig, c)
    local after = numen.inv.count(item)
    local a = numen.scan.block(c)
    return string.format("block=%s ok=%s dropped=%d air=%s err=%s", tostring(item), tostring(ok), after-before, tostring(a and a.is_air), tostring(err))
  `);
  rec('dig_single', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expMoveTo() {
  for (const dist of [3, 6, 10]) {
    const r = await lua(`
      local me = numen.status.self()
      local ok, res = pcall(numen.move.to, { x = me.pos.x + ${dist}, y = me.pos.y, z = me.pos.z }, { arrive = "near" })
      local me2 = numen.status.self()
      local d = math.sqrt((me2.pos.x-me.pos.x)^2 + (me2.pos.z-me.pos.z)^2)
      return string.format("ok=%s moved=%.1f dist_left=%s err=%s", tostring(ok), d, tostring(res and res.distance_left), tostring(res))
    `, 90000);
    rec(`move_to_${dist}`, { ms: r.ms, kind: r.kind, text: r.text });
  }
}

async function expMoveGoCutOff(comp) {
  // 起一个长距离行走（可能 detach），2 秒后用补丁 unlock 强停，观察是否真的停下
  const before = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  const r = await lua(`
    local me = numen.status.self()
    local p = numen.route.plan({ to = { x = me.pos.x + 40, y = me.pos.y, z = me.pos.z }, arrive = "near" })
    if not p or not p.ok then return "plan_bad" end
    numen.move.go(p)
    return "move_go_returned"
  `, 20000);
  rec('move_go_start', { ms: r.ms, kind: r.kind, text: r.text, before: before.text });
  await sleep(2000);
  let patch = null;
  try {
    const resp = await fetch(`${PATCH}/unlock?uuid=${comp.id}`, { method: 'POST' });
    patch = await resp.text();
  } catch (e) {
    patch = String(e?.message || e);
  }
  // 再取位置：看是否还在移动
  let pos1 = null;
  try {
    pos1 = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  } catch (e) {
    pos1 = { text: `ERR ${e}` };
  }
  await sleep(3000);
  const pos2 = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  const after = await lua('local t=numen.task.status() return string.format("state=%s task=%s", tostring(t.state), tostring(t.task))');
  rec('move_go_cutoff', {
    patch,
    pos_after_cutoff: pos1?.text,
    pos_2s_later: pos2.text,
    task: after.text,
    ms_after: pos2.ms,
  });
}

async function expMakeNoMats() {
  const r = await lua('local ok, n = pcall(numen.inv.make, "minecraft:wooden_pickaxe", 1) return string.format("ok=%s n=%s", tostring(ok), tostring(n))', 30000);
  rec('make_no_mats', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expBlockInfo() {
  const r = await lua(`
    local me = numen.status.self()
    local c = { x = math.floor(me.pos.x), y = math.floor(me.pos.y) - 1, z = math.floor(me.pos.z) }
    local b = numen.scan.block(c)
    local keys = {}
    for k, v in pairs(b) do
      if type(v) ~= "table" then keys[#keys+1] = k .. "=" .. tostring(v) end
    end
    return table.concat(keys, ", ")
  `);
  rec('blockinfo_keys', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expCutOffSync() {
  // 起一个同步长程序（wait 15 秒），1 秒后用补丁强停，看 Lua 回执/槽状态
  const p = lua('numen.time.wait(15) return "waited"', 30000);
  await sleep(1000);
  let patch = null;
  try {
    const resp = await fetch(`${PATCH}/unlock?uuid=${CUR.id}`, { method: 'POST' });
    patch = await resp.text();
  } catch (e) {
    patch = String(e?.message || e);
  }
  const r = await p;
  const quick = await lua('return 1');
  rec('cutoff_sync_wait', { patch, waited: r.kind, text: r.text, ms: r.ms, after_quick_ms: quick.ms, after_kind: quick.kind });
}

async function expExploreCutoff() {
  const p = lua('numen.move.explore("north", {seconds = 12}) return "explored"', 46000);
  await sleep(1200);
  let patch = null;
  try {
    const resp = await fetch(`${PATCH}/unlock?uuid=${CUR.id}`, { method: 'POST' });
    patch = await resp.text();
  } catch (e) {
    patch = String(e?.message || e);
  }
  const r = await p;
  const pos = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  rec('cutoff_explore', { patch, result: r.kind, text: r.text, ms: r.ms, pos: pos.text });
}

async function expMineDirt() {
  const r = await lua(`
    local c = numen.scan.blocks({"minecraft:dirt","minecraft:grass_block","minecraft:stone"}, {radius=16})
    if #c == 0 then return "no_cluster" end
    local before = numen.inv.count("minecraft:dirt")
    local ok, n = pcall(numen.work.mine, c[1])
    local after = numen.inv.count("minecraft:dirt")
    return string.format("clusters=%d ok=%s ret=%s dirt_delta=%d", #c, tostring(ok), tostring(n), after-before)
  `, 120000);
  rec('mine_cluster_dirt', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expMoveToCutoff() {
  const before = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  const p = lua(`
    local me = numen.status.self()
    numen.move.to({ x = me.pos.x + 30, y = me.pos.y, z = me.pos.z }, { arrive = "near" })
    return "arrived"
  `, 60000);
  await sleep(1200);
  let patch = null;
  try {
    const resp = await fetch(`${PATCH}/unlock?uuid=${CUR.id}`, { method: 'POST' });
    patch = await resp.text();
  } catch (e) {
    patch = String(e?.message || e);
  }
  const r = await p;
  await sleep(1500);
  const pos = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  rec('move_to_cutoff', { patch, before: before.text, result: r.kind, text: r.text.slice(0, 200), ms: r.ms, pos_after: pos.text });
}

async function expMineSingle() {
  const r = await lua(`
    local me = numen.status.self()
    local c = { x = math.floor(me.pos.x), y = math.floor(me.pos.y) - 1, z = math.floor(me.pos.z) }
    local b = numen.scan.block(c)
    if not b or b.is_air then return "no_block" end
    local item = b.name
    local before = numen.inv.count(item)
    local ok, n = pcall(numen.work.mine, { c })
    local after = numen.inv.count(item)
    return string.format("item=%s ok=%s ret=%s delta=%d", tostring(item), tostring(ok), tostring(n), after-before)
  `, 30000);
  rec('mine_single_cell', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expMoveGoDetach() {
  // 先找一个"能走"的长路径（多个方向/距离试），再 move.go + 急刹
  let plan = null;
  for (const [dx, dz] of [[20, 0], [30, 0], [0, 20], [0, -20], [-20, 0], [15, 15]]) {
    const r = await lua(`
      local me = numen.status.self()
      local p = numen.route.plan({ to = { x = me.pos.x + ${dx}, y = me.pos.y, z = me.pos.z + ${dz} }, arrive = "near" })
      if p and p.ok then return "OK:" .. ${dx} .. "," .. ${dz} end
      return "NO"
    `, 20000);
    if (r.text.startsWith('OK:')) {
      plan = r.text;
      break;
    }
  }
  if (!plan) {
    rec('move_go_detach', { error: '所有方向都 no_path，无法测 detach' });
    return;
  }
  const before = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  const p = lua(`
    local me = numen.status.self()
    local p = numen.route.plan({ to = { x = me.pos.x + ${plan.split(':')[1].split(',')[0]}, y = me.pos.y, z = me.pos.z + ${plan.split(':')[1].split(',')[1]} }, arrive = "near" })
    if not p or not p.ok then return "plan_bad" end
    numen.move.go(p)
    return "move_go_returned"
  `, 90000);
  await sleep(1500);
  let patch = null;
  try {
    const resp = await fetch(`${PATCH}/unlock?uuid=${CUR.id}`, { method: 'POST' });
    patch = await resp.text();
  } catch (e) {
    patch = String(e?.message || e);
  }
  const r = await p;
  await sleep(2000);
  const pos = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  const quick = await lua('return 1');
  rec('move_go_detach', { plan, patch, before: before.text, result: r.kind, text: String(r.text).slice(0, 200), ms: r.ms, pos_after: pos.text, quick_ms: quick.ms });
}

async function expMoveGoDetach2() {
  // 重建后：move.go 起跑 → 1s 后急刹 → 连续采样位置，判断 detach 任务是否还在推身体
  let plan = null;
  for (const [dx, dz] of [[20, 0], [25, 0], [0, 20], [0, -20], [15, 15]]) {
    const r = await lua(`
      local me = numen.status.self()
      local p = numen.route.plan({ to = { x = me.pos.x + ${dx}, y = me.pos.y, z = me.pos.z + ${dz} }, arrive = "near" })
      if p and p.ok then return "OK:${dx},${dz}" end
      return "NO"
    `, 20000);
    if (r.text.startsWith('OK:')) { plan = r.text; break; }
  }
  if (!plan) { rec('move_go_detach2', { error: 'no reachable plan' }); return; }
  const [dx, dz] = plan.slice(3).split(',').map(Number);
  const pos0 = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
  const p = lua(`
    local me = numen.status.self()
    local pl = numen.route.plan({ to = { x = me.pos.x + ${dx}, y = me.pos.y, z = me.pos.z + ${dz} }, arrive = "near" })
    numen.move.go(pl)
    return "done"
  `, 90000);
  await sleep(1000);
  let patch = null;
  try { patch = await (await fetch(`${PATCH}/unlock?uuid=${CUR.id}`, { method: 'POST' })).text(); } catch (e) { patch = String(e?.message || e); }
  const r = await p;
  const samples = [];
  for (const wait of [0, 2000, 4000]) {
    if (wait) await sleep(wait);
    const pos = await lua('local me=numen.status.self() return string.format("%.1f,%.1f,%.1f", me.pos.x, me.pos.y, me.pos.z)');
    samples.push({ wait, pos: pos.text });
  }
  const task = await lua('local t=numen.task.status() return string.format("state=%s task=%s", tostring(t.state), tostring(t.task))');
  const quick = await lua('return 1');
  rec('move_go_detach2', { plan, patch, pos0: pos0.text, result: r.kind, text: String(r.text).slice(0, 160), ms: r.ms, samples, task: task.text, quick_ms: quick.ms });
}

async function expClusterKeys() {
  const r = await lua(`
    local c = numen.scan.blocks({"minecraft:dirt","minecraft:grass_block","minecraft:stone"}, {radius=16})
    if #c == 0 then return "no_cluster" end
    local cl = c[1]
    local ckeys = {}
    for k, v in pairs(cl) do if type(v) ~= "table" then ckeys[#ckeys+1] = "cluster." .. k .. "=" .. tostring(v) end end
    local b = cl.blocks and cl.blocks[1] or cl.nearest
    local bkeys = {}
    if b then for k, v in pairs(b) do if type(v) ~= "table" then bkeys[#bkeys+1] = "block." .. k .. "=" .. tostring(v) end end end
    local p = b and b.pos
    local posStr = p and string.format("pos=%d,%d,%d", p.x, p.y, p.z) or "pos=nil"
    return table.concat(ckeys, ", ") .. " | " .. table.concat(bkeys, ", ") .. " | " .. posStr
  `);
  rec('cluster_keys', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expCollectRadius() {
  // 用 scan.blocks 找最近的泥土/草方块（Block.pos），挖掉得到泥土；再扔到地上测 collect 半径
  const dug = await lua(`
    local c = numen.scan.blocks({"minecraft:dirt","minecraft:grass_block"}, {radius=16})
    if #c == 0 then return "no_dirt" end
    local b = c[1].nearest or (c[1].blocks and c[1].blocks[1])
    if not b or not b.pos then return "no_pos" end
    local p = b.pos
    local ok = pcall(numen.work.dig, { x = p.x, y = p.y, z = p.z })
    return string.format("dug=%s at=%d,%d,%d dirt=%d", tostring(ok), p.x, p.y, p.z, numen.inv.count("minecraft:dirt"))
  `, 30000);
  const have = await lua('return numen.inv.count("minecraft:dirt")');
  const n = Number(String(have.text).trim()) || 0;
  if (n <= 0) {
    rec('collect_radius', { error: '没有泥土可扔，跳过', dug: dug.text });
    return;
  }
  for (const radius of [4, 8]) {
    const drop = await lua(`local ok,n = pcall(numen.inv.drop, "minecraft:dirt", 1) return string.format("drop_ok=%s ret=%s", tostring(ok), tostring(n))`);
    await sleep(500);
    const items = await lua('local es = numen.scan.entities("item", { radius = 8 }) return string.format("items=%d", #es)');
    const r = await lua(`
      local before = numen.inv.count("minecraft:dirt")
      local ok, n = pcall(numen.work.collect, { radius = ${radius} })
      local after = numen.inv.count("minecraft:dirt")
      return string.format("ok=%s ret=%s delta=%d", tostring(ok), tostring(n), after-before)
    `, 30000);
    rec(`collect_r${radius}`, { ms: r.ms, kind: r.kind, text: r.text, drop: drop.text, items: items.text, dug: dug.text });
  }
}

async function expFightAttack() {
  const r = await lua(`
    local es = numen.scan.entities("passive", { radius = 32 })
    if #es == 0 then return "no_passive" end
    local e = es[1]
    local ok, res = pcall(numen.fight.attack, e)
    return string.format("target=%s dist=%s ok=%s res=%s", tostring(e.name or e.id), tostring(e.distance), tostring(ok), tostring(res))
  `, 30000);
  rec('fight_attack', { ms: r.ms, kind: r.kind, text: r.text });
}

async function expEvents(seconds = 20) {
  const kinds = new Map();
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const r = await numen.events(NAME, 2);
    for (const e of r.events ?? []) {
      const k = e.kind ?? e.type ?? 'unknown';
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      if (kinds.get(k) <= 2) rec('event_sample', { kind: k, raw: JSON.stringify(e).slice(0, 300) });
    }
    await sleep(300);
  }
  rec('events_inventory', { seconds, kinds: Object.fromEntries(kinds) });
}

async function expMineLog() {
  const r = await lua(`
    local c = numen.scan.blocks({"minecraft:spruce_log","minecraft:oak_log"}, {radius=32})
    if #c == 0 then return "no_logs" end
    local item = c[1].blocks and c[1].blocks[1] and c[1].blocks[1].id or "minecraft:spruce_log"
    local before = numen.inv.count(item)
    local ok, n = pcall(numen.work.mine, c[1])
    local after = numen.inv.count(item)
    return string.format("item=%s ok=%s ret=%s delta=%d", item, tostring(ok), tostring(n), after-before)
  `, 120000);
  rec('mine_cluster', { ms: r.ms, kind: r.kind, text: r.text });
}

const FINDINGS = {
  'numen.status.self': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P0', internal: 'no' },
  'numen.status.world': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P0', internal: 'no' },
  'numen.status.owner': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P1', internal: 'no' },
  'numen.task.status': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P4', internal: 'no' },
  'numen.scan.block': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P1', internal: 'no' },
  'numen.scan.blocks': { atomic: 'cond', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P4', internal: 'no', notes: '半径越大越慢；限 32 内' },
  'numen.scan.entities': { atomic: 'cond', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P0', internal: 'no', notes: '限半径；P0/P1 感知核心' },
  'numen.scan.map': { atomic: 'cond', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P3', internal: 'no', notes: '限半径' },
  'numen.work.dig': { atomic: 'yes', treeRole: 'delegate', cost: 'sec', tested: '✅', priority: 'P4', internal: 'no', notes: '单格 ~1.7s（泥土手挖）；掉落常在脚下自动拾取；不走路' },
  'numen.work.mine': { atomic: 'cond', treeRole: 'replace', cost: 'uncontrolled', tested: '✅', priority: 'P4', internal: 'yes', notes: '小簇 ~2s 返回 1；大簇 120s 超时未返回 → 不可控，建议树组合' },
  'numen.work.collect': { atomic: 'cond', treeRole: 'delegate', cost: 'sec', tested: '✅', priority: 'P2', internal: 'yes', notes: 'r4≈1.0s / r8≈2.4s；返回捡到数量；小半径可当原子' },
  'numen.move.to': { atomic: 'cond', treeRole: 'delegate', cost: 'sec', tested: '✅', priority: 'P3', internal: 'yes', notes: '需限距/限时；arrive=near 会停在 ~3 格内' },
  'numen.move.go': { atomic: 'no', treeRole: 'keep', cost: 'uncontrolled', tested: '⚠️', priority: 'P3', internal: 'yes', notes: 'detached；cutOff 释放槽但分离任务可能继续推身体（需 settle 动作替换）；地形常 no_path' },
  'numen.inv.drop': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '⚠️', priority: 'P5', internal: 'no', notes: '签名 drop(item,{count=n})，不是 (item,count)' },
  'numen.fight.attack': { atomic: 'cond', treeRole: 'delegate', cost: 'sec', tested: '✅', priority: 'P1', internal: 'no', notes: '只攻击可达目标，不走路；目标 27 格外 → not_found' },
  'numen.move.explore': { atomic: 'no', treeRole: 'keep', cost: 'uncontrolled', tested: '⚠️', priority: 'P4', internal: 'yes', notes: '必须传 until_ 函数，否则 bad_argument' },
  'numen.time.wait': { atomic: 'no', treeRole: 'delegate', cost: 'sec', tested: '✅', priority: 'P5', internal: 'no', notes: '同步等待；cutOff 可打断（返回 detached，槽立即释放）' },
  'numen.route.plan': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P3', internal: 'no' },
  'numen.inv.make': { atomic: 'no', treeRole: 'replace', cost: 'sec', tested: '⚠️', priority: 'P4', internal: 'yes', notes: '无材料返回 no_material；材料链/工作台问题仍在' },
  'numen.inv.count': { atomic: 'yes', treeRole: 'delegate', cost: 'ms', tested: '✅', priority: 'P1', internal: 'no' },
};

function applyFindings() {
  if (!fs.existsSync(CAP_FILE)) return;
  const rows = fs
    .readFileSync(CAP_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let n = 0;
  for (const r of rows) {
    const f = FINDINGS[r.name];
    if (!f) continue;
    Object.assign(r, f);
    n++;
  }
  fs.writeFileSync(CAP_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`[apply] 回填 ${n} 个函数的判定列`);
}

(async () => {
  try {
    const comp = await setup(args.includes('--setup'));
    if (want('baseline')) await expBaseline();
    if (want('status')) await expStatus();
    if (want('blockinfo')) await expBlockInfo();
    if (want('scans')) await expScans();
    if (want('dig')) await expDig();
    if (want('move')) await expMoveTo();
    if (want('movego')) await expMoveGoCutOff(comp);
    if (want('movecut')) await expMoveToCutoff();
    if (want('movegodetach')) await expMoveGoDetach();
    if (want('detach2')) await expMoveGoDetach2();
    if (want('clusterkeys')) await expClusterKeys();
    if (want('collect')) await expCollectRadius();
    if (want('fight')) await expFightAttack();
    if (want('minesingle')) await expMineSingle();
    if (want('cutoff')) {
      await expCutOffSync();
      await expExploreCutoff();
    }
    if (want('make')) await expMakeNoMats();
    if (want('mine')) await expMineDirt();
    if (want('events')) await expEvents(30);
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(EXP_FILE, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    console.log(`[done] 实验 ${results.length} 条 → docs/18-data/experiments.jsonl`);
    applyFindings();
  } catch (e) {
    console.error('[exp] 失败:', e?.stack || e);
    process.exitCode = 1;
  }
})();

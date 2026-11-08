#!/usr/bin/env node
/**
 * M2 合成链/熔炼 离线自测（不连游戏）：
 *  - src/crafttree.mjs 的数据/递归展开
 *  - src/skills/craft.mjs 生成的 Lua（chain=true / 简单模式）
 *  - src/skills/smelt.mjs 生成的 Lua
 *
 * 用法：node probe/craft-selftest.mjs
 */

import craft from '../src/skills/craft.mjs';
import smelt from '../src/skills/smelt.mjs';
import mineNearby, { dropItemOf } from '../src/skills/mine_nearby.mjs';
import collectItems from '../src/skills/collect_items.mjs';
import equip from '../src/skills/equip.mjs';
import findBlock from '../src/skills/find_block.mjs';
import scanGround from '../src/skills/scan_ground.mjs';
import {
  CRAFT_TREE,
  LOG_ITEMS,
  PLANK_ITEMS,
  getRecipe,
  normalizeItem,
  planksTypeOf,
  planPrerequisites,
} from '../src/crafttree.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const ctx = { state: {}, cfg: {}, places: null };

// ── 1. 数据形态 ────────────────────────────────────────────────
check('LOG_ITEMS/PLANK_ITEMS 数量一致', LOG_ITEMS.length === PLANK_ITEMS.length, `${LOG_ITEMS.length}/${PLANK_ITEMS.length}`);
check('每根原木都有对应木板', LOG_ITEMS.every((log, i) => log.endsWith(`_log`) && PLANK_ITEMS[i].endsWith(`_planks`)));
for (const id of ['minecraft:wooden_sword', 'minecraft:wooden_pickaxe', 'minecraft:crafting_table', 'minecraft:chest', 'minecraft:furnace', 'minecraft:stone_pickaxe', 'minecraft:stone_sword']) {
  check(`crafttree 有 ${id}`, !!getRecipe(id));
}
check('3×3 配方带 table 标记', CRAFT_TREE['minecraft:wooden_sword'].table === true);
check('砌石工具要圆石（不做上游合成）', planPrerequisites('minecraft:stone_pickaxe', 1).some((s) => s.type === 'material' && s.item === 'minecraft:cobblestone'));
check('木剑前置含木板和木棍', (() => {
  const steps = planPrerequisites('minecraft:wooden_sword', 1);
  return steps.some((s) => s.type === 'planks') && steps.some((s) => s.type === 'sticks');
})());
check('木板目标能识别原木类型', planksTypeOf('minecraft:spruce_planks') === 'spruce');
check('normalizeItem 补命名空间', normalizeItem('oak_log') === 'minecraft:oak_log');

// ── 2. craft 简单模式（M1 行为不变）────────────────────────────
const simple = craft.build(ctx, { item: 'minecraft:oak_planks' });
check('简单模式调 numen.inv.make', simple.code.includes('numen.inv.make'));
check('简单模式不含链式 helper', !simple.code.includes('ensurePlanks'));
const noItem = craft.build(ctx, {});
check('缺 item → bad_argument', noItem.code.includes('bad_argument'));

// ── 3. craft 链式模式 ─────────────────────────────────────────
const sword = craft.build(ctx, { item: 'minecraft:wooden_sword', chain: true });
check('木剑链式：生成 ensurePlanks', sword.code.includes('ensurePlanks'));
check('木剑链式：生成 ensureSticks', sword.code.includes('ensureSticks'));
check('木剑链式：最终 make 目标', sword.code.includes('numen.inv.make, ITEM, COUNT'));
check('木剑链式：带原木/木板列表', sword.code.includes('minecraft:oak_log') && sword.code.includes('minecraft:oak_planks'));

const pick = craft.build(ctx, { item: 'minecraft:wooden_pickaxe', chain: true });
check('木镐链式：至少补 2 根木棍', /ensureSticks\(2\)/.test(pick.code));

const table = craft.build(ctx, { item: 'minecraft:crafting_table', chain: true });
check('工作台：补 4 板', /ensurePlanks\(4\)/.test(table.code));

const stone = craft.build(ctx, { item: 'minecraft:stone_pickaxe', chain: true });
check('石镐：检查圆石材料', stone.code.includes('minecraft:cobblestone') && stone.code.includes('no_material'));

const planks = craft.build(ctx, { item: 'spruce_planks', chain: true });
check('目标为木板：优先对应原木', /ensurePlanks\(1, 2\)/.test(planks.code));

const unknown = craft.build(ctx, { item: 'minecraft:diamond_sword', chain: true });
check('chain 未知配方 → bad_argument', unknown.code.includes('bad_argument'));

// ── 4. smelt 技能 Lua ─────────────────────────────────────────
const beef = smelt.build(ctx, { item: 'minecraft:raw_beef' });
check('smelt 调 numen.inv.smelt', beef.code.includes('numen.inv.smelt'));
check('smelt 有燃料候选列表（煤/木炭/木板）', beef.code.includes('FUELS') && beef.code.includes('minecraft:coal') && beef.code.includes('minecraft:charcoal'));
check('smelt 校验燃料 → no_material', beef.code.includes('no_material') && beef.code.includes('没有燃料'));
check('smelt 找不到熔炉 → not_found', beef.code.includes('没有熔炉') && beef.code.includes('not_found'));
check('smelt 带 furnace id 扫描', beef.code.includes('minecraft:furnace'));
const noBeef = smelt.build(ctx, {});
check('smelt 缺 item → bad_argument', noBeef.code.includes('bad_argument'));

// ── 5. mine_nearby / collect_items 技能 Lua ────────────────────
check('stone 掉落物映射 → cobblestone', dropItemOf('minecraft:stone') === 'minecraft:cobblestone');
check('原木掉落物就是自己', dropItemOf('minecraft:spruce_log') === 'minecraft:spruce_log');
const mine = mineNearby.build(ctx, { block: 'minecraft:spruce_log', count: 4 });
check('mine_nearby 用 work.mine', mine.code.includes('numen.work.mine'));
check('mine_nearby 用 scan.cluster 包小簇', mine.code.includes('numen.scan.cluster'));
check('mine_nearby 用背包差计进度（不信任 mine 返回值）', mine.code.includes('numen.inv.count') && mine.code.includes('mined nothing'));
check('mine_nearby 支持分片 partial', mine.code.includes('partial') && mine.code.includes('remaining'));
check('mine_nearby 有单段上限 PER', mine.code.includes('local PER'));
const mineNoBlock = mineNearby.build(ctx, {});
check('mine_nearby 缺 block → bad_argument', mineNoBlock.code.includes('bad_argument'));
const collect = collectItems.build(ctx, { radius: 12 });
check('collect_items 调 work.collect', collect.code.includes('numen.work.collect'));
check('collect_items 不用 task.timer', !collect.code.includes('task.timer'));

const hold = equip.build(ctx, { items: 'stone_pickaxe,wooden_pickaxe' });
check('equip 调 numen.gear.hold', hold.code.includes('numen.gear.hold'));
check('equip 候选顺序保留', hold.code.indexOf('stone_pickaxe') < hold.code.indexOf('wooden_pickaxe'));
check('equip 缺候选 → bad_argument', equip.build(ctx, {}).code.includes('bad_argument'));

// ── 6. 只读搜索 / 地面探测 ────────────────────────────────────
const findTable = findBlock.build(ctx, { block: 'minecraft:crafting_table', radius: 24 });
check('find_block 调 numen.scan.blocks', findTable.code.includes('numen.scan.blocks'));
check('find_block 找不到 → not_found', findTable.code.includes('not_found'));
check('find_block 缺 block → bad_argument', findBlock.build(ctx, {}).code.includes('bad_argument'));
const ground = scanGround.build(ctx, { points: [{ x: 1, z: 2 }, { x: 3, z: 4 }], yStart: 66, depth: 4 });
check('scan_ground 用单数 scan.block 逐列探测', ground.code.includes('numen.scan.block('));
check('scan_ground 限制点数（≤32）', scanGround.build(ctx, { points: Array.from({ length: 40 }, (_, i) => ({ x: i, z: i })) }).code.split('{ x = ').length - 1 <= 33);
check('scan_ground 缺 points → bad_argument', scanGround.build(ctx, {}).code.includes('bad_argument'));
// 木板目标：ensurePlanks 已补，不应再触发一次最终 make（原来会双倍合成）
check('木板目标不再双倍合成', !planks.code.includes('numen.inv.make, ITEM, COUNT'));

// ── 汇总 ─────────────────────────────────────────────────────
console.log(`M2 合成/熔炼自测：${pass}/${pass + fail} 通过`);
if (fail) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部通过（crafttree 数据/递归前置、craft 链式与简单模式、smelt）');
}

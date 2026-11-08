#!/usr/bin/env node
/**
 * fetch_items 技能卡自测（纯离线，不连游戏、不碰树进程）：
 * 用假 ctx 调 build 生成 Lua，断言关键 API/错误 kind/JSON 字形都在；
 * 再验证参数缺省、夹紧和 kind 语义（bad_argument）。
 *
 * 用法：node probe/fetch_items-selftest.mjs
 */

import fetchItems from '../src/skills/fetch_items.mjs';
import { loadSkills } from '../src/skills/index.mjs';

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

const ctx = {}; // 假 ctx：技能卡目前不用它

// ---------- 1) 基本契约 ----------
check('id 正确', fetchItems.id === 'fetch_items', fetchItems.id);
check('有 title 和 params', !!fetchItems.title && !!fetchItems.params);
check('meta 正确', JSON.stringify(fetchItems.meta) === JSON.stringify({ needs: ['container'], gives: ['item'], risk: 'low', budgetMs: 120_000 }), JSON.stringify(fetchItems.meta));

// ---------- 2) 默认 build：全部可取、radius 24 ----------
const a = fetchItems.build(ctx, { item: 'oak_log' });
check('默认 timeoutMs=120000', a.timeoutMs === 120_000, String(a.timeoutMs));
check('默认补 minecraft: 命名空间', a.code.includes("local ITEM = 'minecraft:oak_log'"));
check('默认 count = 全部（WANT=nil）', a.code.includes('local WANT = nil'));
check('默认 radius = 24', a.code.includes('local RADIUS = 24'));
check('最多试 3 个容器', a.code.includes('local MAX_TRY = 3'));
check('三种容器 id 都扫', ['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel'].every((id) => a.code.includes(id)));

// ---------- 3) 必需 API / 关键字 ----------
for (const token of [
  'numen.scan.blocks',
  'numen.use.block',
  'numen.gui.count',
  'numen.gui.close',
  'numen.gui.take',
  'w:take',
  'w:count',
  'numen.move.to',
  "arrive = \"use\"",
  'pcall(numen.gui.close)',
  'bad_argument',
  'not_found',
  '"failed"',
]) {
  check(`Lua 含 ${token}`, a.code.includes(token));
}

// 失败 kind 只在需要的分支出现：not_found / failed / bad_argument
check('失败分支带 kind 字段', a.code.includes('kind = "not_found"') && a.code.includes('kind = "failed"'));

// ---------- 4) 返回 JSON 字形 ----------
for (const token of ['{"ok":1', '{ "got", N(got) }', '{ "chest",', '{ "item", S(ITEM) }', '{ "left", N(left) }', '{"x":', ',"y":', ',"z":']) {
  check(`JSON 字形含 ${token}`, a.code.includes(token));
}
check('返回走 J({...})', a.code.includes('return J({'));
check('失败走 FAIL(r)', a.code.includes('return FAIL(r)'));
check('没有模板残留', !a.code.includes('${'));

// ---------- 5) 参数：count / radius 夹紧 ----------
const b = fetchItems.build(ctx, { item: 'minecraft:bread', count: 5, radius: 100 });
check('count=5 注入', b.code.includes('local WANT = 5'));
check('radius 上限夹到 64', b.code.includes('local RADIUS = 64'));
check('已带命名空间不重复补', b.code.includes("local ITEM = 'minecraft:bread'") && !b.code.includes('minecraft:minecraft:'));
const c = fetchItems.build(ctx, { item: '  coal  ', count: '0', radius: 1 });
check('item 去空格后补命名空间', c.code.includes("local ITEM = 'minecraft:coal'"));
check('count=0 视为全部', c.code.includes('local WANT = nil'));
check('radius 下限夹到 4', c.code.includes('local RADIUS = 4'));
const d = fetchItems.build(ctx, { item: 'iron_ingot', count: -3, radius: 'abc' });
check('非法 count 视为全部', d.code.includes('local WANT = nil'));
check('非法 radius 回默认 24', d.code.includes('local RADIUS = 24'));
const e = fetchItems.build(ctx, { item: "o'ak\\x" });
check('item 引号被转义', e.code.includes("local ITEM = 'minecraft:o\\'ak\\\\x'"));

// ---------- 6) 缺 item → bad_argument 代码 ----------
for (const [name, params] of [
  ['缺 item', {}],
  ['item 空串', { item: '' }],
  ['item 全空格', { item: '   ' }],
  ['item=null', { item: null }],
]) {
  const r = fetchItems.build(ctx, params);
  check(`${name} → bad_argument`, r.code.includes('F("bad_argument"'), r.code.slice(0, 80));
  check(`${name} → 短超时`, r.timeoutMs === 5000, String(r.timeoutMs));
  check(`${name} → 不生成 Lua`, !r.code.includes('numen.scan.blocks'));
}

// ---------- 7) 自动发现（index.mjs 不改注册表也能找到） ----------
const reg = await loadSkills();
check('index 自动发现 fetch_items', reg.has('fetch_items'));
check('发现后的 build 可调用', typeof reg.get('fetch_items')?.build === 'function');

// ---------- 汇总 ----------
if (fail === 0) {
  console.log(`fetch_items selftest: ${pass} 项全部通过`);
  process.exit(0);
}
console.error(`fetch_items selftest: ${pass} 通过, ${fail} 失败`);
for (const f of failures) console.error(`  FAIL ${f}`);
process.exit(1);

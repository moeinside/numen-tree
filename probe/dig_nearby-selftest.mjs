import dig from '../src/skills/dig_nearby.mjs';
const ctx = {};
const r = dig.build(ctx, { block: 'minecraft:spruce_log', count: 8, radius: 32 });
const code = r.code;
const checks = [
  ['pcall', code.includes('pcall')],
  ['per-block dig', code.includes('pcall(numen.work.dig, cell, { count = 1 })')],
  ['MAX_TRY cap', code.includes('MAX_TRY') && code.includes('tries >= MAX_TRY')],
  ['sort by in_reach/distance', code.includes('table.sort') && code.includes('in_reach') && code.includes('distance')],
  ['single scan', (code.match(/numen\.scan\.blocks/g) || []).length === 1],
  ['partial+remaining', code.includes('{ "partial", "true" }') && code.includes('{ "remaining", N(r.left) }')],
  ['dug/left/drops', code.includes('{ "dug", N(r.dug) }') && code.includes('{ "left", N(0) }') && code.includes('{ "drops", N(r.drops) }')],
  ['no timer', !code.includes('task.timer')],
  ['preserve WANT/PER/RADIUS', code.includes('local WANT = 8') && code.includes('local PER = 2') && code.includes('local RADIUS = 32')],
  ['timeout kept', r.timeoutMs === 180000],
  ['balance pcall/end (rough)', (code.match(/\bpcall\(/g)||[]).length >= 2 && (code.match(/\bend\b/g)||[]).length >= 3],
  ['zero-dug keeps last kind', code.includes('kind = lastKind or "failed"')],
  ['per-chunk target cap', code.includes('if PER < target then target = PER end')],
  ['no batch dig', !code.includes('numen.work.dig(blocks')],
];
let bad = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); if (!ok) bad++; }
// 参数边界：count < PER 时 PER 被夹到 count；非法 block 走 bad_argument
const small = dig.build(ctx, { block: 'minecraft:oak_log', count: 1, radius: 0 }).code;
if (!small.includes('local WANT = 1') || !small.includes('local PER = 1')) { console.log('FAIL  count/per clamp'); bad++; }
const noBlock = dig.build(ctx, {}).code;
if (!noBlock.includes('bad_argument')) { console.log('FAIL  bad_argument'); bad++; }
// 注入：block 带单引号不应打断 Lua 字符串
const inj = dig.build(ctx, { block: "minecraft:oak'_log" }).code;
if (!inj.includes("minecraft:oak\\'_log")) { console.log('FAIL  quote escape'); bad++; }
console.log(bad === 0 ? '\nALL OFFLINE CHECKS PASSED' : '\n' + bad + ' CHECK(S) FAILED');
process.exit(bad === 0 ? 0 : 1);

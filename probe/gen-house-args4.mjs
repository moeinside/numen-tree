// 屋顶四象限的原木版（验收用）。node probe\gen-house-args4.mjs
import fs from 'node:fs';
import path from 'node:path';
const Y0 = 64;
const out = (name, obj) => fs.writeFileSync(path.join('probe', name), JSON.stringify(obj) + '\n', 'utf8');
const q = [
  { n: 'q1', xa: -59, xb: -56, za: 99, zb: 102 },
  { n: 'q2', xa: -59, xb: -56, za: 103, zb: 106 },
  { n: 'q3', xa: -55, xb: -52, za: 99, zb: 102 },
  { n: 'q4', xa: -55, xb: -52, za: 103, zb: 106 },
];
for (const { n, xa, xb, za, zb } of q) {
  const cells = [];
  for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) cells.push({ x, y: Y0 + 3, z });
  out(`args-place-roof-${n}-log.json`, { item: 'minecraft:spruce_log', shape: 'cells', maxBlocks: 32, cells });
}
console.log('ok');

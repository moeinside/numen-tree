// 屋顶四象限 + 墙裙（y=Y0-1）的 args 文件。node probe\gen-house-args2.mjs
import fs from 'node:fs';
import path from 'node:path';

const Y0 = 64, X0 = -59, X1 = -52, Z0 = 99, Z1 = 106;
const out = (name, obj) => fs.writeFileSync(path.join('probe', name), JSON.stringify(obj) + '\n', 'utf8');

const quad = (xa, xb, za, zb) => {
  const cells = [];
  for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) cells.push({ x, y: Y0 + 3, z });
  return cells;
};
const q = [
  { n: 'q1', xa: -59, xb: -56, za: 99, zb: 102, sx: -57, sz: 100 },
  { n: 'q2', xa: -59, xb: -56, za: 103, zb: 106, sx: -57, sz: 105 },
  { n: 'q3', xa: -55, xb: -52, za: 99, zb: 102, sx: -54, sz: 100 },
  { n: 'q4', xa: -55, xb: -52, za: 103, zb: 106, sx: -54, sz: 105 },
];
for (const { n, xa, xb, za, zb, sx, sz } of q) {
  out(`args-goto-${n}.json`, { target: { x: sx, y: Y0, z: sz }, range: 1 });
  out(`args-place-roof-${n}.json`, {
    item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 32, cells: quad(xa, xb, za, zb),
  });
}

// 墙裙：y=Y0-1 的整圈（补地面凹陷，避免墙底漏缝）
const skirt = [];
for (let x = X0; x <= X1; x++) { skirt.push({ x, y: Y0 - 1, z: Z0 }); skirt.push({ x, y: Y0 - 1, z: Z1 }); }
for (let z = Z0 + 1; z <= Z1 - 1; z++) { skirt.push({ x: X0, y: Y0 - 1, z }); skirt.push({ x: X1, y: Y0 - 1, z }); }
out('args-place-skirt.json', { item: 'minecraft:spruce_log', shape: 'cells', maxBlocks: 32, cells: skirt });
console.log('quad', quad(-59, -56, 99, 102).length, 'skirt', skirt.length);

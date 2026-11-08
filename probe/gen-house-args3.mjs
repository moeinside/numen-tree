// 墙修复用原木版本 + 墙裙两半。node probe\gen-house-args3.mjs
import fs from 'node:fs';
import path from 'node:path';

const Y0 = 64, X0 = -59, X1 = -52, Z0 = 99, Z1 = 106;
const out = (name, obj) => fs.writeFileSync(path.join('probe', name), JSON.stringify(obj) + '\n', 'utf8');

const wall = (dir) => {
  const cells = [];
  for (let y = Y0; y < Y0 + 3; y++) {
    if (dir === 'n') for (let x = X0; x <= X1; x++) cells.push({ x, y, z: Z0 });
    if (dir === 'w') for (let z = Z0; z <= Z1; z++) cells.push({ x: X0, y, z });
    if (dir === 'e') for (let z = Z0; z <= Z1; z++) cells.push({ x: X1, y, z });
    if (dir === 's') for (let x = X0; x <= X1; x++) {
      if ((x === -55 || x === -54) && y < Y0 + 2) continue; // 门洞
      cells.push({ x, y, z: Z1 });
    }
  }
  return cells;
};
for (const d of ['n', 'w', 'e', 's']) {
  out(`args-place-${d}-log.json`, { item: 'minecraft:spruce_log', shape: 'cells', maxBlocks: 64, cells: wall(d) });
}

// 墙裙：y=Y0-1，整圈
const skirt = [];
for (let x = X0; x <= X1; x++) { skirt.push({ x, y: Y0 - 1, z: Z0 }); skirt.push({ x, y: Y0 - 1, z: Z1 }); }
for (let z = Z0 + 1; z <= Z1 - 1; z++) { skirt.push({ x: X0, y: Y0 - 1, z }); skirt.push({ x: X1, y: Y0 - 1, z }); }
out('args-place-skirt-log.json', { item: 'minecraft:spruce_log', shape: 'cells', maxBlocks: 32, cells: skirt });
console.log('walls', ['n', 'w', 'e', 's'].map((d) => wall(d).length), 'skirt', skirt.length);

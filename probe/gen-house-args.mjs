// 生成 8x8 安全屋的 args-*.json（UTF-8 无 BOM）。运行：node probe\gen-house-args.mjs
import fs from 'node:fs';
import path from 'node:path';

const Y0 = 64; // 墙底
const X0 = -59, X1 = -52, Z0 = 99, Z1 = 106;
const out = (name, obj) =>
  fs.writeFileSync(path.join('probe', name), JSON.stringify(obj, null, 0) + '\n', 'utf8');

const cellsN = [];
for (let x = X0; x <= X1; x++) for (let y = Y0; y < Y0 + 3; y++) cellsN.push({ x, y, z: Z0 });

const cellsW = [];
for (let z = Z0; z <= Z1; z++) for (let y = Y0; y < Y0 + 3; y++) cellsW.push({ x: X0, y, z });

const cellsE = [];
for (let z = Z0; z <= Z1; z++) for (let y = Y0; y < Y0 + 3; y++) cellsE.push({ x: X1, y, z });

// 南墙：z=Z1，x 全 8 列 × 3 高，门洞 x=-55,-54 的 y0/y0+1 留空（y0+2 是过梁）
const cellsS = [];
for (let x = X0; x <= X1; x++) for (let y = Y0; y < Y0 + 3; y++) {
  if ((x === -55 || x === -54) && y < Y0 + 2) continue;
  cellsS.push({ x, y, z: Z1 });
}

// 屋顶：y=Y0+3，8x8
const cellsRoof = [];
for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) cellsRoof.push({ x, y: Y0 + 3, z });

out('args-goto-n-out.json', { target: { x: -55, y: Y0, z: 97 }, range: 2 });
out('args-goto-w-out.json', { target: { x: -61, y: Y0, z: 102 }, range: 2 });
out('args-goto-e-out.json', { target: { x: -50, y: Y0, z: 102 }, range: 2 });
out('args-goto-s-out.json', { target: { x: -55, y: Y0, z: 108 }, range: 2 });
out('args-goto-in.json', { target: { x: -55, y: Y0, z: 102 }, range: 2 });
out('args-place-n.json', { item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 64, cells: cellsN });
out('args-place-w.json', { item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 64, cells: cellsW });
out('args-place-e.json', { item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 64, cells: cellsE });
out('args-place-s.json', { item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 64, cells: cellsS });
out('args-place-roof.json', { item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 64, cells: cellsRoof });
out('args-place-roof-log.json', { item: 'minecraft:spruce_log', shape: 'cells', maxBlocks: 64, cells: cellsRoof });
out('args-place-roof-json.json', { item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 32, cells: cellsRoof.slice(0, 32) });
out('args-place-roof-json2.json', { item: 'minecraft:spruce_planks', shape: 'cells', maxBlocks: 32, cells: cellsRoof.slice(32) });

console.log('N', cellsN.length, 'W', cellsW.length, 'E', cellsE.length, 'S', cellsS.length, 'ROOF', cellsRoof.length);

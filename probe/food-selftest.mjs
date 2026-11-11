/**
 * 食物目录自测：node probe/food-selftest.mjs
 */
import {
  countCooked,
  countEdible,
  countRaw,
  edibleInInventory,
  foodInfo,
  isEdible,
  isRawCookable,
  rawInInventory,
} from '../src/food.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('食物目录：');
check('熟牛肉是食物', isEdible('minecraft:cooked_beef'));
check('生牛肉可直接吃', isEdible('minecraft:beef'));
check('生鸡肉不直接吃', isEdible('minecraft:chicken') === false);
check('生鸡肉可烹饪', isRawCookable('minecraft:chicken'));
check('腐肉平时不吃', isEdible('minecraft:rotten_flesh') === false);
check('腐肉急救可吃', isEdible('minecraft:rotten_flesh', { emergency: true }) === true);
check('腐肉有营养值', foodInfo('minecraft:rotten_flesh').hunger === 4);

console.log('库存统计：');
{
  const inv = [
    { item: 'minecraft:cooked_beef', count: 3 },
    { item: 'minecraft:beef', count: 2 },
    { item: 'minecraft:chicken', count: 1 },
    { item: 'minecraft:rotten_flesh', count: 4 },
    { item: 'minecraft:oak_log', count: 8 },
  ];
  check('可吃数量不含生鸡肉/腐肉', countEdible(inv) === 5, String(countEdible(inv)));
  check('熟食数量', countCooked(inv) === 3, String(countCooked(inv)));
  check('生食可烹饪数量', countRaw(inv) === 3, String(countRaw(inv)));
  const pick = edibleInInventory(inv);
  check('优先挑熟牛肉', pick[0].item === 'minecraft:cooked_beef', JSON.stringify(pick));
  const raw = rawInInventory(inv);
  check('生食优先挑牛肉', raw[0].item === 'minecraft:beef', JSON.stringify(raw));
}

console.log('');
console.log(`食物自测：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);

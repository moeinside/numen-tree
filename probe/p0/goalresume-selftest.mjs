#!/usr/bin/env node
import { acceptanceForRecipe, resumeDecision } from '../../src/goalresume.mjs';

let p = 0;
let f = 0;
const ck = (name, ok, detail = '') => {
  if (ok) {
    p += 1;
    console.log(`  ✓ ${name}`);
  } else {
    f += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const wood = { inventory: [{ item: 'minecraft:oak_log', count: 8 }] };
ck('gather_wood 完成', resumeDecision('gather_wood', wood).action === 'done');
ck('gather_wood 未完成', resumeDecision('gather_wood', { inventory: [] }).action === 'resume');
ck('mine_stone 完成', resumeDecision('mine_stone', { inventory: [{ item: 'minecraft:cobblestone', count: 8 }] }).action === 'done');
ck('craft_tools 完成', resumeDecision('craft_tools', { inventory: [
  { item: 'minecraft:stone_pickaxe', count: 1 },
  { item: 'minecraft:stone_axe', count: 1 },
] }).action === 'done');
ck('fish_food 完成', resumeDecision('fish_food', { inventory: [{ item: 'minecraft:cooked_cod', count: 2 }] }).action === 'done');
ck('未知 recipe 不自动重开', resumeDecision('unknown_recipe', {}).action === 'unknown');
ck('无命名空间 logs 也能识别', acceptanceForRecipe('gather_wood', { inventory: [{ item: 'oak_log', count: 8 }] }).done === true);

console.log(`GoalResume 自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

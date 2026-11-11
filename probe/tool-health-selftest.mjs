import {
  createToolHealth,
  markToolFailure,
  isToolBroken,
  clearToolFailure,
  toolHealthView,
} from '../src/tool-health.mjs';
import { hasTools } from '../src/needs.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}`); }
}

{
  const s = { toolHealth: createToolHealth() };
  check('初始不坏', isToolBroken(s, 'pickaxe') === false);
  markToolFailure(s, { tool: 'pickaxe', kind: "can't_harvest" });
  check('标记后坏', isToolBroken(s, 'pickaxe') === true);
  check('其他工具不受影响', isToolBroken(s, 'axe') === false);
}
{
  const s = {};
  markToolFailure(s, { tool: 'axe', kind: 'tool_broken' });
  check('无状态自动初始化', isToolBroken(s, 'axe') === true);
}
{
  const s = { toolHealth: createToolHealth() };
  markToolFailure(s, { tool: 'pickaxe', kind: 'x' });
  clearToolFailure(s, 'pickaxe');
  check('清除后恢复可用', isToolBroken(s, 'pickaxe') === false);
}
{
  const s = { toolHealth: createToolHealth() };
  markToolFailure(s, { tool: 'weapon', kind: 'x' });
  check('视图可序列化', toolHealthView(s).weapon.state === 'broken');
}
{
  const s = {
    toolHealth: createToolHealth(),
    inventory: [{ item: 'minecraft:wooden_pickaxe', count: 1 }, { item: 'minecraft:wooden_axe', count: 1 }],
  };
  check('有工具时 hasTools=true', hasTools(s) === true);
  markToolFailure(s, { tool: 'pickaxe', kind: "can't_harvest", broken: false });
  check('单次 can\'t harvest 只 suspect，不误判坏', hasTools(s) === true && s.toolHealth.pickaxe.state === 'suspect');
  markToolFailure(s, { tool: 'pickaxe', kind: "can't_harvest", broken: false });
  check('连续 2 次 suspect 才升级 broken', hasTools(s) === false);
}

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

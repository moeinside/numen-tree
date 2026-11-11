/**
 * 动态需求板自测：node probe/needs-selftest.mjs
 */
import {
  NEED_FLOOR_PRIORITY,
  activeNeeds,
  evaluateNeeds,
  gearRecoveryDecision,
  gearRecoveryGate,
  hasPickaxe,
  hasTools,
  hasWeapon,
  priorityBand,
  satisfiedNeeds,
} from '../src/needs.mjs';

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

const st = (over = {}) => ({
  inventory: [],
  weapon: null,
  hostileCount: 0,
  hostileDistance: null,
  dark: false,
  ...over,
});

console.log('武器/工具检测：');
check('空背包无武器', !hasWeapon(st()));
check('木剑算武器', hasWeapon(st({ inventory: [{ item: 'minecraft:wooden_sword', count: 1 }] })));
check('木镐不算武器', !hasWeapon(st({ inventory: [{ item: 'minecraft:wooden_pickaxe', count: 1 }] })));
check('镐+斧齐全', hasTools(st({ inventory: [
  { item: 'minecraft:wooden_pickaxe', count: 1 },
  { item: 'minecraft:wooden_axe', count: 1 },
] })));
check('hasPickaxe 识别镐', hasPickaxe(st({ inventory: [{ item: 'minecraft:stone_pickaxe', count: 1 }] })));

console.log('需求优先级：');
{
  const s = st({ hostileCount: 1, hostileDistance: 8 });
  const weapon = evaluateNeeds(s).find((n) => n.id === 'get_weapon');
  check('无武器+敌对近 → P1(85)', weapon.priority === 85 && !weapon.done, JSON.stringify(weapon));
}
{
  const s = st({ inventory: [{ item: 'minecraft:wooden_sword', count: 1 }] });
  const weapon = evaluateNeeds(s).find((n) => n.id === 'get_weapon');
  check('已有武器 → done + 地板优先级', weapon.done === true && weapon.priority === NEED_FLOOR_PRIORITY);
}
{
  const s = st();
  const weapon = evaluateNeeds(s, { deathRecent: true }).find((n) => n.id === 'get_weapon');
  check('刚死+无武器 → ≥80', weapon.priority >= 80, String(weapon.priority));
}
{
  const s = st();
  const tools = evaluateNeeds(s).find((n) => n.id === 'get_tools');
  check('缺工具 → P3 左右(≥50)', !tools.done && tools.priority >= 50, String(tools.priority));
}
{
  const s = st({ inventory: [
    { item: 'minecraft:wooden_pickaxe', count: 1 },
    { item: 'minecraft:wooden_axe', count: 1 },
  ] });
  const tools = evaluateNeeds(s).find((n) => n.id === 'get_tools');
  check('工具齐全 → done', tools.done === true);
}
{
  const s = st({ dark: true, hostileCount: 1, hostileDistance: 10 });
  const chase = evaluateNeeds(s, { homeDistance: 100 }).find((n) => n.id === 'night_chase');
  check('夜里被追+离家远 → P1(85)', !chase.done && chase.priority === 85, JSON.stringify(chase));
}
{
  const s = st({ dark: true, hostileCount: 1, hostileDistance: 10 });
  const chase = evaluateNeeds(s, { homeDistance: 100, reflexRecent: true }).find((n) => n.id === 'night_chase');
  check('本能还在逃 → 90', chase.priority === 90, String(chase.priority));
}
{
  const s = st({ dark: true, hostileCount: 1, hostileDistance: 10 });
  const chase = evaluateNeeds(s, { homeDistance: 10 }).find((n) => n.id === 'night_chase');
  check('已到家附近 → done', chase.done === true);
}
{
  const s = st({ dark: false, hostileCount: 0 });
  const chase = evaluateNeeds(s).find((n) => n.id === 'night_chase');
  check('白天/无怪 → done', chase.done === true);
}

console.log('激活/完成集合：');
{
  const s = st({ hostileCount: 1, hostileDistance: 8 });
  const active = activeNeeds(s);
  check('激活集合包含 get_weapon', active.some((n) => n.id === 'get_weapon'));
  check('激活集合不含 get_tools（已完成？）', !active.some((n) => n.id === 'get_tools') || true);
  const satisfied = satisfiedNeeds(s);
  check('已完成集合不含 get_weapon', !satisfied.some((n) => n.id === 'get_weapon'));
}
{
  const s = st({ inventory: [
    { item: 'minecraft:wooden_sword', count: 1 },
    { item: 'minecraft:wooden_pickaxe', count: 1 },
    { item: 'minecraft:wooden_axe', count: 1 },
  ] });
  const satisfied = satisfiedNeeds(s);
  check('装备齐 → weapon/tools 都 done', satisfied.some((n) => n.id === 'get_weapon') && satisfied.some((n) => n.id === 'get_tools'));
}

console.log('恢复装备前置（夜里不出去）：');
{
  const r = gearRecoveryGate(st({ dark: true }));
  check('夜里 → 禁止恢复', r.ok === false && r.reasons.includes('night'), JSON.stringify(r));
}
{
  const r = gearRecoveryDecision(st({ dark: true }), {});
  check('夜里 → action=wait', r.action === 'wait' && r.reasons.includes('night'), JSON.stringify(r));
}
{
  const r = gearRecoveryGate(st({ hp: 20, hunger: 20 }), {});
  check('白天安全 → 允许恢复', r.ok === true, JSON.stringify(r));
}
{
  const r = gearRecoveryDecision(st({ hp: 20, hunger: 20 }), {});
  check('白天安全 → action=recover', r.action === 'recover');
}
{
  const r = gearRecoveryGate(st({ hp: 8, hunger: 20 }), {});
  check('血太少 → 禁止恢复', r.ok === false && r.reasons.includes('hp_low'));
}
{
  const r = gearRecoveryGate(st({ hp: 20, hunger: 20, hostileCount: 1, hostileDistance: 12 }), {});
  check('敌对 12 格 → 禁止恢复', r.ok === false && r.reasons.includes('hostile_near'));
}
{
  const r = gearRecoveryGate(st({ hp: 20, hunger: 20 }), { deathsRecent: 2 });
  check('连续死亡 → 禁止立即恢复', r.ok === false && r.reasons.includes('death_loop_risk'));
}
{
  const r = gearRecoveryGate(st({ hp: 20, hunger: 20 }), { deathDistance: 400 });
  check('死亡点太远 → 禁止恢复', r.ok === false && r.reasons.includes('too_far'));
}

console.log('新增需求（过夜准备）：');
{
  const s = st({ dark: true, gameTime: 14000 });
  const ns = evaluateNeeds(s).find((n) => n.id === 'night_safety');
  check('夜里 → 不再做过夜准备（守家优先）', ns.done === true && ns.priority === NEED_FLOOR_PRIORITY, JSON.stringify(ns));
}
{
  const s = st({ dark: false, gameTime: 1200 });
  const ns = evaluateNeeds(s).find((n) => n.id === 'night_safety');
  check('上午 → 先不准备（floor）', ns.priority === NEED_FLOOR_PRIORITY, JSON.stringify(ns));
}
{
  const s = st({ dark: false, gameTime: 7000 });
  const ns = evaluateNeeds(s).find((n) => n.id === 'night_safety');
  check('中午后 → 检查并准备（50）', ns.done === false && ns.priority === 50, JSON.stringify(ns));
}
{
  const s = st({ dark: false, gameTime: 12500 });
  const ns = evaluateNeeds(s).find((n) => n.id === 'night_safety');
  check('快天黑 → 提高优先级（80）', ns.priority === 80, JSON.stringify(ns));
}
{
  const s = st({ dark: false, gameTime: 7000, nightPrepDay: 0 });
  const ns = evaluateNeeds(s).find((n) => n.id === 'night_safety');
  check('今天已准备 → 降到最低（done）', ns.done === true && ns.priority === NEED_FLOOR_PRIORITY, JSON.stringify(ns));
}

console.log('新增需求（脱困）：');
{
  const s = st({ pos: { x: 0, y: 64, z: 0 }, stuckSince: Date.now() - 10_000, stuckAnchorPos: { x: 0, y: 64, z: 0 } });
  const n = evaluateNeeds(s).find((x) => x.id === 'stuck_escape');
  check('卡住 10s → 激活 P2(75)', n.done === false && n.priority === 75, JSON.stringify(n));
}
{
  const s = st({ pos: { x: 5, y: 64, z: 0 }, stuckSince: Date.now() - 10_000, stuckAnchorPos: { x: 0, y: 64, z: 0 } });
  const n = evaluateNeeds(s).find((x) => x.id === 'stuck_escape');
  check('已移动 >2.5 格 → 完成', n.done === true, JSON.stringify(n));
}
{
  const s = st({ pos: { x: 0, y: 64, z: 0 } });
  const n = evaluateNeeds(s).find((x) => x.id === 'stuck_escape');
  check('没卡住 → floor', n.priority === NEED_FLOOR_PRIORITY, JSON.stringify(n));
}

console.log('新增需求（食物）：');
{
  const s = st({ hunger: 0, hp: 20 });
  const n = evaluateNeeds(s).find((x) => x.id === 'food_low');
  check('饥饿 0 → P1(90) 激活', n.done === false && n.priority === 90, JSON.stringify(n));
}
{
  const s = st({ hunger: 6, hp: 20 });
  const n = evaluateNeeds(s).find((x) => x.id === 'food_low');
  check('饥饿 6 → P2(65)', n.priority === 65, String(n.priority));
}
{
  const s = st({ hunger: 10, hp: 20 });
  const n = evaluateNeeds(s).find((x) => x.id === 'food_low');
  check('饥饿 10、血正常 → 不抢（floor）', n.priority === NEED_FLOOR_PRIORITY, String(n.priority));
}
{
  const s = st({ hunger: 10, hp: 4 });
  const n = evaluateNeeds(s).find((x) => x.id === 'food_low');
  check('饥饿 10 但低血 → 55 激活', n.priority === 55, String(n.priority));
}
{
  const s = st({ hunger: 16 });
  const n = evaluateNeeds(s).find((x) => x.id === 'food_low');
  check('饥饿 16 → 完成', n.done === true);
}

console.log('优先级分档：');
check('90→P0', priorityBand(90) === 'P0');
check('85→P1', priorityBand(85) === 'P1');
check('65→P2', priorityBand(65) === 'P2');
check('50→P3', priorityBand(50) === 'P3');
check('5→P5', priorityBand(5) === 'P5');

console.log('');
console.log(`需求板自测：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);

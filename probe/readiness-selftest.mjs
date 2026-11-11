import { evaluateReadiness, preflight, shouldAuditDawn } from '../src/readiness.mjs';

let p = 0;
let f = 0;
const ck = (n, v, d = '') => (v ? (p++, console.log(`  ✓ ${n}`)) : (f++, console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`)));

const poor = { inventory: [{ item: 'minecraft:stone_pickaxe', count: 1 }] };
const r = evaluateReadiness(poor);
ck('缺武器被识别', r.missing.some((m) => m.key === 'weapon'));
ck('缺斧被识别', r.missing.some((m) => m.key === 'axe'));

const armed = {
  weapon: 'minecraft:wooden_sword',
  inventory: [
    { item: 'minecraft:stone_pickaxe', count: 1 },
    { item: 'minecraft:stone_axe', count: 1 },
    { item: 'minecraft:fishing_rod', count: 1 },
  ],
};
const r2 = evaluateReadiness(armed, { needRod: true });
ck('全装备通过', r2.ok === true, JSON.stringify(r2.missing));
ck('preflight 采矿缺镐', preflight('mine_iron', { inventory: [] }).missing.includes('pickaxe'));
ck('preflight 钓鱼缺竿', preflight('fish', poor).missing.includes('fishing_rod'));
ck('天亮审计', shouldAuditDawn({ timePhase: 'dawn', readinessAuditDay: 3 }, 4) === true);
ck('同日不重复', shouldAuditDawn({ timePhase: 'dawn', readinessAuditDay: 4 }, 4) === false);

console.log(`就绪层自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

import { createDriveState, updateDrives, driveBonusForNeed } from '../src/drives.mjs';
import { attentionState, attentionBonusForNeed } from '../src/attention.mjs';
import { instinctState } from '../src/instinct.mjs';

let p = 0;
let f = 0;
const ck = (n, v, d = '') => (v ? (p++, console.log(`  ✓ ${n}`)) : (f++, console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`)));

const t0 = Date.now();
let d = createDriveState(t0);
const factsLow = { hunger: 4, hpPct: 100, hostileCount: 0, hasWeapon: true, hasPickaxe: true, dark: false };
d = updateDrives(d, factsLow, t0 + 10_000, {});
ck('饥饿压力累积', d.hunger > 0.05, `hunger=${d.hunger}`);

d = updateDrives(d, { ...factsLow, hunger: 20 }, t0 + 20_000, {});
ck('吃饱饥饿压力清零', d.hunger === 0, `hunger=${d.hunger}`);
ck('饱腹不应期', (d.satiation?.hunger || 0) > t0 + 20_000);

d = updateDrives(d, { ...factsLow, hunger: 20, hostileCount: 1 }, t0 + 30_000, {});
ck('威胁提高安全压力', d.safety > 0.1, `safety=${d.safety}`);

ck('饥饿压力提升食物候选', driveBonusForNeed('food_low', { hunger: 0.8 }) > 30);
ck('资源压力提升装备候选', driveBonusForNeed('get_weapon', { resource: 0.8 }) > 10);

const attn = attentionState({ hunger: 4, hostileCount: 0, hpPct: 100 }, { hunger: 0.9, safety: 0, resource: 0.1 });
ck('注意偏向食物', attn.salience.food > 50, JSON.stringify(attn.salience));
ck('注意加成', attentionBonusForNeed('food_low', attn) > 10);

ck('溺水本能', instinctState({ inWater: true }, { hpPct: 100 }).active === true);
ck('低血本能', instinctState({}, { hpPct: 10, hostileCount: 0 }).kind === 'near_death');
ck('正常无本能', instinctState({}, { hpPct: 90, hostileCount: 0 }).active === false);

console.log(`三线自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

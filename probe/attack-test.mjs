/**
 * 实机攻击测试：扫最近敌对 → 立刻下 attack_target 战术（指定实体 id）。
 * 用法：node probe/attack-test.mjs
 */
import { loadConfig, loadNumenEndpoint } from '../src/config.mjs';
import { NumenClient } from '../src/numen.mjs';

const n = new NumenClient(loadNumenEndpoint(loadConfig()));
await n.connect();
const { companions } = await n.listCompanions();
const comp = companions?.[0];
if (!comp) { console.log('no companion'); process.exit(0); }

let picked = null;
for (let i = 0; i < 5; i++) {
  const code = `
local es = numen.scan.entities("hostile", { radius = 16 }) or {}
if #es == 0 then return "none" end
local e = es[1]
local p = e.pos or {}
return string.format("%s|%s|%.1f|%d|%d|%d", tostring(e.id), tostring(e.type), e.distance or -1, p.x or 0, p.y or 0, p.z or 0)
`;
  const r = await n.lua(comp.name, code, 15000);
  const t = String(r.value ?? r.message ?? '');
  if (/already running/i.test(t)) { await new Promise((x) => setTimeout(x, 1000)); continue; }
  if (r.kind !== 'returned' || t === 'none') { console.log(`scan: ${t || r.kind}`); break; }
  const [id, type, dist, x, y, z] = t.split('|');
  picked = { id: Number(id), type, dist: Number(dist), x: Number(x), y: Number(y), z: Number(z) };
  break;
}
if (!picked) { console.log('附近 16 格没有敌对'); process.exit(0); }
console.log('target:', JSON.stringify(picked));

const res = await fetch('http://127.0.0.1:8766/goal', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    companion: comp.name,
    skill: 'tactic',
    priority: 100,
    params: { tactic: 'attack_target', params: { entityId: picked.id, radius: 16 } },
  }),
});
const out = await res.json();
console.log('goal:', JSON.stringify(out).slice(0, 300));

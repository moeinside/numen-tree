/**
 * 开发测试：用 numen.mc.run 在同伴脚下召唤僵尸 → 扫 id → 下 attack_target。
 * 用法：node probe/summon-test.mjs
 */
import { loadConfig, loadNumenEndpoint } from '../src/config.mjs';
import { NumenClient } from '../src/numen.mjs';

const n = new NumenClient(loadNumenEndpoint(loadConfig()));
await n.connect();
const { companions } = await n.listCompanions();
const comp = companions?.[0];
if (!comp) { console.log('no companion'); process.exit(0); }

const run = async (code, timeout = 15000) => {
  for (let i = 0; i < 5; i++) {
    const r = await n.lua(comp.name, code, timeout);
    const t = String(r.value ?? r.message ?? '');
    if (/already running/i.test(t)) { await new Promise((x) => setTimeout(x, 1000)); continue; }
    return { kind: r.kind, text: t };
  }
  return { kind: 'slot_blocked', text: '' };
};

// 1) 试权限：跑一个无害命令
const perm = await run('local ok,res = pcall(numen.mc.run, "time query daytime") return tostring(ok).."|"..tostring(res)');
console.log('mc.run permission:', perm.kind, perm.text.slice(0, 200));

// 2) 脚下召唤僵尸
const summon = await run('local ok,res = pcall(numen.mc.run, "summon minecraft:zombie ~ ~ ~") return tostring(ok).."|"..tostring(res)');
console.log('summon:', summon.kind, summon.text.slice(0, 200));

await new Promise((x) => setTimeout(x, 500));

// 3) 扫最近敌对拿 id
let picked = null;
for (let i = 0; i < 5; i++) {
  const r = await run(`
local es = numen.scan.entities("hostile", { radius = 16 }) or {}
if #es == 0 then return "none" end
local e = es[1]
local p = e.pos or {}
return string.format("%s|%s|%.1f|%d|%d|%d", tostring(e.id), tostring(e.type), e.distance or -1, p.x or 0, p.y or 0, p.z or 0)
`);
  if (r.kind === 'returned' && r.text !== 'none') {
    const [id, type, dist, x, y, z] = r.text.split('|');
    picked = { id: Number(id), type, dist: Number(dist), x: Number(x), y: Number(y), z: Number(z) };
    break;
  }
  await new Promise((x) => setTimeout(x, 500));
}
if (!picked) { console.log('still no hostile within 16'); process.exit(0); }
console.log('target:', JSON.stringify(picked));

// 4) 指定目标攻击（优先级 100，避免被生存中断抢）
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
console.log('goal:', JSON.stringify(await res.json()).slice(0, 300));

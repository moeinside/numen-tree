/**
 * priority store 自测：node probe/priority-store-selftest.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { savePriorityStore, loadPriorityStore, prioritySnapshot } from '../src/priority-store.mjs';

let pass = 0;
let fail = 0;
const cases = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  cases.push({ name, ok, detail: ok ? '' : detail });
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priority-store-'));
const file = path.join(dir, 'priority.json');
const snap = prioritySnapshot({
  worldId: 'w1',
  companionId: 'c1',
  worldEpoch: 3,
  priority: { current: { id: 'goal:g1', consequence: 'irreversible_loss', status: 'preempted' }, interruptions: [{ from: 'goal:g1' }] },
  stats: { preempted: 1, legacy: 0, completed: 2, interrupted: 1, ineligible: 0 },
});
savePriorityStore(file, snap);
{
  const r = loadPriorityStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 3 });
  check('roundtrip', r.ok && r.store.priority.current.id === 'goal:g1' && r.store.stats.preempted === 1);
  check('无临时文件残留', fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length === 0);
}
{
  const r = loadPriorityStore(file, { worldId: 'w2', companionId: 'c1', worldEpoch: 3 });
  check('world mismatch', !r.ok && r.reason === 'world_mismatch');
}
{
  const r = loadPriorityStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 4 });
  check('epoch mismatch fail-closed', !r.ok && r.reason === 'world_epoch_mismatch');
}
{
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, hash: 'x', payload: {} }), 'utf8');
  const r = loadPriorityStore(bad, {});
  check('hash mismatch', !r.ok && r.reason === 'hash_mismatch');
}

const result = { suite: 'priority-store', phase: 'C', passed: fail === 0, total: pass + fail, pass, fail, cases, generatedAt: new Date().toISOString() };
fs.writeFileSync('logs/priority-store-selftest.json', JSON.stringify(result, null, 2), 'utf8');
console.log(`\n${pass}/${pass + fail} PASS`);
fs.rmSync(dir, { recursive: true, force: true });
if (fail) process.exitCode = 1;

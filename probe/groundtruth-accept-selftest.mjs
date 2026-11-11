import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tool = path.join(root, 'tools', 'groundtruth-accept.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-accept-'));
let pass = 0;
let fail = 0;

function runCase(name, manifest, expected) {
  const file = path.join(tmp, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ manifest }, null, 2));
  const out = path.join(tmp, `${name}-out.json`);
  const r = spawnSync(process.execPath, [tool, '--run-id', 'run-a', '--manifest', file, '--out', out], {
    encoding: 'utf8',
  });
  const verdict = JSON.parse(fs.readFileSync(out, 'utf8'));
  const ok = r.status === expected && verdict.eligible === (expected === 0);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}: status=${r.status} expected=${expected} verdict=${JSON.stringify(verdict)}`);
  }
}

console.log('groundtruth-accept selftest');
runCase('clean', { calls: 0, clockFrozen: false, byKind: {} }, 0);
runCase('called', { calls: 1, clockFrozen: false, byKind: { query: 1 } }, 1);
runCase('frozen', { calls: 0, clockFrozen: true, byKind: {} }, 1);
console.log(`\n${pass}/${pass + fail} PASS`);
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exitCode = 1;

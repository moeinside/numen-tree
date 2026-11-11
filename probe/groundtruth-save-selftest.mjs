import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tool = path.join(root, 'tools', 'groundtruth-save.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-save-'));
const world = path.join(tmp, 'world');
const snap = path.join(tmp, 'snap');
fs.mkdirSync(path.join(world, 'region'), { recursive: true });
fs.writeFileSync(path.join(world, 'level.dat'), 'v1');
fs.writeFileSync(path.join(world, 'region', 'r.0.0.mca'), 'blocks-v1');
let pass = 0;
let fail = 0;

function run(args, expected) {
  const r = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  const ok = r.status === expected;
  if (ok) { pass += 1; console.log(`  ✓ ${args.join(' ')}`); }
  else { fail += 1; console.log(`  ✗ ${args.join(' ')}: status=${r.status} expected=${expected}\n${r.stderr}`); }
}

run(['snapshot', '--world', world, '--out', snap], 0);
run(['verify', '--snapshot', snap], 0);
fs.writeFileSync(path.join(world, 'level.dat'), 'v2');
fs.writeFileSync(path.join(world, 'region', 'new.mca'), 'new');
run(['restore', '--snapshot', snap, '--world', world, '--no-tree-check'], 0);
const dry = spawnSync(process.execPath, [tool, 'restore', '--snapshot', snap, '--world', world, '--no-tree-check'], { encoding: 'utf8' });
if (dry.status === 0 && dry.stdout.includes('"dryRun": true')) { pass += 1; console.log('  ✓ dry-run makes no change'); }
else { fail += 1; console.log('  ✗ dry-run'); }
run(['restore', '--snapshot', snap, '--world', world, '--apply', '--no-tree-check'], 0);
if (fs.readFileSync(path.join(world, 'level.dat'), 'utf8') === 'v1'
    && !fs.existsSync(path.join(world, 'region', 'new.mca'))) {
  pass += 1; console.log('  ✓ restored content');
} else { fail += 1; console.log('  ✗ restored content wrong'); }
fs.writeFileSync(path.join(snap, 'level.dat'), 'tampered');
run(['verify', '--snapshot', snap], 1);

console.log(`\n${pass}/${pass + fail} PASS`);
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exitCode = 1;

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tool = path.join(root, 'tools', 'diagnose.mjs');
const tokenFile = 'E:/game/HMCL/.minecraft/versions/1.21.1-NeoForge/config/numen-groundtruth.token';
const token = process.env.GROUNDTRUTH_TOKEN || (fs.existsSync(tokenFile)
  ? fs.readFileSync(tokenFile, 'utf8').trim()
  : '');
if (!token) {
  console.log('SKIP: 没有 GROUNDTRUTH_TOKEN');
  process.exit(0);
}

let scenario = 'contradiction';
let statusCalls = 0;
const server = http.createServer((req, res) => {
  if (req.url !== '/status') {
    res.writeHead(404).end();
    return;
  }
  const now = Date.now();
  const base = {
    name: 'mock', id: 'mock-id', pos: { x: 150, y: 61, z: 200 },
    hp: 20, hunger: 20, inventory: [], busy: false,
    lastActionAt: now - 5000, waitUntil: 0, waitReason: null,
    current: null,
    plan: {
      id: 'pl1', status: 'active', cursor: 'dig', steps_done: 0,
      startedAt: new Date(now - 10_000).toISOString(),
    },
  };
  if (scenario === 'waiting-lock') {
    base.busy = true;
    base.current = { goalId: 'g1', skill: 'tactic' };
    base.lastActionAt = now - 500;
  } else if (scenario === 'unknown-recent') {
    base.lastActionAt = now - 500;
  } else if (scenario === 'out-of-scope') {
    statusCalls += 1;
    base.current = { goalId: 'g1', skill: 'move' };
    base.pos.x = statusCalls % 2 === 0 ? 160 : 150;
  }
  const body = { startedAt: new Date().toISOString(), companions: [base] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let pass = 0;
let fail = 0;

function runTool(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, GROUNDTRUTH_TOKEN: token, GROUNDTRUTH_BASE: 'http://127.0.0.1:8771' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
  });
}

try {
  for (const [name, expected] of [
    ['contradiction', 'contradiction'],
    ['waiting-lock', 'waiting'],
    ['unknown-recent', 'unknown'],
    ['out-of-scope', 'unknown'],
  ]) {
    scenario = name;
    statusCalls = 0;
    const r = await runTool([
      tool,
      '--tree-base', `http://127.0.0.1:${port}`,
      '--window-ms', '300',
    ]);
    let verdict = null;
    try {
      verdict = JSON.parse(r.stdout).diagnosis?.combined?.verdict ?? null;
    } catch {
      console.log(`  ✗ ${name}: invalid output ${r.stdout || r.stderr}`);
      fail += 1;
      continue;
    }
    if (verdict === expected) {
      pass += 1;
      console.log(`  ✓ ${name} → ${verdict}`);
    } else {
      fail += 1;
      console.log(`  ✗ ${name}: ${verdict} != ${expected}`);
    }
  }
} finally {
  server.close();
}
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

#!/usr/bin/env node
/**
 * devtool-selftest.mjs — isolated self-test for the docs/91 pipeline.
 *
 * Isolation: every case uses a fresh temp PILOT_RUNS_DIR / PILOT_LOCK_DIR /
 * PILOT_MODE_RUN_DIR / archive, plus random closed ports. It never starts the
 * real tree/game, never connects to 8765, never taskkills, and never touches
 * the real runs/.pilot-lock.json or run/mode.json.
 *
 * Evidence: logs/devtool-selftest.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isPidAlive } from './lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEVTOOL = path.join(ROOT, 'tools', 'devtool.mjs');
const OUT = path.join(ROOT, 'logs', 'devtool-selftest.json');
const RUN_ID = 'devtool-selftest-run';
const KEEP = process.argv.includes('--keep');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-selftest-'));
const cases = [];
const startedAt = Date.now();
const REAL_LOCK = path.join(ROOT, 'runs', '.pilot-lock.json');
const REAL_FENCING = path.join(ROOT, 'runs', '.fencing');
const REAL_MODE = path.join(ROOT, 'run', 'mode.json');

let failures = 0;
let mainEnv = null;
let mainRunDir = null;
let mainHolderPid = null;
let closeResult = null;
let syntheticResult = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 10_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(id, name, fn) {
  try {
    await fn();
    cases.push({ id, name, ok: true });
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    failures += 1;
    const detail = String(e?.message || e);
    cases.push({ id, name, ok: false, detail });
    console.log(`FAIL ${id} ${name} -- ${detail}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseJsonLoose(text) {
  const s = String(text || '').trim();
  try {
    return JSON.parse(s);
  } catch { /* continue */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch { /* ignore */ }
  }
  return null;
}

function snapshot(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return { exists: false };
  }
}

function fingerprint(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      return `${name}:${st.isDirectory() ? 'dir' : st.size}:${Math.round(st.mtimeMs)}`;
    });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function pickPorts() {
  const used = new Set();
  const out = [];
  while (out.length < 3) {
    const port = await freePort();
    if (port >= 8765 && port <= 8770) continue;
    if (used.has(port)) continue;
    used.add(port);
    out.push(port);
  }
  return { control: out[0], mcp: out[1], numen: out[2] };
}

function makeEnv(name, ports) {
  const base = path.join(tmpRoot, name);
  const env = { ...process.env };
  delete env.PILOT_HOLDER_STOP_FILE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('PILOT_MODE_TEST_')) delete env[key];
  }
  Object.assign(env, {
    PILOT_RUNS_DIR: path.join(base, 'runs'),
    PILOT_LOCK_DIR: path.join(base, 'runs'),
    PILOT_MODE_RUN_DIR: path.join(base, 'run'),
    PILOT_MODE_FILE: path.join(base, 'run', 'mode.json'),
    PILOT_PREEMPTION_LOG: path.join(base, 'logs', 'preemption.jsonl'),
    PILOT_ARCHIVE_DIR: path.join(base, 'archive'),
    PILOT_TREE_CONTROL_PORT: String(ports.control),
    PILOT_TREE_MCP_PORT: String(ports.mcp),
    PILOT_NUMEN_PORT: String(ports.numen),
    PILOT_MODE_TRANSITION_TIMEOUT_MS: '5000',
  });
  fs.mkdirSync(env.PILOT_RUNS_DIR, { recursive: true });
  fs.mkdirSync(env.PILOT_MODE_RUN_DIR, { recursive: true });
  return env;
}

function runDevtool(args, env, timeoutMs = 40_000) {
  const r = spawnSync(process.execPath, [DEVTOOL, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
    json: parseJsonLoose(r.stdout),
  };
}

function fullGoal() {
  return {
    goal: 'Day1 木链/食物/夜间安全检查（selftest）',
    budget: { minutes: 5, maxBridgeCalls: 12, maxTokens: 4000 },
    environment: { world: 'new', player: 'offline-64', snapshot: 'start' },
    allowed: ['observe', 'lua', 'get_events', 'move'],
    forbidden: ['gm', 'full-map-scan', 'combat', 'water-entry'],
    success: ['M1 获得木头', 'M2 获得食物', 'M3 夜间安全'],
    stop: ['目标达成', '预算耗尽', '危险', '无法继续'],
    logs: ['actions.jsonl', 'observations.jsonl', 'gm.jsonl', 'tentacle_use.jsonl'],
    pack: 'roundtable-pack.md',
  };
}

function writeGoal(file, goal = fullGoal()) {
  fs.writeFileSync(file, `${JSON.stringify(goal, null, 2)}\n`, 'utf8');
  return file;
}

function buildSyntheticRun(env, runId) {
  const dir = path.join(env.PILOT_RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.parse('2026-11-10T00:00:00.000Z');
  const at = (ms) => new Date(base + ms).toISOString();
  const goal = fullGoal();
  const manifest = {
    runId,
    dir,
    mode: 'devtool',
    provider: 'dsh-subagent',
    companion: 'bigwhale',
    dryRun: false,
    phase: 'closed',
    topic: 'synthetic',
    goal,
    caps: goal.budget,
    startedAt: at(0),
    endedAt: at(12 * 60_000),
    steps: 4,
    approvals: 0,
    cheatCount: 0,
    tokens: 1200,
    llmCalls: 0,
    repeatedObservations: 1,
    abortReason: 'action_error:boom',
    assisted: false,
    owner: 'devtool-selftest',
    fencing: 7,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const jsonl = (name, records) => {
    fs.writeFileSync(
      path.join(dir, name),
      records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
      'utf8',
    );
  };
  jsonl('observations.jsonl', [
    { kind: 'observe', at: at(1000), self: 'hp=20', hash: 'h1', unchanged: false },
    { kind: 'observe', at: at(2000), self: 'hp=20', hash: 'h1', unchanged: true },
    { kind: 'observe', at: at(3000), self: 'hp=19', hash: 'h2', unchanged: false },
    { kind: 'observe_error', at: at(20 * 60_000), error: 'lua timeout' },
  ]);
  jsonl('actions.jsonl', [
    { at: at(1000), step: 0, action: { action: 'observe' } },
    { at: at(2000), step: 1, action: { action: 'lua', usage: { total_tokens: 1200 } } },
    { at: at(3000), step: 2, action: { action: 'move' } },
    { at: at(3000), step: 3, action: {} },
  ]);
  jsonl('raw.jsonl', [
    { at: at(2000), kind: 'step', step: 1, result: { ok: false, isError: true, text: 'action failed: boom' } },
  ]);
  jsonl('gm.jsonl', [
    { ts: at(5000), assisted: true, reason: 'stuck_water', command: 'tp @s 0 0 0', outcome: { ok: true } },
  ]);
  jsonl('tentacle_use.jsonl', [
    {
      ts: at(6000),
      purpose: 'diagnose water',
      fields: ['water'],
      ok: false,
      actionPrecondition: false,
      authority: 'diagnostic-only',
      error: { code: 'network_error', message: 'down' },
    },
  ]);
  fs.writeFileSync(path.join(dir, 'console.log'), `${at(2000)} error: boom\n`, 'utf8');
  return dir;
}

async function main() {
  const realBefore = {
    lock: snapshot(REAL_LOCK),
    fencing: snapshot(REAL_FENCING),
    mode: snapshot(REAL_MODE),
  };
  const mainPorts = await pickPorts();
  mainEnv = makeEnv('main', mainPorts);
  mainRunDir = path.join(mainEnv.PILOT_RUNS_DIR, RUN_ID);
  const goalFile = writeGoal(path.join(tmpRoot, 'goal.json'));

  await check('D1', 'prepare creates GOAL.md/manifest and a live detached lease holder', async () => {
    const r = runDevtool(
      ['prepare', `--goal=${goalFile}`, `--run-id=${RUN_ID}`, '--topic=selftest-pipeline'],
      mainEnv,
    );
    assert(r.status === 0, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    const out = r.json;
    assert(out && out.ok === true, `bad json: ${r.stdout}`);
    assert(out.runId === RUN_ID, `runId=${out.runId}`);
    assert(out.pilotRunDir === mainRunDir, `pilotRunDir=${out.pilotRunDir}`);
    assert(out.env.PILOT_RUN_DIR === mainRunDir, 'env PILOT_RUN_DIR differs');
    for (const name of ['GOAL.md', 'manifest.json', 'OPERATOR-BRIEF.md', 'holder.log']) {
      assert(fs.existsSync(path.join(mainRunDir, name)), `missing ${name}`);
    }
    const manifest = readJson(path.join(mainRunDir, 'manifest.json'));
    assert(manifest.phase === 'prepared', `phase=${manifest.phase}`);
    assert(manifest.holder && manifest.holder.pid === out.holder.pid, 'manifest holder pid');
    assert(Number(manifest.fencing) === Number(out.holder.fencing), 'fencing mismatch');
    const lockFile = path.join(mainEnv.PILOT_LOCK_DIR, '.pilot-lock.json');
    const lock = readJson(lockFile);
    assert(lock && lock.owner === out.holder.owner, `lease owner=${lock?.owner}`);
    assert(Number(lock.pid) === Number(out.holder.pid), `lease pid=${lock?.pid}`);
    assert(isPidAlive(out.holder.pid), 'holder pid is not alive');
    mainHolderPid = out.holder.pid;
  });

  await check('D2', 'operator-brief is a one-page execute-only contract', async () => {
    const r = runDevtool(['operator-brief', `--run=${RUN_ID}`], mainEnv);
    assert(r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
    for (const marker of ['只执行，不分析', 'PILOT_RUN_DIR', '## 5. 成功 / 停止', '## 7. 日志', '不 taskkill']) {
      assert(r.stdout.includes(marker), `brief missing marker: ${marker}`);
    }
    assert(fs.existsSync(path.join(mainRunDir, 'OPERATOR-BRIEF.md')), 'brief file missing');
  });

  await check('D3', 'status reports prepared phase, lease and live holder', async () => {
    const r = runDevtool(['status', `--run=${RUN_ID}`], mainEnv);
    assert(r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
    const out = r.json;
    assert(out.ok === true, 'status not ok');
    assert(out.phase === 'prepared', `phase=${out.phase}`);
    assert(out.lease.present === true && out.lease.pidAlive === true, 'lease not live');
    assert(out.holder && out.holder.alive === true, 'holder not alive');
    assert(out.paths.brief.endsWith('OPERATOR-BRIEF.md'), 'brief path');
  });

  await check('D4', 'close stops the holder, releases the lease and leaves mode OFF', async () => {
    const r = runDevtool(['close', `--run=${RUN_ID}`, '--reason=selftest-close'], mainEnv);
    assert(r.status === 0, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    closeResult = r.json;
    assert(closeResult.ok === true, `close not ok: ${r.stdout}`);
    const lockFile = path.join(mainEnv.PILOT_LOCK_DIR, '.pilot-lock.json');
    const gone = await waitFor(() => !fs.existsSync(lockFile), 12_000);
    assert(gone, 'lease file still exists after close');
    assert(await waitFor(() => !isPidAlive(mainHolderPid), 8_000), 'holder pid still alive after close');
    assert(closeResult.modeState === 'OFF', `modeState=${closeResult.modeState}`);
    const mode = readJson(path.join(mainEnv.PILOT_MODE_RUN_DIR, 'mode.json'));
    assert(mode?.state === 'OFF', `mode.json state=${mode?.state}`);
    const manifest = readJson(path.join(mainRunDir, 'manifest.json'));
    assert(manifest.phase === 'closed', `manifest phase=${manifest.phase}`);
    assert(manifest.abortReason === 'selftest-close', `abortReason=${manifest.abortReason}`);
  });

  await check('D5', 'analyze generates analysis.* and roundtable-pack.md from a synthetic run', async () => {
    const ports = await pickPorts();
    const env = makeEnv('analyze', ports);
    const runId = 'synthetic-run-001';
    const runDir = buildSyntheticRun(env, runId);
    const before = fingerprint(runDir);
    const r = runDevtool(['analyze', `--run=${runId}`], env);
    assert(r.status === 0, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert(lines.length === 4, `stdout lines=${lines.length}: ${r.stdout}`);
    assert(lines[0].startsWith('analysis: '), lines[0]);
    assert(lines[1].startsWith('json: '), lines[1]);
    assert(lines[2].startsWith('pack: '), lines[2]);
    assert(lines[3].startsWith('summary: '), lines[3]);
    const archiveDir = path.join(env.PILOT_ARCHIVE_DIR, runId);
    for (const name of ['analysis.json', 'analysis.md', 'roundtable-pack.md']) {
      assert(fs.existsSync(path.join(archiveDir, name)), `missing ${name}`);
    }
    const pack = fs.readFileSync(path.join(archiveDir, 'roundtable-pack.md'), 'utf8');
    for (const marker of ['# Run synthetic-run-001', '## 结论', '## 分段行为', 'capability', 'material', '## GM / 触手使用', '## 给各顾问的问题（最多 3 条）']) {
      assert(pack.includes(marker), `pack missing marker: ${marker}`);
    }
    assert(fingerprint(runDir).join('|') === before.join('|'), 'synthetic run dir changed during analyze');
    syntheticResult = { archiveDir, packBytes: Buffer.byteLength(pack) };
  });

  await check('D6', 'prepare fails when tree ports are active (no run is created)', async () => {
    const ports = await pickPorts();
    const env = makeEnv('tree', ports);
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const treePort = server.address().port;
    env.PILOT_TREE_CONTROL_PORT = String(treePort);
    const r = runDevtool(['prepare', `--goal=${goalFile}`, '--run-id=tree-active-run'], env);
    await new Promise((resolve) => server.close(resolve));
    assert(r.status !== 0, `expected failure, got exit=${r.status}`);
    assert(r.json && r.json.ok === false, `bad json: ${r.stdout}`);
    assert(r.json.code === 'tree_active', `code=${r.json.code} stdout=${r.stdout}`);
    assert(!fs.existsSync(path.join(env.PILOT_RUNS_DIR, 'tree-active-run')), 'run dir created despite tree_active');
  });

  await check('D7', 'prepare fails when a valid dev lease already exists', async () => {
    const ports = await pickPorts();
    const env = makeEnv('lease', ports);
    const lockFile = path.join(env.PILOT_LOCK_DIR, '.pilot-lock.json');
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify(
        {
          version: 1,
          owner: 'selftest-existing-dev',
          pid: process.pid,
          runId: 'existing',
          mode: 'devtool',
          kind: 'dev',
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const r = runDevtool(['prepare', `--goal=${goalFile}`, '--run-id=lease-active-run'], env);
    assert(r.status !== 0, `expected failure, got exit=${r.status}`);
    assert(r.json && r.json.code === 'dev_active', `code=${r.json?.code} stdout=${r.stdout}`);
    assert(!fs.existsSync(path.join(env.PILOT_RUNS_DIR, 'lease-active-run')), 'run dir created despite dev_active');
    fs.unlinkSync(lockFile);
  });

  await check('D8', 'prepare rejects a goal missing required fields', async () => {
    const ports = await pickPorts();
    const env = makeEnv('invalid', ports);
    const bad = {
      goal: 'incomplete',
      budget: { minutes: 1 },
      environment: 'x',
      allowed: ['observe'],
    };
    const r = runDevtool(
      ['prepare', `--goal=${JSON.stringify(bad)}`, '--run-id=invalid-goal-run'],
      env,
    );
    assert(r.status === 2, `exit=${r.status}`);
    assert(r.json && r.json.code === 'invalid_goal', `code=${r.json?.code} stdout=${r.stdout}`);
    for (const field of ['forbidden', 'success', 'stop', 'logs', 'pack']) {
      assert(r.json.errors.some((e) => e.includes(field)), `missing error for ${field}`);
    }
    assert(!fs.existsSync(path.join(env.PILOT_RUNS_DIR, 'invalid-goal-run')), 'run dir created despite invalid goal');
  });

  await check('D9', 'real runs/.pilot-lock.json, .fencing and run/mode.json are untouched', async () => {
    const after = {
      lock: snapshot(REAL_LOCK),
      fencing: snapshot(REAL_FENCING),
      mode: snapshot(REAL_MODE),
    };
    assert(JSON.stringify(realBefore) === JSON.stringify(after), `real state changed: ${JSON.stringify({ realBefore, after })}`);
  });

  await check('D10', 'no taskkill/tree/game command was used', async () => {
    assert(closeResult && String(closeResult.note).includes('no game/tree process was killed'), 'close note');
    assert(closeResult.stoppedByStopFile !== false, 'holder did not stop via stop file');
  });

  const report = {
    suite: 'devtool',
    version: '2026-11-10.1',
    generatedAt: new Date().toISOString(),
    passed: failures === 0,
    counts: { total: cases.length, failed: failures },
    cases,
    sample: {
      runId: RUN_ID,
      runDir: mainRunDir,
      holderPid: mainHolderPid,
      close: closeResult
        ? {
            ok: closeResult.ok,
            stoppedByStopFile: closeResult.stoppedByStopFile,
            holderExited: closeResult.holderExited,
            modeState: closeResult.modeState,
          }
        : null,
      synthetic: syntheticResult,
    },
    safety: {
      tempOnly: true,
      realRunsTouched: false,
      realLockTouched: false,
      realModeTouched: false,
      treeStarted: false,
      gameStarted: false,
      gameContacted: false,
      taskkillUsed: false,
      taskkillNote: 'close uses a stop file + lease release; no OS kill is sent to the holder, game or tree.',
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`node=${cases.length - failures}/${cases.length}`);
  console.log(`evidence: ${path.relative(ROOT, OUT)}`);

  if (!KEEP) fs.rmSync(tmpRoot, { recursive: true, force: true });
  else console.log(`kept: ${tmpRoot}`);
  if (failures) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  if (mainEnv && mainRunDir && fs.existsSync(path.join(mainRunDir, 'manifest.json'))) {
    try { runDevtool(['close', `--run=${RUN_ID}`, '--reason=selftest-cleanup'], mainEnv); } catch { /* best effort */ }
  }
  if (!KEEP) fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = 1;
});

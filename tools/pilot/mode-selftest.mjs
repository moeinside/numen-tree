#!/usr/bin/env node
/**
 * mode-selftest.mjs — repeatable MVP self-test (no GM).
 *
 * T1 clean tree-start allowed (100%)
 * T2 dev lease blocks tree start (incl. protect + TTL)
 * T3 stale lease + dead PID recovery
 * T4 force failure/confirmation/crash -> OFF
 * T5 force idempotency
 * T6 concurrent force
 * T7 Track A replay unaffected while tools OFF
 * T8 fencing rejects old lease
 * T9 transition timeout -> OFF
 * T10 force-tree does not kill the dev holder
 *
 * Isolation: temp dirs + fake ports; never starts real tree or touches real locks.
 * Evidence: logs/mode-selftest.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MODE = path.join(HERE, 'mode.mjs');
const TREE_START = path.join(ROOT, 'tools', 'tree-start.mjs');
const REPLAY = path.join(ROOT, 'probe', 'replay.mjs');
const OUT = path.join(ROOT, 'logs', 'mode-selftest.json');
const VERSION = '2026-11-10.2';

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg
  ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const KEEP = argv.includes('--keep');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-selftest-'));
const checks = [];
const startedAt = Date.now();
let ports = null;
let mode = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 10_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  try { return JSON.parse(s); } catch { /* continue */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

function add(id, name, ok, detail = null) {
  checks.push({ id, name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}`);
}

function skip(id, name, why) {
  checks.push({ id, name, ok: null, skipped: true, detail: { why } });
  console.log(`SKIP ${id} ${name} (${why})`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function pickPorts() {
  const used = new Set();
  const out = [];
  while (out.length < 3) {
    const p = await freePort();
    if (p === 8765 || p === 8766 || p === 8767 || p === 8768 || p === 8769 || p === 8770) continue;
    if (used.has(p)) continue;
    used.add(p);
    out.push(p);
  }
  return { control: out[0], mcp: out[1], numen: out[2] };
}

function applyEnv(name) {
  const base = path.join(tmpRoot, name);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('PILOT_MODE_TEST_')) delete env[k];
  }
  Object.assign(env, {
    PILOT_LOCK_DIR: path.join(base, 'runs'),
    PILOT_MODE_RUN_DIR: path.join(base, 'run'),
    PILOT_MODE_FILE: path.join(base, 'run', 'mode.json'),
    PILOT_PREEMPTION_LOG: path.join(base, 'logs', 'preemption.jsonl'),
    PILOT_TREE_CONTROL_PORT: String(ports.control),
    PILOT_TREE_MCP_PORT: String(ports.mcp),
    PILOT_NUMEN_PORT: String(ports.numen),
    PILOT_MODE_EXTERNAL: 'noop',
    PILOT_MODE_TRANSITION_TIMEOUT_MS: '2000',
  });
  process.env = env;
  return env;
}

function runNode(script, args = [], { env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${e.message}`, error: e });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function stopChild(child, sig = 'SIGTERM') {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((res) => child.once('exit', res));
  try { child.kill(sig); } catch { /* ignore */ }
  const timeout = sleep(5_000).then(() => 'timeout');
  const r = await Promise.race([exited, timeout]);
  if (r === 'timeout') {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await new Promise((res) => child.once('exit', res));
  }
}

async function startHolder(owner, runId, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const child = spawn(
    process.execPath,
    [MODE, 'dev', '--hold', `--owner=${owner}`, `--run-id=${runId}`, '--ttl-ms=60000'],
    { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { err += b.toString(); });
  const ready = await waitFor(() => out.includes('"ready": true'), 10_000);
  if (ready) {
    await waitFor(
      () => !fs.existsSync(path.join(process.env.PILOT_MODE_RUN_DIR, '.mode-transition.lock')),
      3_000,
    );
    await sleep(300);
  }
  return { child, ready, stdout: () => out, stderr: () => err };
}

function auditEvents() {
  const p = process.env.PILOT_PREEMPTION_LOG;
  try {
    return fs.readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasAudit(kind) {
  return auditEvents().some((e) => e.kind === kind);
}

function listLeaseDir() {
  try { return fs.readdirSync(process.env.PILOT_LOCK_DIR); } catch { return []; }
}

const checksById = {
  async T1() {
    applyEnv('t1');
    const closed = { control: ports.control, mcp: ports.mcp };
    const allowed = [];
    for (let i = 0; i < 20; i += 1) {
      const g = await mode.guardCheck({ ports: closed, repair: true });
      allowed.push(g.ok === true);
    }
    const dry = await runNode(TREE_START, ['--dry-run', '--json'], { timeoutMs: 20_000 });
    const dryJson = parseJsonLoose(dry.stdout);

    const base = path.join(tmpRoot, 't1');
    fs.mkdirSync(base, { recursive: true });
    const marker = path.join(base, 'fake-started.txt');
    const fake = path.join(base, 'fake-daemon.mjs');
    fs.writeFileSync(fake, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'ok');\nsetTimeout(() => process.exit(0), 300);\n`);
    const started = await runNode(TREE_START, ['--json'], {
      env: { ...process.env, PILOT_TREE_TEST_CMD: fake },
      timeoutMs: 20_000,
    });
    const afterStart = await mode.getStatus({ repair: true });
    const markerExists = fs.existsSync(marker);

    const ok =
      allowed.every(Boolean) &&
      dry.code === 0 && dryJson?.ok === true &&
      started.code === 0 && markerExists &&
      afterStart.state === 'OFF' && afterStart.lease === null;
    add('T1', 'clean_start_allowed_100', ok, {
      allowed: `${allowed.filter(Boolean).length}/20`,
      dryRunExit: dry.code,
      dryRunState: dryJson?.state ?? null,
      dryRunWarnings: dryJson?.warnings ?? null,
      actualStartExit: started.code,
      actualChildStarted: markerExists,
      stateAfterStart: afterStart.state,
      leaseAfterStart: afterStart.lease,
    });
  },

  async T2() {
    applyEnv('t2');
    let holder = null;
    try {
      holder = await startHolder('selftest-dev', 't2-dev');
      if (!holder.ready) throw new Error('holder not ready');
      const g1 = await mode.guardCheck({ ports: { control: ports.control, mcp: ports.mcp } });
      const dry1 = await runNode(TREE_START, ['--dry-run'], { timeoutMs: 20_000 });
      const dryJson1 = parseJsonLoose(dry1.stdout);
      const p = await runNode(MODE, ['protect', 'on', '--owner=selftest-dev', '--run-id=t2-dev', '--reason=selftest', '--ttl-ms=60000'], { timeoutMs: 20_000 });
      const g2 = await mode.guardCheck({ ports: { control: ports.control, mcp: ports.mcp } });
      const st = await mode.getStatus({ repair: true });
      const pOff = await runNode(MODE, ['protect', 'off', '--owner=selftest-dev'], { timeoutMs: 20_000 });
      const st2 = await mode.getStatus({ repair: true });
      const pTtl = await mode.protectOn({ owner: 'selftest-dev', runId: 't2-dev', reason: 'ttl', ttlMs: 300 });
      await sleep(700);
      const stTtl = await mode.getStatus({ repair: true });
      await mode.protectOff({ owner: 'selftest-dev' });
      const ok =
        g1.ok === false && g1.code === 'dev_active' &&
        dry1.code === 3 && dryJson1?.code === 'dev_active' &&
        p.code === 0 &&
        g2.ok === false && g2.code === 'dev_protected' && st.state === 'DEV_PROTECTED' &&
        pOff.code === 0 && st2.state === 'DEV' &&
        pTtl.ok && stTtl.state === 'DEV';
      add('T2', 'dev_lease_blocks_tree_start', ok, {
        guard1: { ok: g1.ok, code: g1.code },
        treeStartExit: dry1.code,
        protectOnExit: p.code,
        guard2: { ok: g2.ok, code: g2.code },
        stateProtected: st.state,
        protectOffExit: pOff.code,
        stateAfterOff: st2.state,
        protectTtlState: stTtl.state,
      });
    } finally {
      if (holder) await stopChild(holder.child);
      await sleep(300);
    }
  },

  async T3() {
    applyEnv('t3');
    let holder = null;
    try {
      holder = await startHolder('selftest-stale', 't3-stale');
      if (!holder.ready) throw new Error('holder not ready');
      const before = readJson(path.join(process.env.PILOT_LOCK_DIR, '.pilot-lock.json'));
      const exited = new Promise((res) => holder.child.once('exit', res));
      holder.child.kill('SIGKILL');
      await exited;
      await sleep(300);
      const raw = await mode.getStatus({ repair: false });
      const leaseExistsAfterKill = fs.existsSync(path.join(process.env.PILOT_LOCK_DIR, '.pilot-lock.json'));
      const g = await mode.guardCheck({ ports: { control: ports.control, mcp: ports.mcp } });
      const after = await mode.getStatus({ repair: true });
      const archived = listLeaseDir().some((n) => n.startsWith('.pilot-lock.stale.'));
      const ok =
        !!before?.owner &&
        leaseExistsAfterKill &&
        raw.leaseValid === 'stale' &&
        g.ok === true &&
        after.state === 'OFF' &&
        after.lease === null &&
        archived;
      add('T3', 'stale_lease_recovery', ok, {
        owner: before?.owner ?? null,
        leaseExistsAfterKill,
        staleReason: raw.leaseValid,
        guard: { ok: g.ok, state: g.state },
        stateAfter: after.state,
        archived,
      });
    } finally {
      if (holder) await stopChild(holder.child);
    }
  },

  async T4() {
    applyEnv('t4a');
    const noConfirm = await runNode(MODE, ['force-tree'], { timeoutMs: 10_000 });
    const noConfirmJson = parseJsonLoose(noConfirm.stdout);
    const fakeFail = {
      handoff: async () => ({ ok: false, error: 'simulated handoff fail' }),
      clearLocks: async () => ({ via: 'fake', status: 0 }),
    };
    const r1 = await mode.forceTree({ external: fakeFail });
    const s1 = await mode.getStatus({ repair: true });
    const noTransition1 = !fs.existsSync(process.env.PILOT_MODE_RUN_DIR + '/.mode-transition.lock');

    applyEnv('t4b');
    const envCrash = { ...process.env, PILOT_MODE_TEST_ABORT: 'force-tree' };
    const crash = await runNode(MODE, ['force-tree', '--yes'], { env: envCrash, timeoutMs: 20_000 });
    const during = readJson(process.env.PILOT_MODE_FILE);
    const rec = await runNode(MODE, ['recover'], { timeoutMs: 20_000 });
    const s2 = await mode.getStatus({ repair: true });
    const ok =
      noConfirm.code === 2 && noConfirmJson?.code === 'confirmation_required' &&
      r1.ok === false && r1.code === 'transition_failed' &&
      s1.state === 'OFF' && s1.lease === null && noTransition1 &&
      crash.code === 9 && during?.state === 'TRANSITION' &&
      rec.code === 0 && s2.state === 'OFF' && s2.lease === null &&
      hasAudit('transition_recovered');
    add('T4', 'force_failure_returns_off', ok, {
      secondConfirmation: { exit: noConfirm.code, code: noConfirmJson?.code ?? null },
      simulated: { ok: r1.ok, code: r1.code, state: s1.state, noTransition: noTransition1 },
      crash: { exit: crash.code, duringState: during?.state ?? null, recoverExit: rec.code, stateAfter: s2.state },
      recoveredAudit: hasAudit('transition_recovered'),
    });
  },

  async T5() {
    applyEnv('t5');
    const t1 = await mode.forceTree({ reason: 'idempotent-1' });
    const t2 = await mode.forceTree({ reason: 'idempotent-2' });
    const stTree = await mode.getStatus({ repair: true });
    const d1 = await mode.forceDev({ owner: 'selftest-force-a', runId: 't5-a', hold: false });
    const d2 = await mode.forceDev({ owner: 'selftest-force-b', runId: 't5-b', hold: false });
    const stDev = await mode.getStatus({ repair: true });
    const monotonic = t1.fencing < t2.fencing && d1.fencing < d2.fencing;
    const ok =
      t1.ok && t2.ok && stTree.state === 'TREE' && stTree.lease === null &&
      d1.ok && d2.ok && stDev.state === 'DEV' && monotonic;
    add('T5', 'force_idempotent', ok, {
      tree: [t1.code ?? 'ok', t2.code ?? 'ok'],
      treeState: stTree.state,
      treeFencing: [t1.fencing, t2.fencing],
      dev: [d1.code ?? 'ok', d2.code ?? 'ok'],
      devState: stDev.state,
      devFencing: [d1.fencing, d2.fencing],
      monotonic,
    });
    await mode.off({ force: true });
  },

  async T6() {
    applyEnv('t6');
    const env = { ...process.env, PILOT_MODE_TEST_DELAY_MS: '1500' };
    const p1 = runNode(MODE, ['force-tree', '--yes', '--reason=concurrent-1'], { env, timeoutMs: 30_000 });
    const p2 = runNode(MODE, ['force-tree', '--yes', '--reason=concurrent-2'], { env, timeoutMs: 30_000 });
    const [r1, r2] = await Promise.all([p1, p2]);
    const codes = [r1.code, r2.code].sort((a, b) => a - b);
    const st = await mode.getStatus({ repair: true });
    const modeJson = readJson(process.env.PILOT_MODE_FILE);
    const transitionLeft = fs.existsSync(path.join(process.env.PILOT_MODE_RUN_DIR, '.mode-transition.lock'));
    const ok =
      codes.length === 2 && codes[0] === 0 && codes[1] === 4 &&
      st.state === 'TREE' && modeJson?.state === 'TREE' && !transitionLeft;
    add('T6', 'concurrent_force', ok, {
      exits: [r1.code, r2.code],
      expected: { ok: 0, busy: 4 },
      finalState: st.state,
      modeJsonState: modeJson?.state ?? null,
      transitionLeft,
      stderr: [r1.stderr.trim().slice(0, 160), r2.stderr.trim().slice(0, 160)],
    });
  },

  async T7() {
    applyEnv('t7');
    const before = await mode.getStatus({ repair: true });
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('PILOT_MODE_TEST_')) delete env[k];
    }
    const replay = await runNode(REPLAY, [], { env, timeoutMs: 120_000 });
    const after = await mode.getStatus({ repair: true });
    const leaseFile = path.join(process.env.PILOT_LOCK_DIR, '.pilot-lock.json');
    const ok =
      replay.code === 0 &&
      /21\/21/.test(replay.stdout) &&
      before.state === 'OFF' &&
      after.state === 'OFF' &&
      !fs.existsSync(leaseFile);
    add('T7', 'track_a_replay_unaffected', ok, {
      replayExit: replay.code,
      replaySummary: replay.stdout.split(/\r?\n/).filter((l) => /21\/21/.test(l)).slice(-3),
      beforeState: before.state,
      afterState: after.state,
      leaseExistsAfter: fs.existsSync(leaseFile),
    });
  },

  async T8() {
    applyEnv('t8');
    const entered = await mode.enterDev({ owner: 'fence-owner', runId: 't8', ttlMs: 60_000 });
    const hbBefore = mode.heartbeatLease({ owner: 'fence-owner', fencing: entered.fencing, ttlMs: 60_000 });
    const forced = await mode.forceTree({ reason: 'fence-test' });
    const hbAfter = mode.heartbeatLease({ owner: 'fence-owner', fencing: entered.fencing, ttlMs: 60_000 });
    const lock = await import('./lock.mjs');
    const resurrect = lock.acquire({
      owner: 'fence-owner',
      runId: 't8-resurrect',
      kind: 'dev',
      fencing: entered.fencing,
      ttlMs: 60_000,
    });
    const guard = await mode.guardCheck({ ports: { control: ports.control, mcp: ports.mcp } });
    const st = await mode.getStatus({ repair: true });
    const ok =
      entered.ok && hbBefore.ok && forced.ok &&
      hbAfter.ok === false && ['not_owner', 'no_lease', 'fencing_mismatch'].includes(hbAfter.code) &&
      resurrect.ok && guard.ok === true && st.state === 'TREE';
    add('T8', 'fencing_rejects_old_lease', ok, {
      fencing: entered.fencing,
      heartbeatBefore: hbBefore.ok,
      forceOk: forced.ok,
      heartbeatAfter: { ok: hbAfter.ok, code: hbAfter.code },
      resurrected: resurrect.ok,
      guard: { ok: guard.ok, code: guard.code ?? null },
      stateAfter: st.state,
    });
    await mode.off({ force: true });
  },

  async T9() {
    applyEnv('t9');
    const runDir = process.env.PILOT_MODE_RUN_DIR;
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, '.mode-transition.lock'), JSON.stringify({
      op: 'force-tree',
      target: 'TREE',
      pid: 999_999,
      token: 'expired-test',
      at: new Date(Date.now() - 60_000).toISOString(),
      deadlineAt: new Date(Date.now() - 30_000).toISOString(),
    }, null, 2));
    fs.writeFileSync(process.env.PILOT_MODE_FILE, JSON.stringify({
      version: 1,
      state: 'TRANSITION',
      transition: { op: 'force-tree', target: 'TREE', deadlineAt: new Date(Date.now() - 30_000).toISOString() },
    }, null, 2));
    const rec = await runNode(MODE, ['recover'], { timeoutMs: 20_000 });
    const st = await mode.getStatus({ repair: true });
    const transitionLeft = fs.existsSync(path.join(runDir, '.mode-transition.lock'));
    const ok = rec.code === 0 && st.state === 'OFF' && !transitionLeft && hasAudit('transition_recovered');
    add('T9', 'transition_timeout_returns_off', ok, {
      recoverExit: rec.code,
      state: st.state,
      transitionLeft,
      recoveredAudit: hasAudit('transition_recovered'),
    });
  },

  async T10() {
    applyEnv('t10');
    const holder = await startHolder('selftest-force-victim', 't10-victim');
    let holderExit = null;
    try {
      if (!holder.ready) throw new Error('holder not ready');
      const forced = await mode.forceTree({ reason: 'no-kill-test' });
      const exited = await Promise.race([
        new Promise((res) => holder.child.once('exit', (code, signal) => res({ code, signal }))),
        sleep(10_000).then(() => ({ timeout: true })),
      ]);
      holderExit = exited;
      const st = await mode.getStatus({ repair: true });
      const ok =
        forced.ok && st.state === 'TREE' &&
        exited && !exited.timeout && exited.code === 3;
      add('T10', 'force_tree_does_not_kill', ok, {
        forceOk: forced.ok,
        holderExit: exited,
        state: st.state,
        note: 'holder detected lost lease and exited with code 3; no SIGTERM/SIGKILL sent',
      });
    } finally {
      if (holderExit == null) await stopChild(holder.child);
    }
  },
};



async function main() {
  ports = await pickPorts();

  mode = await import('./mode.mjs');

  const order = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'];
  for (const id of order) {
    if (ONLY && !ONLY.has(id)) {
      skip(id, id, 'not selected');
      continue;
    }
    try {
      await checksById[id]();
    } catch (e) {
      add(id, checksById[id].name || id, false, { error: String(e?.stack ?? e) });
    }
  }

  const passed = checks.every((c) => c.ok !== false);
  const evidence = {
    at: new Date().toISOString(),
    version: VERSION,
    node: process.version,
    platform: process.platform,
    cwd: ROOT,
    env: {
      lockDir: process.env.PILOT_LOCK_DIR,
      modeFile: process.env.PILOT_MODE_FILE,
      preemptionLog: process.env.PILOT_PREEMPTION_LOG,
      ports,
      external: 'noop',
    },
    checks,
    passed,
    durationMs: Date.now() - startedAt,
    tempRoot: KEEP || !passed ? tmpRoot : '(removed after pass)',
    gmDelivered: false,
    note: 'MVP no GM; isolated temp dirs + fake ports; no real locks/game/tree touched',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.log(`\n${passed ? 'PASS' : 'FAIL'} mode selftest ${checks.filter((c) => c.ok).length}/${checks.filter((c) => !c.skipped).length}`);
  console.log(`evidence: ${OUT}`);

  if (!KEEP && passed) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    console.log(`temp kept: ${tmpRoot}`);
  }
  return passed ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });

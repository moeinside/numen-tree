#!/usr/bin/env node
/**
 * mode.mjs — mutual exclusion state machine (MVP, no GM).
 *
 * Source of truth: runs/.pilot-lock.json (lease) + runs/.fencing (monotonic token).
 * run/mode.json is a human-readable snapshot only, never a lock.
 * Switch mutex: run/.mode-transition.lock.
 *
 * States: OFF / TREE / DEV / DEV_PROTECTED / TRANSITION.
 * Failure or timeout: back to OFF (fail-safe).
 * Scope: docs/86 §8 + §11.3; GM/8770 is not implemented in this MVP.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  acquire,
  release,
  readLock,
  isStale,
  isPidAlive,
  archiveStale,
  lockDir,
  lockPath,
  newOwner,
} from './lock.mjs';
import { handoff, clearLocks, isPortOpen } from './tree-control.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VERSION = '2026-11-10.2';

export const STATES = ['OFF', 'TREE', 'DEV', 'DEV_PROTECTED', 'TRANSITION'];
export { newOwner };
export const EXIT = {
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  BLOCKED: 3,
  BUSY: 4,
  TEST_ABORT: 9,
};



export function runDir() {
  return path.resolve(process.env.PILOT_MODE_RUN_DIR || path.join(ROOT, 'run'));
}

export function modeFile() {
  return path.resolve(process.env.PILOT_MODE_FILE || path.join(runDir(), 'mode.json'));
}

export function transitionFile() {
  return path.join(runDir(), '.mode-transition.lock');
}

export function preemptionFile() {
  return path.resolve(
    process.env.PILOT_PREEMPTION_LOG || path.join(ROOT, 'logs', 'preemption.jsonl'),
  );
}

export function fencingFile() {
  return path.join(lockDir(), '.fencing');
}

export function treePorts() {
  return {
    control: Number(process.env.PILOT_TREE_CONTROL_PORT || 8766),
    mcp: Number(process.env.PILOT_TREE_MCP_PORT || 8767),
  };
}

export function numenPort() {
  return Number(process.env.PILOT_NUMEN_PORT || 8765);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function testDelayMs() {
  return Number(process.env.PILOT_MODE_TEST_DELAY_MS || 0) || 0;
}

function testAbortFor(op) {
  const v = process.env.PILOT_MODE_TEST_ABORT;
  return !!v && (v === op || v === '1');
}



function withSyncFileLock(file, fn, { timeoutMs = 3000, staleMs = 15_000 } = {}) {
  const lock = `${file}.lock`;
  ensureDir(path.dirname(lock));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch { /* lock vanished */ }
      if (Date.now() > deadline) throw new Error(`file lock timeout: ${lock}`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

export function currentFencing() {
  const v = readJson(fencingFile());
  const n = Number(v?.counter);
  return Number.isFinite(n) ? n : 0;
}

export function nextFencing() {
  return withSyncFileLock(fencingFile(), () => {
    const n = currentFencing() + 1;
    writeJsonAtomic(fencingFile(), { counter: n, updatedAt: nowIso(), byPid: process.pid });
    return n;
  });
}



export function readModeFile() {
  return readJson(modeFile());
}

function declaredState() {
  const v = readModeFile()?.state;
  return STATES.includes(v) ? v : null;
}

export function writeModeSnapshot(state, {
  lease = undefined,
  transition = null,
  reason = null,
  fencing = undefined,
  extra = null,
} = {}) {
  if (!STATES.includes(state)) throw new Error(`invalid state: ${state}`);
  const snapshot = {
    version: 1,
    state,
    at: nowIso(),
    reason,
    leasePath: lockPath(),
    lease: lease === undefined ? readLock() : lease,
    fencing: fencing === undefined ? currentFencing() : fencing,
    transition,
    note: 'human-readable snapshot only; lease + fencing are the source of truth',
  };
  if (extra) snapshot.extra = extra;
  writeJsonAtomic(modeFile(), snapshot);
  return snapshot;
}



export function audit(event) {
  const rec = { at: nowIso(), pid: process.pid, ...event };
  try {
    ensureDir(path.dirname(preemptionFile()));
    fs.appendFileSync(preemptionFile(), `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* auditing must not change the safety decision */ }
  return rec;
}



export function leaseKind(lease) {
  return lease?.kind || 'dev';
}

/** Valid iff not stale and fencing matches the current counter (legacy leases without fencing allowed). */
export function readValidLease() {
  const cur = readLock();
  if (!cur) return { lease: null, reason: 'none' };
  if (isStale(cur)) return { lease: cur, reason: 'stale' };
  if (cur.fencing != null && Number(cur.fencing) !== currentFencing()) {
    return { lease: cur, reason: 'fencing_mismatch' };
  }
  return { lease: cur, reason: 'active' };
}

export function protectActive(lease, now = Date.now()) {
  if (!lease?.protect?.enabled) return false;
  const until = Date.parse(lease.protect.until);
  return Number.isFinite(until) && until > now;
}

function stateOfLease(lease, now = Date.now()) {
  if (!lease) return 'OFF';
  if (leaseKind(lease) === 'tree') return 'TREE';
  return protectActive(lease, now) ? 'DEV_PROTECTED' : 'DEV';
}

export async function probePorts(ports = treePorts(), { enabled = true } = {}) {
  if (!enabled) {
    return { control: ports.control, mcp: ports.mcp, numen: numenPort(), controlOpen: null, mcpOpen: null, numenOpen: null };
  }
  const [controlOpen, mcpOpen, numenOpen] = await Promise.all([
    isPortOpen(ports.control, 300),
    isPortOpen(ports.mcp, 300),
    isPortOpen(numenPort(), 300),
  ]);
  return { control: ports.control, mcp: ports.mcp, numen: numenPort(), controlOpen, mcpOpen, numenOpen };
}



export function readTransition() {
  return readJson(transitionFile());
}

function transitionFresh(rec, now = Date.now()) {
  if (!rec) return false;
  if (!isPidAlive(rec.pid)) return false;
  const deadline = Date.parse(rec.deadlineAt);
  return !Number.isFinite(deadline) || deadline > now;
}

function removeTransition(token = null) {
  const cur = readTransition();
  if (!cur) return { removed: false };
  if (token && cur.token !== token) return { removed: false, error: 'token mismatch' };
  try {
    fs.unlinkSync(transitionFile());
    return { removed: true, rec: cur };
  } catch (e) {
    return { removed: false, error: String(e?.message ?? e) };
  }
}

function acquireTransition({ op, target, actor, timeoutMs }) {
  ensureDir(runDir());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rec = {
      op,
      target,
      actor: actor || process.env.USERNAME || 'unknown',
      pid: process.pid,
      token: crypto.randomBytes(8).toString('hex'),
      at: nowIso(),
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    };
    try {
      const fd = fs.openSync(transitionFile(), 'wx');
      fs.writeSync(fd, JSON.stringify(rec, null, 2));
      fs.closeSync(fd);
      return { ok: true, rec };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const cur = readTransition();
      if (transitionFresh(cur)) return { ok: false, busy: true, holder: cur };
      try { fs.unlinkSync(transitionFile()); } catch { /* ignore */ }
    }
  }
  return { ok: false, busy: true, holder: readTransition() };
}

function transitionTimeoutMs(kind, explicit) {
  if (explicit) return explicit;
  const env = Number(process.env.PILOT_MODE_TRANSITION_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return kind === 'force' ? 300_000 : 15_000;
}



/** Fail-safe cleanup, triggered by the next mode/tree-start operation. */
export function reconcile({ repair = true, now = Date.now() } = {}) {
  const report = { ok: true, actions: [], warnings: [] };
  const tr = readTransition();
  if (transitionFresh(tr, now)) {
    report.transition = 'active';
    return report;
  }
  if (tr) {
    report.actions.push('transition_expired');
    if (repair) {
      removeTransition();
      const rel = release({ force: true });
      report.actions.push(rel.released ? 'lease_released' : 'lease_none');
      writeModeSnapshot('OFF', { lease: null, reason: 'transition_timeout', fencing: currentFencing() });
      audit({
        op: 'recover',
        kind: 'transition_recovered',
        from: 'TRANSITION',
        to: 'OFF',
        detail: { transition: tr, release: rel },
      });
    }
  }

  const info = readValidLease();
  if (info.reason === 'stale' || info.reason === 'fencing_mismatch') {
    report.actions.push(`lease_${info.reason}`);
    if (repair) {
      archiveStale(info.reason);
      const keepTree = readModeFile()?.state === 'TREE';
      writeModeSnapshot(keepTree ? 'TREE' : 'OFF', {
        lease: null,
        reason: `lease_${info.reason}`,
        fencing: currentFencing(),
      });
      audit({
        op: 'recover',
        kind: 'stale_recovered',
        from: stateOfLease(info.lease),
        to: keepTree ? 'TREE' : 'OFF',
        detail: { reason: info.reason, lease: info.lease },
      });
    }
  }

  if (repair) {
    const mode = readModeFile();
    if (!readTransition() && mode?.state === 'TRANSITION') {
      writeModeSnapshot('OFF', { lease: null, reason: 'transition_without_lock', fencing: currentFencing() });
      report.actions.push('transition_without_lock');
      audit({ op: 'recover', kind: 'transition_without_lock', from: 'TRANSITION', to: 'OFF' });
    }
    if (!readLock() && ['DEV', 'DEV_PROTECTED'].includes(mode?.state)) {
      writeModeSnapshot('OFF', { lease: null, reason: 'lease_missing', fencing: currentFencing() });
      report.actions.push('dev_without_lease');
      audit({ op: 'recover', kind: 'dev_without_lease', from: mode.state, to: 'OFF' });
    }
  }
  return report;
}



export async function effectiveState({ ports = null, leaseInfo = null } = {}) {
  const tr = readTransition();
  if (transitionFresh(tr)) return 'TRANSITION';
  const info = leaseInfo || readValidLease();
  if (info.reason === 'active') return stateOfLease(info.lease);
  const p = ports || await probePorts();
  if (p.controlOpen || p.mcpOpen) return 'TREE';
  const declared = declaredState();
  if (declared === 'TREE') return 'TREE';
  return 'OFF';
}

export async function getStatus({ repair = true, ports = null } = {}) {
  const reconciled = repair ? reconcile({ repair: true }) : { actions: [], warnings: [] };
  const info = readValidLease();
  const p = ports || await probePorts();
  const state = await effectiveState({ ports: p, leaseInfo: info });
  const tr = readTransition();
  const mode = readModeFile();
  return {
    version: VERSION,
    state,
    declared: mode?.state ?? null,
    lease: info.lease,
    leaseValid: info.reason,
    fence: currentFencing(),
    transition: transitionFresh(tr) ? tr : null,
    ports: p,
    paths: {
      lock: lockPath(),
      mode: modeFile(),
      transition: transitionFile(),
      preemption: preemptionFile(),
      fencing: fencingFile(),
    },
    reconciled: reconciled.actions,
    warnings: reconciled.warnings,
  };
}

function blocked(code, message, extra = {}) {
  return { ok: false, code, error: message, ...extra };
}

/**
 * Tree-start gate. Clean state must always pass; unknown errors fail open
 * unless PILOT_GUARD_FAIL_CLOSED=1.
 */
export async function guardCheck({
  failClosed = process.env.PILOT_GUARD_FAIL_CLOSED === '1',
  repair = true,
  ports = null,
} = {}) {
  const warnings = [];
  try {
    const rec = reconcile({ repair });
    if (rec.actions.length) warnings.push(...rec.actions);
    const p = ports || await probePorts();
    const info = readValidLease();
    const state = await effectiveState({ ports: p, leaseInfo: info });

    if (rec.transition === 'active') {
      audit({ op: 'tree-start', kind: 'guard_refused', code: 'transition_busy', state });
      return await blockedResult('transition_busy', 'mode transition in progress', { state: 'TRANSITION', p, info, warnings });
    }

    if (info.reason === 'active') {
      const kind = leaseKind(info.lease);
      if (kind === 'dev') {
        const code = protectActive(info.lease) ? 'dev_protected' : 'dev_active';
        const detail = {
          owner: info.lease.owner,
          pid: info.lease.pid,
          runId: info.lease.runId,
          fencing: info.lease.fencing,
          protect: info.lease.protect ?? null,
        };
        audit({ op: 'tree-start', kind: 'guard_refused', code, state, detail });
        return await blockedResult(code, `dev holds numen MCP lease (${info.lease.owner})`, { state, p, info, warnings });
      }
      const treeCode = (p.controlOpen || p.mcpOpen) ? 'tree_already_running' : 'tree_lease_active';
      audit({ op: 'tree-start', kind: 'guard_refused', code: treeCode, state, detail: info.lease });
      return await blockedResult(treeCode, 'tree lease already active', { state, p, info, warnings });
    }
    if (p.controlOpen || p.mcpOpen) {
      audit({ op: 'tree-start', kind: 'guard_refused', code: 'tree_already_running', state, detail: p });
      return await blockedResult('tree_already_running', 'tree control/MCP port already listening', { state: 'TREE', p, info, warnings });
    }
    if (info.reason !== 'none' && info.reason !== 'active') {
      warnings.push(`lease_${info.reason}_ignored`);
    }
    return { ok: true, state, lease: null, ports: p, warnings };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (failClosed) {
      audit({ op: 'tree-start', kind: 'guard_error', code: 'guard_error', detail: msg, failClosed: true });
      return { ok: false, code: 'guard_error', error: msg, warnings, state: 'UNKNOWN', lease: null, ports: null };
    }
    warnings.push(`guard_fail_open:${msg}`);
    audit({ op: 'tree-start', kind: 'guard_error', code: 'guard_fail_open', detail: msg, failClosed: false });
    return { ok: true, state: 'UNKNOWN', lease: null, ports: null, warnings, failOpen: true };
  }

  async function blockedResult(code, message, { state, p, info, warnings: w }) {
    return {
      ok: false,
      code,
      error: message,
      state,
      lease: info.lease,
      ports: p,
      warnings: w,
    };
  }
}



/**
 * Serialize a mode switch through the transition lock.
 * failureMode='off' releases the lease and falls back to OFF; 'restore' preserves the prior state.
 */
async function withTransition({
  op,
  target,
  actor,
  timeoutMs,
  bumpFencing = true,
  failureMode = 'off',
  fn,
}) {
  const rec = reconcile({ repair: true });
  const beforeInfo = readValidLease();
  const before = {
    state: await effectiveState({ leaseInfo: beforeInfo }),
    lease: beforeInfo.reason === 'active' ? beforeInfo.lease : null,
  };

  const got = await (async () => {
    let attempt = acquireTransition({ op, target, actor, timeoutMs });
    const deadline = Date.now() + 2_000;
    while (
      !attempt.ok && attempt.holder?.op === 'heartbeat' && Date.now() < deadline
    ) {
      await sleep(40);
      attempt = acquireTransition({ op, target, actor, timeoutMs });
    }
    return attempt;
  })();
  if (!got.ok) {
    audit({ op, kind: 'transition_busy', target, holder: got.holder ?? null });
    return {
      ok: false,
      code: 'transition_busy',
      error: `another transition in progress (${got.holder?.op ?? 'unknown'})`,
      holder: got.holder ?? null,
      reconciled: rec.actions,
    };
  }

  let fencing = bumpFencing ? nextFencing() : currentFencing();
  const deadlineAt = new Date(Date.now() + (timeoutMs > 0 ? timeoutMs : 15_000)).toISOString();
  const transition = {
    op,
    target,
    by: actor || process.env.USERNAME || 'unknown',
    startedAt: nowIso(),
    deadlineAt,
    fencing,
  };

  writeModeSnapshot('TRANSITION', {
    lease: before.lease,
    transition,
    reason: op,
    fencing,
  });
  audit({ op, kind: 'transition_start', target, from: before.state, fencing });

  try {
    if (testDelayMs() > 0) await sleep(testDelayMs());
    if (testAbortFor(op)) {
      process.exit(EXIT.TEST_ABORT);
    }
    const out = await fn({ fencing, from: before.state, actor });
    if (!out || out.ok === false) {
      const err = new Error(out?.error || 'transition failed');
      err.detail = out;
      throw err;
    }
    const finalState = out.finalState || target;
    const finalLease = out.lease !== undefined ? out.lease : readValidLease().lease;
    writeModeSnapshot(finalState, {
      lease: finalLease,
      reason: out.reason || op,
      fencing: out.fencing ?? fencing,
      extra: out.detail ?? null,
    });
    audit({
      op,
      kind: 'transition_ok',
      target: finalState,
      from: before.state,
      fencing,
      detail: out.detail ?? null,
    });
    return {
      ok: true,
      op,
      from: before.state,
      to: finalState,
      fencing,
      lease: finalLease,
      detail: out.detail ?? null,
      reconciled: rec.actions,
    };
  } catch (e) {
    if (failureMode === 'restore') {
      writeModeSnapshot(before.state, {
        lease: before.lease,
        reason: `${op}_refused`,
        fencing: currentFencing(),
        extra: { error: String(e?.message ?? e) },
      });
      audit({ op, kind: 'transition_refused', target, from: before.state, error: String(e?.message ?? e) });
      return {
        ok: false,
        code: e?.detail?.code || 'transition_refused',
        error: String(e?.message ?? e),
        detail: e?.detail ?? null,
        from: before.state,
        to: before.state,
      };
    }
    try { release({ force: true }); } catch { /* ignore */ }
    writeModeSnapshot('OFF', {
      lease: null,
      reason: `${op}_failed`,
      fencing: currentFencing(),
      extra: { error: String(e?.message ?? e) },
    });
    audit({
      op,
      kind: 'transition_failed',
      target,
      from: before.state,
      to: 'OFF',
      error: String(e?.message ?? e),
    });
    return {
      ok: false,
      code: 'transition_failed',
      error: String(e?.message ?? e),
      detail: e?.detail ?? null,
      from: before.state,
      to: 'OFF',
    };
  } finally {
    removeTransition(got.rec.token);
  }
}



function buildProtect({ runId, reason, ttlMs }) {
  return {
    enabled: true,
    runId: runId ?? null,
    reason: reason ?? 'protected',
    until: new Date(Date.now() + ttlMs).toISOString(),
    heartbeatAt: nowIso(),
  };
}

async function activeLeaseBlock() {
  const info = readValidLease();
  if (info.reason !== 'active') return null;
  if (leaseKind(info.lease) === 'tree') {
    return {
      ok: false,
      code: 'tree_active',
      error: `tree holds lease (${info.lease.owner}); use force-dev if Lead approves`,
      lease: info.lease,
    };
  }
  return {
    ok: false,
    code: 'dev_active',
    error: `dev lease already held by ${info.lease.owner}`,
    lease: info.lease,
  };
}

export async function enterDev({
  owner,
  runId = null,
  mode = 'reference-pilot',
  ttlMs = 30_000,
  protect = false,
  protectReason = null,
  protectTtlMs = 600_000,
  actor = owner,
  ports = null,
} = {}) {
  if (!owner) throw new Error('owner required');
  const pre = await activeLeaseBlock();
  if (pre) return pre;
  const p0 = ports || await probePorts();
  if (p0.controlOpen || p0.mcpOpen) {
    return blocked('tree_active', 'tree is running (8766/8767); use force-dev if Lead approves');
  }
  return withTransition({
    op: 'dev',
    target: protect ? 'DEV_PROTECTED' : 'DEV',
    actor,
    timeoutMs: transitionTimeoutMs('dev'),
    failureMode: 'restore',
    fn: async ({ fencing }) => {
      const active = await activeLeaseBlock();
      if (active) return active;
      const p = ports || await probePorts();
      if (p.controlOpen || p.mcpOpen) {
        return blocked('tree_active', 'tree started during dev acquisition');
      }
      const a = acquire({
        owner,
        runId,
        mode,
        ttlMs,
        recoverStale: true,
        kind: 'dev',
        fencing,
        protect: protect
          ? buildProtect({ runId, reason: protectReason || 'dev-protected', ttlMs: protectTtlMs })
          : null,
      });
      if (!a.ok) return blocked('lease_failed', `lease failed: ${a.error}`, { lease: a.lock });
      return {
        ok: true,
        finalState: protect ? 'DEV_PROTECTED' : 'DEV',
        lease: a.lock,
        detail: { owner, runId, fencing, recovered: a.recovered ?? null },
      };
    },
  });
}

export async function exitDev({ owner, fencing = null, actor = owner, finalState = null } = {}) {
  if (!owner) throw new Error('owner required');
  return withTransition({
    op: 'release',
    target: 'OFF',
    actor,
    timeoutMs: transitionTimeoutMs('release'),
    bumpFencing: false,
    failureMode: 'restore',
    fn: async () => {
      const cur = readLock();
      if (!cur) {
        return {
          ok: true,
          finalState: declaredState() === 'TREE' ? 'TREE' : 'OFF',
          lease: null,
          detail: { released: false, reason: 'no lease' },
        };
      }
      if (cur.owner !== owner) {
        return blocked('not_owner', `lease owner is ${cur.owner}`);
      }
      if (fencing != null && Number(cur.fencing) !== Number(fencing)) {
        return blocked('fencing_mismatch', `lease fencing ${cur.fencing} != ${fencing}`);
      }
      const rel = release({ owner, fencing });
      if (!rel.ok) return blocked('release_failed', rel.error);
      const p = await probePorts();
      const autoState = (p.controlOpen || p.mcpOpen) || declaredState() === 'TREE' ? 'TREE' : 'OFF';
      return {
        ok: true,
        finalState: finalState || autoState,
        lease: null,
        detail: { released: rel.released },
      };
    },
  });
}

export async function claimTreeLease({
  owner,
  runId = null,
  ttlMs = 15_000,
  actor = owner,
  ports = null,
} = {}) {
  if (!owner) throw new Error('owner required');
  const pre = await activeLeaseBlock();
  if (pre) return pre;
  const p0 = ports || await probePorts();
  if (p0.controlOpen || p0.mcpOpen) {
    return blocked('tree_already_running', 'tree control/MCP port already listening');
  }
  return withTransition({
    op: 'tree-start',
    target: 'TREE',
    actor,
    timeoutMs: transitionTimeoutMs('tree-start'),
    failureMode: 'restore',
    fn: async ({ fencing }) => {
      const active = await activeLeaseBlock();
      if (active) return active;
      const p = ports || await probePorts();
      if (p.controlOpen || p.mcpOpen) {
        return blocked('tree_already_running', 'tree appeared during startup');
      }
      const a = acquire({
        owner,
        runId,
        mode: 'tree',
        ttlMs,
        recoverStale: true,
        kind: 'tree',
        fencing,
      });
      if (!a.ok) return blocked('lease_failed', `tree lease failed: ${a.error}`, { lease: a.lock });
      return {
        ok: true,
        finalState: 'TREE',
        lease: a.lock,
        detail: { owner, runId, fencing },
      };
    },
  });
}

export function heartbeatLease({
  owner,
  fencing = null,
  ttlMs = 30_000,
  protectTtlMs = null,
} = {}) {
  if (!owner) return { ok: false, error: 'owner required' };
  let result;
  try {
    result = withTransitionSync({
      op: 'heartbeat',
      timeoutMs: transitionTimeoutMs('heartbeat'),
      fn: () => {
        const cur = readLock();
        if (!cur) return { ok: false, code: 'no_lease', error: 'no lease' };
        if (cur.owner !== owner) return { ok: false, code: 'not_owner', error: `not owner: ${cur.owner}` };
        if (fencing != null && Number(cur.fencing) !== Number(fencing)) {
          return { ok: false, code: 'fencing_mismatch', error: `fencing ${cur.fencing} != ${fencing}` };
        }
        cur.heartbeatAt = nowIso();
        cur.expiresAt = new Date(Date.now() + ttlMs).toISOString();
        if (cur.protect?.enabled && protectTtlMs) {
          cur.protect.until = new Date(Date.now() + protectTtlMs).toISOString();
          cur.protect.heartbeatAt = nowIso();
        }
        writeJsonAtomic(lockPath(), cur);
        return { ok: true, lease: cur };
      },
    });
  } catch (e) {
    return { ok: false, code: 'heartbeat_error', error: String(e?.message ?? e) };
  }
  if (!result.ok) return result;
  writeModeSnapshot(stateOfLease(result.lease), { lease: result.lease, reason: 'heartbeat' });
  return result;
}

function withTransitionSync({ op, timeoutMs, fn }) {
  const got = acquireTransition({ op, target: 'KEEP', actor: 'heartbeat', timeoutMs });
  if (!got.ok) {
    return { ok: false, code: 'transition_busy', error: 'transition busy' };
  }
  try {
    return fn();
  } finally {
    removeTransition(got.rec.token);
  }
}

export async function releaseLease(opts = {}) {
  return exitDev(opts);
}



export async function protectOn({
  owner = null,
  fencing = null,
  runId = null,
  reason = 'protected',
  ttlMs = 600_000,
  actor = owner || 'operator',
} = {}) {
  return withTransition({
    op: 'protect-on',
    target: 'DEV_PROTECTED',
    actor,
    timeoutMs: transitionTimeoutMs('protect'),
    bumpFencing: false,
    failureMode: 'restore',
    fn: async () => {
      const cur = readLock();
      if (!cur) return blocked('no_lease', 'no lease to protect');
      if (leaseKind(cur) !== 'dev') return blocked('not_dev', 'only dev lease can be protected');
      if (owner && cur.owner !== owner) return blocked('not_owner', `not owner: ${cur.owner}`);
      if (fencing != null && Number(cur.fencing) !== Number(fencing)) {
        return blocked('fencing_mismatch', `fencing ${cur.fencing} != ${fencing}`);
      }
      cur.protect = buildProtect({ runId: runId ?? cur.runId, reason, ttlMs });
      writeJsonAtomic(lockPath(), cur);
      return { ok: true, finalState: 'DEV_PROTECTED', lease: cur, detail: { protect: cur.protect } };
    },
  });
}

export async function protectOff({
  owner = null,
  fencing = null,
  actor = owner || 'operator',
} = {}) {
  return withTransition({
    op: 'protect-off',
    target: 'DEV',
    actor,
    timeoutMs: transitionTimeoutMs('protect'),
    bumpFencing: false,
    failureMode: 'restore',
    fn: async () => {
      const cur = readLock();
      if (!cur) return blocked('no_lease', 'no lease');
      if (leaseKind(cur) !== 'dev') return blocked('not_dev', 'only dev lease can be unprotected');
      if (owner && cur.owner !== owner) return blocked('not_owner', `not owner: ${cur.owner}`);
      if (fencing != null && Number(cur.fencing) !== Number(fencing)) {
        return blocked('fencing_mismatch', `fencing ${cur.fencing} != ${fencing}`);
      }
      cur.protect = null;
      writeJsonAtomic(lockPath(), cur);
      return { ok: true, finalState: 'DEV', lease: cur };
    },
  });
}



export function externalOps() {
  if (process.env.PILOT_MODE_EXTERNAL === 'noop') {
    return {
      handoff: async () => ({ ok: true, noop: true, via: 'noop' }),
      clearLocks: async () => ({ via: 'noop', status: 0, stdout: 'noop', stderr: '' }),
    };
  }
  return { handoff, clearLocks };
}

/** Lead force: graceful handoff, clear locks, invalidate old fence, declare TREE. */
export async function forceTree({
  actor = 'lead',
  reason = 'force-tree',
  runId = `force-tree-${Date.now()}`,
  handoffTimeoutMs = 240_000,
  external = externalOps(),
  transitionMs = null,
} = {}) {
  return withTransition({
    op: 'force-tree',
    target: 'TREE',
    actor,
    timeoutMs: transitionTimeoutMs('force', transitionMs),
    failureMode: 'off',
    fn: async () => {
      const h = await external.handoff({ timeoutMs: handoffTimeoutMs });
      if (!h?.ok) return blocked('handoff_failed', `handoff failed: ${h?.error ?? 'unknown'}`, { handoff: h });
      const c = await external.clearLocks({});
      const rel = release({ force: true });
      return {
        ok: true,
        finalState: 'TREE',
        lease: null,
        reason,
        detail: { runId, handoff: h, clearLocks: c, release: rel },
      };
    },
  });
}

/** Lead force: handoff tree, take a fresh dev lease with a new fence. */
export async function forceDev({
  owner = newOwner('dev'),
  runId = null,
  mode = 'reference-pilot',
  ttlMs = 30_000,
  protect = false,
  protectReason = reasonForProtect(),
  protectTtlMs = 600_000,
  actor = 'lead',
  reason = 'force-dev',
  handoffTimeoutMs = 240_000,
  external = externalOps(),
  transitionMs = null,
} = {}) {
  let lease = null;
  const r = await withTransition({
    op: 'force-dev',
    target: 'DEV',
    actor,
    timeoutMs: transitionTimeoutMs('force', transitionMs),
    failureMode: 'off',
    fn: async ({ fencing }) => {
      const h = await external.handoff({ timeoutMs: handoffTimeoutMs });
      if (!h?.ok) return blocked('handoff_failed', `handoff failed: ${h?.error ?? 'unknown'}`, { handoff: h });
      const c = await external.clearLocks({});
      const rel = release({ force: true });
      const a = acquire({
        owner,
        runId,
        mode,
        ttlMs,
        recoverStale: true,
        kind: 'dev',
        fencing,
        protect: protect
          ? buildProtect({ runId, reason: protectReason, ttlMs: protectTtlMs })
          : null,
      });
      if (!a.ok) return blocked('lease_failed', `lease failed: ${a.error}`, { lease: a.lock });
      lease = a.lock;
      return {
        ok: true,
        finalState: protect ? 'DEV_PROTECTED' : 'DEV',
        lease: a.lock,
        reason,
        detail: { handoff: h, clearLocks: c, release: rel, owner, runId, fencing },
      };
    },
  });
  if (r.ok && lease) r.lease = lease;
  return r;
}

function reasonForProtect() {
  return 'force-dev-protected';
}

export async function off({
  force = false,
  owner = null,
  actor = 'lead',
  reason = 'off',
} = {}) {
  const info = readValidLease();
  if (info.reason === 'active' && !force && (!owner || info.lease.owner !== owner)) {
    audit({ op: 'off', kind: 'refused', code: 'lease_active', detail: info.lease });
    return blocked('lease_active', `lease held by ${info.lease.owner}; use --force`, { lease: info.lease });
  }
  return withTransition({
    op: 'off',
    target: 'OFF',
    actor,
    timeoutMs: transitionTimeoutMs('off'),
    failureMode: 'off',
    fn: async () => {
      const rel = release({ force: true });
      return {
        ok: true,
        finalState: 'OFF',
        lease: null,
        reason,
        detail: { release: rel, forced: !!force || owner == null },
      };
    },
  });
}

export async function recover({ actor = 'operator' } = {}) {
  const rec = reconcile({ repair: true });
  const status = await getStatus({ repair: true });
  audit({ op: 'recover', kind: 'manual', actor, actions: rec.actions, state: status.state });
  return { ok: true, ...status, reconciled: rec.actions };
}

/**
 * Optional graceful stop channel: if PILOT_HOLDER_STOP_FILE exists, the holder
 * releases its lease and exits. Used by tools/devtool.mjs instead of taskkill.
 */
function holderStopRequested() {
  const file = process.env.PILOT_HOLDER_STOP_FILE;
  if (!file) return false;
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Foreground holder: heartbeat until signal/lease loss/stop file, then release if still owner. */
export async function holdLease({
  owner,
  fencing,
  ttlMs = 30_000,
  protectTtlMs = null,
  onLost = null,
} = {}) {
  let stopped = false;
  let lost = null;
  const finish = (why) => {
    if (stopped) return;
    stopped = true;
    if (why !== 'signal' && why !== 'stop_file') lost = why;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    resolveDone();
  };
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });
  const onSignal = () => finish('signal');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const timer = setInterval(() => {
    if (stopped) return;
    if (holderStopRequested()) {
      finish('stop_file');
      return;
    }
    const h = heartbeatLease({ owner, fencing, ttlMs, protectTtlMs });
    if (!h.ok) {
      if (onLost) onLost(h);
      finish(`${h.code || 'lost'}:${h.error ?? ''}`);
    }
  }, 2_000);

  if (holderStopRequested()) finish('stop_file');
  const first = stopped ? { ok: true, skipped: true } : heartbeatLease({ owner, fencing, ttlMs, protectTtlMs });
  if (!first.ok) {
    if (onLost) onLost(first);
    finish(`${first.code || 'lost'}:${first.error ?? ''}`);
  }

  await done;
  clearInterval(timer);
  const held = readLock();
  const mine = held && held.owner === owner && (fencing == null || Number(held.fencing) === Number(fencing));
  let releaseResult = null;
  if (mine) {
    releaseResult = await exitDev({ owner, fencing, actor: owner });
    audit({ op: 'hold', kind: 'released', owner, fencing, detail: releaseResult });
  } else {
    audit({ op: 'hold', kind: 'lease_lost', owner, fencing, reason: lost || 'signal' });
  }
  return { ok: !lost, reason: lost || 'signal', release: releaseResult };
}



function argsOf(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    if (eq < 0) out[raw] = true;
    else out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function bool(v) {
  return v === true || v === '1' || v === 'true' || v === 'yes';
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function print(v) {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

function usage() {
  process.stderr.write(`usage:
  node tools/pilot/mode.mjs status
  node tools/pilot/mode.mjs dev [--hold|--once] [--owner=] [--run-id=] [--mode=] [--ttl-ms=] [--protect] [--reason=] [--protect-ttl-ms=]
  node tools/pilot/mode.mjs tree [--actor=]
  node tools/pilot/mode.mjs off [--force] [--owner=]
  node tools/pilot/mode.mjs protect on|off|status [--owner=] [--fencing=] [--run-id=] [--reason=] [--ttl-ms=]
  node tools/pilot/mode.mjs heartbeat [--owner=] [--fencing=] [--ttl-ms=]
  node tools/pilot/mode.mjs force-tree --yes [--run-id=] [--reason=] [--actor=] [--handoff-timeout-ms=]
  node tools/pilot/mode.mjs force-dev --yes [--hold|--once] [--owner=] [--run-id=] [--protect] [--reason=]
  node tools/pilot/mode.mjs recover
`);
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const a = argsOf(sub && sub.startsWith('--') ? [sub, ...rest] : rest);

  process.env.PILOT_MODE_VERSION = VERSION;

  if (!cmd || cmd === 'help' || a.help) { usage(); return EXIT.USAGE; }

  if (cmd === 'status') {
    print(await getStatus({ repair: true }));
    return EXIT.OK;
  }

  if (cmd === 'recover') {
    print(await recover({ actor: a.actor || 'operator' }));
    return EXIT.OK;
  }

  if (cmd === 'dev') {
    const once = bool(a.once);
    const hold = !once;
    const owner = String(a.owner || newOwner('dev'));
    const runId = a['run-id'] ? String(a['run-id']) : a.runId ? String(a.runId) : `dev-${Date.now()}`;
    const ttlMs = num(a['ttl-ms'], 30_000);
    const protectTtlMs = num(a['protect-ttl-ms'], 600_000);
    const r = await enterDev({
      owner,
      runId,
      mode: a.mode ? String(a.mode) : 'reference-pilot',
      ttlMs,
      protect: bool(a.protect),
      protectReason: a.reason ? String(a.reason) : null,
      protectTtlMs,
    });
    if (!r.ok) { print(r); return r.code === 'tree_active' || r.code === 'dev_active' ? EXIT.BLOCKED : EXIT.FAIL; }
    print({ ...r, ready: true, owner, hold });
    if (!hold) {
      audit({ op: 'dev', kind: 'once', owner, fencing: r.fencing });
      process.stderr.write('[mode] --once: lease becomes stale after exit; use default hold or pilot run for real sessions');
      return EXIT.OK;
    }
    const h = await holdLease({ owner, fencing: r.fencing, ttlMs, protectTtlMs: r.to === 'DEV_PROTECTED' ? protectTtlMs : null });
    print({ ...h, owner });
    return h.ok ? EXIT.OK : EXIT.BLOCKED;
  }

  if (cmd === 'tree') {
    const state = await effectiveState();

    if (state === 'DEV' || state === 'DEV_PROTECTED') {
      const blockedRes = blocked('dev_active', 'dev holds lease; use force-tree');
      audit({ op: 'tree', kind: 'refused', code: blockedRes.code });
      print(blockedRes);
      return EXIT.BLOCKED;
    }
    const snap = writeModeSnapshot('TREE', { lease: readValidLease().lease, reason: 'declared' });
    audit({ op: 'tree', kind: 'declared', state: 'TREE' });
    print({ ok: true, state: 'TREE', snapshot: snap });
    return EXIT.OK;
  }

  if (cmd === 'off') {
    const r = await off({ force: bool(a.force), owner: a.owner ? String(a.owner) : null, actor: a.actor || 'lead' });
    print(r);
    return r.ok ? EXIT.OK : r.code === 'lease_active' ? EXIT.BLOCKED : EXIT.FAIL;
  }

  if (cmd === 'protect') {
    if (sub === 'status') {
      const s = await getStatus({ repair: true });
      print({ state: s.state, lease: s.lease, protect: s.lease?.protect ?? null });
      return EXIT.OK;
    }
    if (sub === 'on') {
      const r = await protectOn({
        owner: a.owner ? String(a.owner) : null,
        fencing: a.fencing != null ? num(a.fencing, null) : null,
        runId: a['run-id'] ? String(a['run-id']) : null,
        reason: a.reason ? String(a.reason) : 'protected',
        ttlMs: num(a['ttl-ms'], 600_000),
      });
      print(r);
      return r.ok ? EXIT.OK : EXIT.BLOCKED;
    }
    if (sub === 'off') {
      const r = await protectOff({
        owner: a.owner ? String(a.owner) : null,
        fencing: a.fencing != null ? num(a.fencing, null) : null,
      });
      print(r);
      return r.ok ? EXIT.OK : EXIT.BLOCKED;
    }
    usage();
    return EXIT.USAGE;
  }

  if (cmd === 'heartbeat') {
    const r = heartbeatLease({
      owner: a.owner ? String(a.owner) : null,
      fencing: a.fencing != null ? num(a.fencing, null) : null,
      ttlMs: num(a['ttl-ms'], 30_000),
    });
    print(r);
    return r.ok ? EXIT.OK : EXIT.BLOCKED;
  }

  if (cmd === 'force-tree') {
    if (!bool(a.yes)) {
      const r = { ok: false, code: 'confirmation_required', error: 'force-tree requires --yes (second confirmation)' };
      audit({ op: 'force-tree', kind: 'refused', code: r.code });
      print(r);
      return EXIT.USAGE;
    }
    const r = await forceTree({
      actor: a.actor ? String(a.actor) : 'lead',
      reason: a.reason ? String(a.reason) : 'force-tree',
      runId: a['run-id'] ? String(a['run-id']) : `force-tree-${Date.now()}`,
      handoffTimeoutMs: num(a['handoff-timeout-ms'], 240_000),
    });
    print(r);
    if (r.ok) return EXIT.OK;
    return r.code === 'transition_busy' ? EXIT.BUSY : EXIT.FAIL;
  }

  if (cmd === 'force-dev') {
    if (!bool(a.yes)) {
      const r = { ok: false, code: 'confirmation_required', error: 'force-dev requires --yes (second confirmation)' };
      audit({ op: 'force-dev', kind: 'refused', code: r.code });
      print(r);
      return EXIT.USAGE;
    }
    const once = bool(a.once);
    const hold = !once;
    const owner = String(a.owner || newOwner('force-dev'));
    const runId = a['run-id'] ? String(a['run-id']) : `force-dev-${Date.now()}`;
    const ttlMs = num(a['ttl-ms'], 30_000);
    const protectTtlMs = num(a['protect-ttl-ms'], 600_000);
    const r = await forceDev({
      owner,
      runId,
      mode: a.mode ? String(a.mode) : 'reference-pilot',
      ttlMs,
      protect: bool(a.protect),
      protectReason: a.reason ? String(a.reason) : 'force-dev-protected',
      protectTtlMs,
      actor: a.actor ? String(a.actor) : 'lead',
      reason: a.reason ? String(a.reason) : 'force-dev',
      handoffTimeoutMs: num(a['handoff-timeout-ms'], 240_000),
    });
    if (!r.ok) { print(r); return r.code === 'transition_busy' ? EXIT.BUSY : EXIT.FAIL; }
    print({ ...r, ready: true, owner, hold });
    if (!hold) {
      audit({ op: 'force-dev', kind: 'once', owner, fencing: r.fencing });
      process.stderr.write('[mode] --once: lease becomes stale after exit; use default hold or pilot run for real sessions');
      return EXIT.OK;
    }
    const h = await holdLease({ owner, fencing: r.fencing, ttlMs, protectTtlMs: r.to === 'DEV_PROTECTED' ? protectTtlMs : null });
    print({ ...h, owner });
    return h.ok ? EXIT.OK : EXIT.BLOCKED;
  }

  usage();
  return EXIT.USAGE;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      console.error(e);
      process.exitCode = EXIT.FAIL;
    });
}

export async function runCli() {
  return main();
}

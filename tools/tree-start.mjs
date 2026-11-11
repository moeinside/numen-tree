#!/usr/bin/env node
/**
 * tree-start.mjs — 树启动 guard 包装器（MVP，无 GM）
 *
 * 顺序：
 *   reconcile（stale lease / 超时 TRANSITION → OFF）
 *   → 校验 lease + 8766/8767 端口
 *   → claim tree lease（fencing）
 *   → spawn src/daemon.mjs
 *   → 运行期 heartbeat
 *   → 子进程退出后释放 tree lease
 *
 * 已知绕过：直接 `node src/daemon.mjs` 不经过本文件。
 * 要彻底封堵需 Lead 授权在 src/daemon.mjs 加最小 hook；维护子体不改 src。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  audit,
  claimTreeLease,
  guardCheck,
  heartbeatLease,
  newOwner,
  releaseLease,
  getStatus,
} from './pilot/mode.mjs';
import { EXIT } from './pilot/mode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function argsOf(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    if (eq < 0) out[raw] = true;
    else out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function print(v) {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

function log(msg) {
  process.stderr.write(`[tree-start] ${msg}\n`);
}

async function main() {
  const a = argsOf(process.argv.slice(2));
  const dryRun = !!a['dry-run'];
  const failClosed = !!a['fail-closed'] || process.env.PILOT_GUARD_FAIL_CLOSED === '1';
  const repair = !a['no-recover'];

  const guard = await guardCheck({ failClosed, repair });
  for (const w of guard.warnings || []) log(`warning: ${w}`);

  if (!guard.ok) {
    print({ ok: false, stage: 'guard', ...guard });
    log(`refused: ${guard.code} (${guard.error})`);
    return EXIT.BLOCKED;
  }
  if (dryRun) {
    print({
      ok: true,
      stage: 'guard',
      dryRun: true,
      state: guard.state,
      lease: guard.lease,
      ports: guard.ports,
      warnings: guard.warnings,
      wouldStart: process.env.PILOT_TREE_TEST_CMD
        ? path.resolve(process.env.PILOT_TREE_TEST_CMD)
        : path.join(ROOT, 'src', 'daemon.mjs'),
    });
    return EXIT.OK;
  }

  const owner = a.owner ? String(a.owner) : newOwner('tree');
  const runId = a['run-id'] ? String(a['run-id']) : `tree-${Date.now()}`;
  const ttlMs = Number(a['ttl-ms'] || 15_000);
  const claim = await claimTreeLease({ owner, runId, ttlMs, actor: owner });
  if (!claim.ok) {
    print({ ok: false, stage: 'claim', ...claim });
    log(`claim failed: ${claim.code} (${claim.error})`);
    return claim.code === 'transition_busy' ? EXIT.BUSY : EXIT.BLOCKED;
  }

  log(`lease claimed owner=${owner} fencing=${claim.fencing}; starting src/daemon.mjs`);
  // 仅自测用：替换被启动的子进程，避免测试启动真实树。生产不要设置。
  const testCmd = process.env.PILOT_TREE_TEST_CMD;
  const childArgs = testCmd ? [path.resolve(testCmd)] : [path.join(ROOT, 'src', 'daemon.mjs')];
  const child = spawn(process.execPath, childArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });

  let lost = null;
  const timer = setInterval(() => {
    const h = heartbeatLease({ owner, fencing: claim.fencing, ttlMs });
    if (!h.ok) {
      lost = h;
      clearInterval(timer);
      audit({
        op: 'tree-start',
        kind: 'lease_lost',
        owner,
        fencing: claim.fencing,
        detail: h,
      });
      log(`lease lost (${h.code}: ${h.error}); tree process left to graceful handoff`);
    }
  }, 5_000);
  timer.unref?.();

  let signal = null;
  const onSignal = (sig) => {
    signal = sig;
    log(`got ${sig}; forwarding to tree (graceful, no taskkill)`);
    try { child.kill(sig); } catch { /* ignore */ }
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const exit = await new Promise((resolve) => {
    child.once('error', (e) => resolve({ error: e, code: null }));
    child.once('exit', (code, sig) => resolve({ code, signal: sig }));
  });

  clearInterval(timer);
  // 只有仍持有自己 lease 时才强制收口为 OFF；若已被 force 接管则 preserve 目标态。
  const rel = await releaseLease({ owner, fencing: claim.fencing, actor: owner, finalState: 'OFF' });
  const status = await getStatus({ repair: true });
  audit({
    op: 'tree-start',
    kind: 'tree_exited',
    owner,
    fencing: claim.fencing,
    detail: { exit, signal, release: rel, state: status.state },
  });

  print({
    ok: exit.error == null && (exit.code === 0 || exit.signal != null),
    stage: 'running',
    owner,
    fencing: claim.fencing,
    pid: child.pid,
    exit,
    release: rel,
    state: status.state,
    warnings: guard.warnings,
  });
  return exit.error ? EXIT.FAIL : EXIT.OK;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(e);
    process.exitCode = EXIT.FAIL;
  });

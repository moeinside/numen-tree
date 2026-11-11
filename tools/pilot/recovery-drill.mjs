/**
 * 最坏恢复演练（架构顾问开工阻塞条件）
 *
 * 1. 子进程拿锁 → SIGKILL（模拟 pilot 崩溃持锁）
 * 2. 锁仍在且 stale
 * 3. 另一进程 recoverStale 接管
 * 4. 非 owner 不能释放
 * 5. 控制面白名单拒绝未知 op
 *
 * 不连接游戏、不动真实锁（临时 PILOT_LOCK_DIR）。
 * 输出证据：logs/pilot-recovery-drill.json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, status, release, lockDir } from './lock.mjs';
import { whitelisted } from './tree-control.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'logs', 'pilot-recovery-drill.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-drill-'));
  process.env.PILOT_LOCK_DIR = dir;
  const checks = [];
  const add = (name, ok, detail = null) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  };

  const holder = spawn(process.execPath, [path.join(HERE, 'lock-holder.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PILOT_LOCK_DIR: dir,
      PILOT_DRILL_OWNER: 'drill-crash-owner',
      PILOT_DRILL_RUN: 'drill-crash',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  holder.stdout.on('data', (b) => { out += b.toString(); });
  holder.stderr.on('data', () => {});

  const deadline = Date.now() + 10_000;
  while (!out.includes('"ready":true') && Date.now() < deadline) {
    await sleep(100);
  }
  add('holder acquired lock', out.includes('"ready":true'), { pid: holder.pid });

  const staleBeforeKill = status();
  add('lock exists before crash', !!staleBeforeKill.lock, staleBeforeKill);

  const exited = new Promise((res) => holder.once('exit', res));
  holder.kill('SIGKILL');
  if (holder.exitCode == null && holder.signalCode == null) {
    await exited;
  }
  await sleep(500);

  const afterKill = status();
  add('lock remains after SIGKILL', !!afterKill.lock, afterKill);
  add('lock is stale after crash', afterKill.stale === true, {
    pidAlive: afterKill.pidAlive,
    expiresAt: afterKill.lock?.expiresAt,
  });

  const blocked = acquire({ owner: 'should-fail', ttlMs: 5000 });
  add('normal acquire blocked while stale', blocked.ok === false, blocked.error);

  const takeover = acquire({
    owner: 'recovered-owner',
    runId: 'drill-recovered',
    mode: 'reference-pilot',
    ttlMs: 5000,
    recoverStale: true,
  });
  add('recoverStale takeover ok', takeover.ok === true, takeover);

  const wrongRelease = release({ owner: 'not-owner' });
  add('non-owner release rejected', wrongRelease.ok === false, wrongRelease.error);

  const rightRelease = release({ owner: 'recovered-owner' });
  add('owner release ok', rightRelease.ok === true, rightRelease);

  const unknown = await whitelisted('runArbitraryCommand', {});
  add('control-plane whitelist rejects unknown', unknown.ok === false, unknown.error);

  const result = {
    at: new Date().toISOString(),
    lockDir: lockDir(),
    checks,
    passed: checks.every((c) => c.ok),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`evidence: ${OUT}`);
  process.exit(result.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

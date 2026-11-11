#!/usr/bin/env node
/**
 * pilot CLI（MVP）
 *
 *   node tools/pilot/pilot.mjs preflight
 *   node tools/pilot/pilot.mjs lock status
 *   node tools/pilot/pilot.mjs lock acquire --owner=... [--mode=reference-pilot]
 *   node tools/pilot/pilot.mjs lock release --owner=... [--force]
 *   node tools/pilot/pilot.mjs handoff
 *   node tools/pilot/pilot.mjs unlock [--restore-tree]
 *   node tools/pilot/pilot.mjs drill recovery
 */
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquire, release, status, newOwner } from './lock.mjs';
import { treeStatus, handoff, clearLocks, lockPatchStatus, whitelisted } from './tree-control.mjs';
import { numenTools } from './mcp-readonly.mjs';
import { runPilot } from './run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function argsOf(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? true;
  }
  return out;
}

function print(v) {
  console.log(JSON.stringify(v, null, 2));
}

async function preflight() {
  const report = { at: new Date().toISOString(), checks: {} };
  report.checks.tree = await treeStatus();
  report.checks.patch = await lockPatchStatus();
  try {
    report.checks.numen = await numenTools({ timeoutMs: 5000 });
  } catch (e) {
    report.checks.numen = { error: String(e?.message ?? e) };
  }
  report.checks.lock = status();
  report.ok =
    report.checks.numen?.tools?.length > 0 &&
    !report.checks.lock.lock;
  print(report);
  return report.ok ? 0 : 1;
}

async function unlock({ restoreTree = false } = {}) {
  const s = status();
  const owner = s.lock?.owner;
  const steps = [];
  // 1) 清僵尸锁（不杀树）
  steps.push({ step: 'clearLocks', result: clearLocks({ resetBrain: false }) });
  // 2) 释放 lease（无 owner 时 noop）
  steps.push({ step: 'release', result: release({ owner, force: true }) });
  // 3) 可选重启树
  if (restoreTree) {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'tree-start.mjs')], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    p.unref();
    steps.push({ step: 'restoreTree', via: 'tree-start', pid: p.pid });
  }
  const after = status();
  const tree = await treeStatus();
  const out = { ok: !after.lock, steps, lock: after, tree };
  print(out);
  return out.ok ? 0 : 1;
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  // `pilot run --provider=...` 的第一个 flag 会落在 sub，需并回参数。
  const args = argsOf(sub && sub.startsWith('--') ? [sub, ...rest] : rest);

  if (cmd === 'preflight') return preflight();

  if (cmd === 'run') {
    const r = await runPilot({
      minutes: Number(args.minutes ?? 20),
      steps: Number(args.steps ?? 200),
      maxTokens: Number(args['max-tokens'] ?? 200_000),
      provider: String(args.provider ?? 'mock'),
      companion: args.companion ? String(args.companion) : null,
      dryRun: !!args['dry-run'],
      approve: args.yes ? 'auto' : String(args.approve ?? 'each'),
      noLock: !!args['no-lock'],
      noHandoff: !!args['no-handoff'],
      protect: !!args.protect,
      protectReason: args['protect-reason'] ? String(args['protect-reason']) : null,
      fixture: args.fixture ? String(args.fixture) : null,
      allowCreative: !!args['allow-creative'],
      restoreTree: !!args['restore-tree'],
      targetFile: args['target-file'] ? String(args['target-file']) : null,
      targetLua: args['target-lua'] ? String(args['target-lua']) : null,
      outDir: args.out ? path.resolve(String(args.out)) : null,
    });
    return r.exitCode;
  }

  if (cmd === 'lock') {
    if (sub === 'status') {
      print(status());
      return 0;
    }
    if (sub === 'acquire') {
      const owner = String(args.owner || newOwner());
      const r = acquire({
        owner,
        runId: args.runId || null,
        mode: args.mode || 'reference-pilot',
        recoverStale: !!args['recover-stale'],
      });
      print({ ...r, owner });
      return r.ok ? 0 : 1;
    }
    if (sub === 'release') {
      const r = release({
        owner: args.owner,
        force: !!args.force,
      });
      print(r);
      return r.ok ? 0 : 1;
    }
    print({ error: 'usage: lock status|acquire|release' });
    return 2;
  }

  if (cmd === 'handoff') {
    const r = await whitelisted('handoff');
    print(r);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'unlock') {
    return unlock({ restoreTree: !!args['restore-tree'] });
  }

  if (cmd === 'drill' && sub === 'recovery') {
    const r = spawnSync(process.execPath, [path.join(HERE, 'recovery-drill.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    return r.status ?? 1;
  }

  console.error('usage: pilot.mjs preflight | lock ... | handoff | unlock | drill recovery');
  return 2;
}

main()
  .then((code) => {
    // 不强制 process.exit：undici/fetch 的 keep-alive 句柄在退出瞬间可能触发
    // libuv UV_HANDLE_CLOSING 断言；让事件循环自然收尾。
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });

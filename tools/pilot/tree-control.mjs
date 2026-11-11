/**
 * 控制面白名单（MVP）
 *
 * 只允许 pilot 对树执行 3 类硬编码操作：
 *   - status（只读）
 *   - handoff（control --op exit）
 *   - clearLocks（lock --all / --reset-brain）
 *
 * 不接受任意命令；LLM 永远拿不到这个模块的调用能力。
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TREE_PORT = 8767;

export function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

export async function treeStatus() {
  const open = await isPortOpen(TREE_PORT);
  return { port: TREE_PORT, listening: open };
}

function runCli(args, timeoutMs = 240_000) {
  const r = spawnSync(process.execPath, ['src/cli.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    args,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    signal: r.signal || null,
  };
}

export function controlStatus() {
  return runCli(['status'], 30_000);
}

/**
 * 让树优雅退出；不 taskkill。
 * 若 8767 未监听，视为 noop。
 */
export async function handoff({ timeoutMs = 240_000 } = {}) {
  const before = await treeStatus();
  if (!before.listening) return { ok: true, noop: true, before };
  const r = runCli(['control', '--op', 'exit'], timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(TREE_PORT))) {
      return { ok: true, before, exit: r, after: { listening: false } };
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return {
    ok: false,
    error: 'tree still listening after control exit',
    before,
    exit: r,
    after: await treeStatus(),
  };
}

/** 清僵尸锁；树不在时走补丁 8768 直连。 */
export async function clearLocks({ resetBrain = false } = {}) {
  if (resetBrain) {
    const r = runCli(['lock', '--all', '--reset-brain'], 60_000);
    if (r.status === 0) return r;
  }
  const tree = await treeStatus();
  if (tree.listening) {
    const r = runCli(['lock', '--all'], 60_000);
    if (r.status === 0) return r;
  }
  // 树已退：直接走 numenlockfix 8768
  try {
    const res = await fetch('http://127.0.0.1:8768/unlock?all=1', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    return { via: 'patch8768', status: res.status, stdout: text, stderr: '' };
  } catch (e) {
    return { via: 'patch8768', status: -1, stdout: '', stderr: String(e?.message ?? e) };
  }
}

export async function patchStatus() {
  try {
    const res = await fetch('http://127.0.0.1:8768/status', {
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function lockPatchStatus() {
  const tree = await treeStatus();
  if (tree.listening) return runCli(['lock'], 30_000);
  return patchStatus();
}

/** 白名单分发：只接受这三个 op。 */
export async function whitelisted(op, opts = {}) {
  switch (op) {
    case 'status':
      return {
        ok: true,
        tree: await treeStatus(),
        patch: await lockPatchStatus(),
      };
    case 'handoff':
      return handoff(opts);
    case 'clearLocks':
      return { ok: true, result: await clearLocks(opts) };
    default:
      return { ok: false, error: `op not allowed: ${op}` };
  }
}

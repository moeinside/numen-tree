/**
 * Pilot 独占锁（MVP）
 *
 * - 全局 lease 文件 + O_EXCL 原子创建
 * - owner/pid/runId/expiresAt/heartbeat
 * - heartbeat 续租
 * - stale 检测：PID 死或 lease 过期
 * - 恢复：归档旧锁后重新抢占
 *
 * 不依赖游戏/树；纯文件锁，便于恢复演练。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 固定到仓库根下的 runs/，避免从别的 cwd 启动时把锁写到别处。
// 测试/演练用 PILOT_LOCK_DIR 覆盖到临时目录。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIR = path.join(ROOT, 'runs');
const LOCK_NAME = '.pilot-lock.json';

export function lockDir() {
  return path.resolve(process.env.PILOT_LOCK_DIR || DEFAULT_DIR);
}

export function lockPath() {
  return path.join(lockDir(), LOCK_NAME);
}

function ensureDir() {
  fs.mkdirSync(lockDir(), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

export function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function isStale(lock, now = Date.now()) {
  if (!lock) return true;
  if (!isPidAlive(lock.pid)) return true;
  if (lock.expiresAt && Date.parse(lock.expiresAt) < now) return true;
  return false;
}

function archiveStale(reason) {
  const p = lockPath();
  if (!fs.existsSync(p)) return null;
  const out = path.join(
    lockDir(),
    `.pilot-lock.stale.${Date.now()}.json`,
  );
  try {
    fs.renameSync(p, out);
    return { out, reason };
  } catch {
    try {
      fs.unlinkSync(p);
      return { out: null, reason };
    } catch {
      return null;
    }
  }
}

export { archiveStale };

/**
 * 尝试拿锁。
 * @returns {{ok:boolean, owner:string, lock?:object, error?:string, recovered?:object}}
 */
export function acquire({
  owner,
  runId = null,
  mode = 'reference-pilot',
  ttlMs = 30_000,
  recoverStale = false,
  kind = null,
  fencing = null,
  protect = null,
} = {}) {
  if (!owner) throw new Error('owner required');
  ensureDir();
  const lock = {
    owner,
    pid: process.pid,
    runId,
    mode,
    kind,
    fencing,
    protect,
    acquiredAt: nowIso(),
    heartbeatAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    version: 1,
  };
  let recovered = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath(), 'wx');
      fs.writeSync(fd, JSON.stringify(lock, null, 2));
      fs.closeSync(fd);
      return { ok: true, owner, lock, recovered };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const cur = readLock();
      const stale = isStale(cur);
      if (!recoverStale || !stale) {
        return {
          ok: false,
          owner,
          lock: cur,
          error: stale
            ? 'stale lock exists; use recoverStale'
            : `lock held by ${cur?.owner ?? 'unknown'}`,
        };
      }
      recovered = archiveStale('stale');
      if (!recovered) {
        return { ok: false, owner, lock: cur, error: 'archive stale failed' };
      }
    }
  }
  return { ok: false, owner, error: 'acquire race' };
}

export function heartbeat({ owner, ttlMs = 30_000 } = {}) {
  ensureDir();
  const cur = readLock();
  if (!cur) return { ok: false, error: 'no lock' };
  if (owner && cur.owner !== owner) {
    return { ok: false, error: `not owner: ${cur.owner}` };
  }
  cur.heartbeatAt = nowIso();
  cur.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  fs.writeFileSync(lockPath(), JSON.stringify(cur, null, 2));
  return { ok: true, lock: cur };
}

export function release({ owner, force = false, fencing = null } = {}) {
  const cur = readLock();
  if (!cur) return { ok: true, released: false };
  if (!force && owner && cur.owner !== owner) {
    return { ok: false, error: `not owner: ${cur.owner}` };
  }
  if (!force && fencing != null && Number(cur.fencing) !== Number(fencing)) {
    return { ok: false, error: `fencing mismatch: ${cur.fencing} != ${fencing}` };
  }
  try {
    fs.unlinkSync(lockPath());
    return { ok: true, released: true, lock: cur };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export function status() {
  const cur = readLock();
  return {
    lockPath: lockPath(),
    lock: cur,
    stale: cur ? isStale(cur) : null,
    pidAlive: cur ? isPidAlive(cur.pid) : null,
  };
}

export function newOwner(prefix = 'pilot') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

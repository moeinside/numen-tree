/**
 * Phase C：priority 状态持久化（进程重启续跑的前提）。
 * 只存 current/统计快照；恢复判定仍必须经过世界 postcheck。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRIORITY_STORE_VERSION = 1;

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function envelope(store) {
  const payload = { ...store, updatedAt: store.updatedAt || new Date().toISOString() };
  return { schemaVersion: PRIORITY_STORE_VERSION, hash: hashPayload(payload), payload };
}

export function savePriorityStore(file, store) {
  if (!file) throw new Error('file is required');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(envelope(store), null, 2);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return file;
}

export function loadPriorityStore(file, { worldId, companionId, worldEpoch } = {}) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: 'missing', store: null };
  let env;
  try {
    env = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'parse_failed', error: String(e?.message ?? e), store: null };
  }
  if (!env || env.schemaVersion !== PRIORITY_STORE_VERSION || !env.payload || !env.hash) {
    return { ok: false, reason: 'schema_mismatch', store: null };
  }
  if (hashPayload(env.payload) !== env.hash) return { ok: false, reason: 'hash_mismatch', store: null };
  const store = env.payload;
  if (worldId != null && String(store.worldId) !== String(worldId)) return { ok: false, reason: 'world_mismatch', store: null };
  if (companionId != null && String(store.companionId) !== String(companionId)) return { ok: false, reason: 'companion_mismatch', store: null };
  const warnings = [];
  if (worldEpoch != null && Number(store.worldEpoch) !== Number(worldEpoch)) {
    return { ok: false, reason: 'world_epoch_mismatch', store: null };
  }
  return { ok: true, reason: null, store, warnings };
}

export function prioritySnapshot({ worldId, companionId, worldEpoch = 0, priority = null, stats = {}, now = new Date().toISOString() }) {
  if (!worldId || !companionId) throw new Error('worldId and companionId are required');
  return {
    schemaVersion: PRIORITY_STORE_VERSION,
    worldId: String(worldId),
    companionId: String(companionId),
    worldEpoch: Number(worldEpoch) || 0,
    priority: priority ? JSON.parse(JSON.stringify(priority)) : null,
    stats: { ...stats },
    updatedAt: now,
  };
}

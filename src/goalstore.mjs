#!/usr/bin/env node
/**
 * P0-b 最小 GoalProfile 持久化。
 *
 * 设计约束（docs/48/50/52）：
 *  - 只存 GoalProfile + milestone + checkpoint，不存 plan cursor；
 *  - 原子写：临时文件 + rename；
 *  - 带 schemaVersion / worldId / companionId / worldEpoch；
 *  - 读档校验 hash；损坏/回档不能静默通过；
 *  - 重启幂等：已完成步骤不靠“执行过”判断，而靠世界谓词重新验收（由调用方实现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GOAL_STORE_VERSION = 1;

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createGoalStore({
  worldId,
  companionId,
  worldEpoch = 0,
  activeProfile = null,
  milestones = [],
  checkpoint = null,
  now = new Date().toISOString(),
}) {
  if (!worldId || !companionId) throw new Error('worldId and companionId are required');
  return {
    schemaVersion: GOAL_STORE_VERSION,
    worldId: String(worldId),
    companionId: String(companionId),
    worldEpoch: Number(worldEpoch) || 0,
    activeProfile,
    milestones: Array.isArray(milestones) ? milestones : [],
    checkpoint: checkpoint
      ? {
          pos: checkpoint.pos ?? null,
          dimension: checkpoint.dimension ?? null,
          gameTime: checkpoint.gameTime ?? null,
          inventorySummary: checkpoint.inventorySummary ?? null,
          // 故意不存 plan cursor / 执行次数
        }
      : null,
    updatedAt: now,
  };
}

function envelope(store) {
  const payload = { ...store, updatedAt: store.updatedAt || new Date().toISOString() };
  return { schemaVersion: GOAL_STORE_VERSION, hash: hashPayload(payload), payload };
}

/** 原子写：同目录临时文件 + rename；不留下半文件。 */
export function saveGoalStore(file, store) {
  if (!file) throw new Error('file is required');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(envelope(store), null, 2);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  return file;
}

export function loadGoalStore(file, { worldId, companionId, worldEpoch } = {}) {
  if (!file || !fs.existsSync(file)) {
    return { ok: false, reason: 'missing', store: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'read_failed', error: String(e?.message ?? e), store: null };
  }
  let env;
  try {
    env = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'parse_failed', error: String(e?.message ?? e), store: null };
  }
  if (!env || env.schemaVersion !== GOAL_STORE_VERSION || !env.payload || !env.hash) {
    return { ok: false, reason: 'schema_mismatch', store: null };
  }
  if (hashPayload(env.payload) !== env.hash) {
    return { ok: false, reason: 'hash_mismatch', store: null };
  }
  const store = env.payload;
  if (worldId != null && String(store.worldId) !== String(worldId)) {
    return { ok: false, reason: 'world_mismatch', store: null };
  }
  if (companionId != null && String(store.companionId) !== String(companionId)) {
    return { ok: false, reason: 'companion_mismatch', store: null };
  }
  const warnings = [];
  let staleCheckpoint = false;
  if (worldEpoch != null && Number(store.worldEpoch) !== Number(worldEpoch)) {
    warnings.push('world_epoch_mismatch');
    staleCheckpoint = true; // 回档/换档：checkpoint 不可信，必须重规划
  }
  return { ok: true, store, warnings, staleCheckpoint };
}

/** 验收用：从 store 里拿 milestone 进度，不读 plan cursor。 */
export function milestoneProgress(store) {
  const list = Array.isArray(store?.milestones) ? store.milestones : [];
  const done = list.filter((m) => m.status === 'done').map((m) => m.id);
  const active = list.find((m) => m.status === 'active') ?? null;
  return { total: list.length, done, active };
}

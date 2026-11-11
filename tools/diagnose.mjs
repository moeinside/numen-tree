#!/usr/bin/env node
/**
 * diagnose-live — read-only live probe.
 *
 * Reads the tree status and takes two groundtruth snapshots around the
 * companion; prints one verdict. It never dispatches tree actions.
 *
 * Usage:
 *   GROUNDTRUTH_TOKEN=... node tools/diagnose.mjs --window-ms 5000
 */
import { diagnose, mergeDiagnosis } from '../src/diagnose.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const windowMs = Number(arg('window-ms', 5000));
const treeBase = (arg('tree-base', 'http://127.0.0.1:8766')).replace(/\/$/, '');
const gtBase = (arg('gt-base', process.env.GROUNDTRUTH_BASE || 'http://127.0.0.1:8771')).replace(/\/$/, '');
const token = arg('token') || process.env.GROUNDTRUTH_TOKEN || '';
const runId = arg('run-id', `diagnose-${Date.now()}`);
if (!token) {
  console.error('缺少 GROUNDTRUTH_TOKEN 或 --token');
  process.exit(2);
}

async function status() {
  try {
    const res = await fetch(`${treeBase}/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body.companions?.[0] ?? null;
  } catch (e) {
    throw new Error(`status: ${e.message}`);
  }
}

async function snapshot(c) {
  const pos = c.pos ?? { x: 0, y: 64, z: 0 };
  const body = {
    runId,
    reason: 'diagnose-live read-only window',
    selfChallenge: ['read-only', 'diagnosis only'],
    label: 'diagnose-live',
    region: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), rx: 2, ry: 2, rz: 2 },
  };
  const res = await fetch(`${gtBase}/dev/v1/snapshot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Run-Id': runId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const parsed = await res.json();
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}: ${JSON.stringify(parsed)}`);
  return parsed.snapshot;
}

function inventoryMap(inv) {
  const out = new Map();
  for (const item of inv || []) {
    if (!item?.item) continue;
    out.set(item.item, (out.get(item.item) ?? 0) + Number(item.count ?? 0));
  }
  return out;
}

function inventoryDelta(before, after) {
  const a = inventoryMap(before);
  const b = inventoryMap(after);
  const changed = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const delta = (b.get(key) ?? 0) - (a.get(key) ?? 0);
    if (delta !== 0) changed.push({ item: key, delta });
  }
  return changed;
}

async function diff(from, to) {
  const res = await fetch(`${gtBase}/dev/v1/snapshot/diff?from=${from}&to=${to}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Run-Id': runId },
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`diff HTTP ${res.status}`);
  return body.changes ?? [];
}

try {
  const before = await status();
  if (!before) throw new Error('no companion');
  const snapA = await snapshot(before);
  await new Promise((r) => setTimeout(r, Math.max(500, windowMs)));
  const after = await status();
  const snapB = await snapshot(after);
  const changes = await diff(snapA.seq, snapB.seq);

  const stepsDelta = Number(after?.plan?.steps_done ?? 0) - Number(before?.plan?.steps_done ?? 0);
  const invDelta = inventoryDelta(before?.inventory, after?.inventory);
  const dx = Number(after?.pos?.x ?? 0) - Number(before?.pos?.x ?? 0);
  const dy = Number(after?.pos?.y ?? 0) - Number(before?.pos?.y ?? 0);
  const dz = Number(after?.pos?.z ?? 0) - Number(before?.pos?.z ?? 0);
  const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const worldDeltaOutOfScope = moved > 2;
  const waitActive = Boolean(after?.wait?.active || after?.waitUntil > 0 || after?.plan?.status === 'suspended' || after?.plan?.suspendedBy);
  const result = diagnose({
    now: Date.now(),    plan: after?.plan
      ? { id: after.plan.id, status: after.plan.status, cursor: after.plan.cursor, startedAt: Date.parse(after.plan.startedAt) || Date.now() }
      : null,
    current: after?.current,
    currentMissing: Boolean(after?.plan?.status === 'active' && !after?.current && !after?.busy && !waitActive),
    actionLock: after?.busy ? { owner: after?.current?.goalId ?? 'unknown', since: after?.lastActionAt } : null,
    wait: waitActive
      ? {
          active: true,
          reason: after?.wait?.reason || after?.waitReason || after?.plan?.suspendedBy || after?.gateReason || 'suspended',
          recoverable: after?.wait?.recoverable ?? Boolean(after?.plan?.suspendedBy || after?.waitUntil > 0),
          until: after?.wait?.until ?? after?.waitUntil ?? null,
          blockedBy: after?.wait?.blockedBy ?? after?.plan?.suspendedBy ?? after?.gateReason ?? null,
        }
      : null,
    worldDeltaScope: 'local±2',
    worldDeltaOutOfScope,
    progress: {
      stepsDelta,
      worldDelta: changes.length,
      blocksChanged: changes,
      inventoryChanged: invDelta.length > 0,
      lastProgressAt: Number(after?.lastActionAt ?? after?.plan?.startedAt ?? Date.now()),
    },
    stallMs: 20_000,
  });
  const internal = after?.diagnosis ?? null;
  const combined = mergeDiagnosis(result, internal);

  console.log(JSON.stringify({
    ok: true,
    runId,
    windowMs,
    companion: before.name,
    snapshot: { from: snapA.seq, to: snapB.seq, hashFrom: snapA.hash, hashTo: snapB.hash },
    status: {
      beforePlan: before.plan?.id ?? null,
      afterPlan: after?.plan?.id ?? null,
      beforeStatus: before.plan?.status ?? null,
      afterStatus: after?.plan?.status ?? null,
      stepsDelta,
      worldChanges: changes.length,
      inventoryChanges: invDelta.length,
      moved: Math.round(moved * 100) / 100,
      worldDeltaScope: 'local±2',
      worldDeltaOutOfScope,
    },
    diagnosis: { live: result, internal, combined },
  }, null, 2));
} catch (e) {
  console.error(`diagnose-live: ${e.message}`);
  process.exit(1);
}

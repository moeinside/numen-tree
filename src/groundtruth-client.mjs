/**
 * Optional groundtruth atom-window snapshots.
 *
 * This is observational only: no decision reads the result, no exception
 * escapes into the action path, and missing token/base disables it silently.
 */
const BASE = (process.env.GROUNDTRUTH_BASE || 'http://127.0.0.1:8771').replace(/\/$/, '');
const TOKEN = process.env.GROUNDTRUTH_TOKEN || '';
const ENABLED = Boolean(TOKEN);
const TIMEOUT_MS = Number(process.env.GROUNDTRUTH_TIMEOUT_MS || 1500);

export function groundtruthEnabled() {
  return ENABLED;
}

export function atomRegion(pos) {
  const p = pos ?? { x: 0, y: 64, z: 0 };
  return {
    x: Math.floor(Number(p.x) || 0),
    y: Math.floor(Number(p.y) || 0),
    z: Math.floor(Number(p.z) || 0),
    rx: 2, ry: 2, rz: 2,
  };
}

/** Fire-and-forget: never throws, never blocks the action loop. */
export function snapshotAtom({ pos, atomId, phase, runId }) {
  if (!ENABLED) return null;
  const body = {
    runId: runId || `tree-atom-${Date.now()}`,
    reason: `atom ${phase}`,
    selfChallenge: ['observational only', 'no decision reads it'],
    label: `atom:${phase}:${atomId}`,
    region: atomRegion(pos),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const promise = fetch(`${BASE}/dev/v1/snapshot`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Run-Id': body.runId,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json();
      return { ok: true, snapshot: json.snapshot };
    })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
    .finally(() => clearTimeout(timer));
  return promise;
}

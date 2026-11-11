#!/usr/bin/env node
/**
 * groundtruth-accept — Track A eligibility gate.
 *
 * Usage:
 *   node tools/groundtruth-accept.mjs --run-id run-a --from-http
 *   node tools/groundtruth-accept.mjs --run-id run-a --manifest path.json
 *   node tools/groundtruth-accept.mjs --run-id run-a --from-http --out evidence.json
 *
 * Exit 0 only when groundtruth_calls=0 and clockFrozen=false.
 */
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const runId = arg('run-id') || arg('runId');
if (!runId) {
  console.error('缺少 --run-id');
  process.exit(2);
}

const base = (arg('base') || process.env.GROUNDTRUTH_BASE || 'http://127.0.0.1:8771').replace(/\/$/, '');
const token = arg('token') || process.env.GROUNDTRUTH_TOKEN || '';
const fromHttp = process.argv.includes('--from-http');
const manifestFile = arg('manifest');
const outFile = arg('out');

async function readManifest() {
  if (manifestFile) {
    const raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    return raw.manifest || raw;
  }
  if (!fromHttp && !manifestFile) {
    throw new Error('需要 --from-http 或 --manifest');
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/dev/v1/manifest?runId=${encodeURIComponent(runId)}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body.manifest || body;
}

function evaluate(manifest) {
  const calls = Number(manifest.calls ?? 0);
  const clockFrozen = manifest.clockFrozen === true;
  const eligible = calls === 0 && !clockFrozen;
  const reasons = [];
  if (calls > 0) reasons.push(`groundtruth_calls=${calls}`);
  if (clockFrozen) reasons.push('clock_frozen=true');
  return {
    runId,
    eligible,
    verdict: eligible ? 'track_a_eligible' : 'track_a_ineligible',
    calls,
    clockFrozen,
    byKind: manifest.byKind ?? {},
    reasons,
    checkedAt: new Date().toISOString(),
  };
}

try {
  const manifest = await readManifest();
  const verdict = evaluate(manifest);
  const text = JSON.stringify(verdict, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, `${text}\n`, 'utf8');
  }
  console.log(text);
  process.exit(verdict.eligible ? 0 : 1);
} catch (e) {
  console.error(`groundtruth-accept 失败: ${e.message}`);
  process.exit(2);
}

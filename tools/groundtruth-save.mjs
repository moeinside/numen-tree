#!/usr/bin/env node
/**
 * groundtruth-save — world directory snapshot / restore orchestration.
 *
 * This tool never restores while the tree control port is alive. It always
 * backs up the current world before replacing it, and verifies the snapshot
 * manifest before/after.
 *
 * Usage:
 *   node tools/groundtruth-save.mjs snapshot --world <dir> --out <dir>
 *   node tools/groundtruth-save.mjs restore --snapshot <dir> --world <dir> [--apply]
 *   node tools/groundtruth-save.mjs verify --snapshot <dir>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
const args = process.argv.slice(3);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const flag = (name) => args.includes(`--${name}`);

const treePort = Number(arg('tree-port', process.env.PILOT_TREE_CONTROL_PORT || 8766));

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function manifestFor(dir) {
  const files = walk(dir)
    .filter((rel) => rel !== 'groundtruth-save-manifest.json' && rel !== 'groundtruth-restore-evidence.json')
    .map((rel) => ({
    path: rel,
    size: fs.statSync(path.join(dir, rel)).size,
    sha256: sha256File(path.join(dir, rel)),
  }));
  return { schema: 'groundtruth-save/1', createdAt: new Date().toISOString(), files };
}

function hashManifest(manifest) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(manifest.files || []))
    .digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

async function treeAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${treePort}/status`, {
      signal: AbortSignal.timeout(700),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function assertTreeStopped() {
  if (flag('no-tree-check')) return;
  if (await treeAlive()) {
    throw new Error(`tree control port ${treePort} is alive; stop the tree before restore`);
  }
}

function snapshot() {
  const world = arg('world');
  const out = arg('out');
  if (!world || !out) throw new Error('snapshot requires --world and --out');
  if (!fs.existsSync(world)) throw new Error(`world not found: ${world}`);
  if (path.resolve(out).startsWith(`${path.resolve(world)}${path.sep}`)) {
    throw new Error('snapshot output must not be inside the world directory');
  }
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(world, out);
  const manifest = manifestFor(out);
  writeJson(path.join(out, 'groundtruth-save-manifest.json'), manifest);
  console.log(JSON.stringify({ ok: true, mode: 'snapshot', out, files: manifest.files.length, hash: hashManifest(manifest) }, null, 2));
}

function verifySnapshot(dir) {
  const manifestPath = path.join(dir, 'groundtruth-save-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actual = manifestFor(dir);
  const expected = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const actualMap = new Map(actual.files.map((f) => [f.path, f.sha256]));
  const changed = [];
  for (const [p, h] of expected) if (actualMap.get(p) !== h) changed.push(p);
  for (const [p] of actualMap) if (!expected.has(p)) changed.push(p);
  if (changed.length) throw new Error(`snapshot changed: ${changed.join(', ')}`);
  return { manifest, hash: hashManifest(manifest), files: actual.files.length };
}

async function restore() {
  const snap = arg('snapshot');
  const world = arg('world');
  if (!snap || !world) throw new Error('restore requires --snapshot and --world');
  const verified = verifySnapshot(snap);
  const treeWasAlive = await treeAlive().catch(() => false);
  await assertTreeStopped();
  const apply = flag('apply');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const backup = `${world}.before-restore-${stamp}`;
  const plan = { mode: 'restore', snapshot: snap, world, apply, treeAlive: treeWasAlive, backup, snapshotHash: verified.hash, files: verified.files };
  console.log(JSON.stringify({ ok: true, dryRun: !apply, ...plan }, null, 2));
  if (!apply) return;
  if (fs.existsSync(world)) {
    fs.renameSync(world, backup);
  }
  try {
    copyDir(snap, world);
    fs.rmSync(path.join(world, 'groundtruth-save-manifest.json'), { force: true });
    const after = manifestFor(world);
    if (hashManifest(after) !== verified.hash) throw new Error('post-restore hash mismatch');
    writeJson(path.join(world, 'groundtruth-restore-evidence.json'), {
      ...plan, restoredAt: new Date().toISOString(), afterHash: hashManifest(after),
    });
    console.log(JSON.stringify({ ok: true, restored: true, backup, afterHash: hashManifest(after) }, null, 2));
  } catch (e) {
    fs.rmSync(world, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, world);
    throw e;
  }
}

try {
  if (mode === 'snapshot') snapshot();
  else if (mode === 'restore') await restore();
  else if (mode === 'verify') {
    const snap = arg('snapshot');
    if (!snap) throw new Error('verify requires --snapshot');
    console.log(JSON.stringify({ ok: true, mode: 'verify', ...verifySnapshot(snap) }, null, 2));
  } else {
    throw new Error('usage: snapshot | restore | verify');
  }
} catch (e) {
  console.error(`groundtruth-save: ${e.message}`);
  process.exit(1);
}

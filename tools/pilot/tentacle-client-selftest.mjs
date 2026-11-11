#!/usr/bin/env node
/**
 * tentacle-client-selftest.mjs — local fake-tentacle HTTP self-test.
 *
 * Starts an ephemeral 127.0.0.1 HTTP server that mimics the 8769 tentacle
 * `/health` + `/perception` API. It never binds or contacts the real 8769 port
 * and never talks to the game.
 *
 * Usage:
 *   node tools/pilot/tentacle-client-selftest.mjs
 * Evidence:
 *   logs/tentacle-client-selftest.json
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTentacleClient, FIELDS } from './tentacle-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'logs', 'tentacle-client-selftest.json');

const UUID_OK = '11111111-1111-4111-8111-111111111111';
const UUID_NOT_READY = '22222222-2222-4222-8222-222222222222';
const UUID_BAD_JSON = '33333333-3333-4333-8333-333333333333';
const UUID_SLOW = '44444444-4444-4444-8444-444444444444';

const cases = [];
const requests = [];
let failures = 0;
let mock = null;
let port = null;
let journalDir = null;
let journalPath = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function check(id, name, fn) {
  try {
    await fn();
    cases.push({ id, name, ok: true });
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    failures += 1;
    const detail = String(e?.message || e);
    cases.push({ id, name, ok: false, detail });
    console.log(`FAIL ${id} ${name} -- ${detail}`);
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function samplePerception(uuid) {
  return {
    ok: true,
    mod: 'numen_tree_tentacle',
    version: '0.3.0',
    tick: 42,
    self: {
      uuid,
      name: 'bigwhale',
      x: 126.69,
      y: 66,
      z: 183.69,
      yaw: 90,
      pitch: 0,
      hp: 20,
      max_hp: 20,
      food: 5,
      dimension: 'minecraft:overworld',
      light: 12,
      day: true,
      day_time: 6000,
    },
    limits: { radius: 16, vision_range: 16, fov: 100, limit: 20 },
    terrain: {
      in_water: false,
      in_lava: false,
      on_ground: true,
      feet: { id: 'minecraft:grass_block', solid: true, liquid: false },
      head: { id: 'minecraft:air', solid: false, liquid: false },
      above: { id: 'minecraft:air', solid: false, liquid: false },
      below: { id: 'minecraft:stone', solid: true, liquid: false },
      dirs: [
        { dx: 1, dz: 0, standable: true, feet: 'minecraft:grass_block', head: 'minecraft:air' },
        { dx: -1, dz: 0, standable: false, feet: 'minecraft:water', head: 'minecraft:air' },
      ],
    },
    water: {
      open_count: 3,
      ice_covered_count: 0,
      nearest_open: { x: 120, y: 63, z: 180, distance: 7.1 },
      nearest_ice: null,
    },
    entities: [
      { id: 'e1', type: 'minecraft:zombie', category: 'hostile', x: 130, y: 66, z: 180, distance: 5.2, hp: 20 },
      { id: 'e2', type: 'minecraft:cow', category: 'animal', x: 128, y: 66, z: 186, distance: 3.1, hp: 10 },
    ],
    landmarks: [
      { kind: 'chest', x: 124, y: 66, z: 183, distance: 2.7 },
      { kind: 'torch', x: 126, y: 66, z: 181, distance: 2.0 },
    ],
  };
}

async function startMock() {
  mock = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      json(res, 200, { ok: true, mod: 'numen_tree_tentacle', version: '0.3.0', port: 8769, server: true });
      return;
    }
    if (url.pathname !== '/perception') {
      json(res, 404, { ok: false, error: 'unknown endpoint' });
      return;
    }
    const uuid = url.searchParams.get('uuid');
    if (uuid === UUID_NOT_READY) {
      json(res, 200, { ok: false, error: 'server not ready' });
      return;
    }
    if (uuid === UUID_BAD_JSON) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('this is not json');
      return;
    }
    if (uuid === UUID_SLOW) {
      await sleep(300);
      json(res, 200, samplePerception(uuid));
      return;
    }
    if (uuid !== UUID_OK) {
      json(res, 200, { ok: false, error: 'entity not found' });
      return;
    }
    json(res, 200, samplePerception(uuid));
  });
  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.listen(0, '127.0.0.1', resolve);
  });
  port = mock.address().port;
  assert(port !== 8769, 'mock server must not bind the real tentacle port');
}

async function stopMock() {
  if (!mock) return;
  await new Promise((resolve) => mock.close(resolve));
  mock = null;
}

async function freeClosedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const p = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return p;
}

async function main() {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tentacle-client-selftest-'));
  journalPath = path.join(journalDir, 'tentacle_use.jsonl');
  await startMock();

  const client = createTentacleClient({
    host: '127.0.0.1',
    port,
    timeoutMs: 500,
    runId: 'tentacle-selftest-run',
    purpose: 'selftest',
    journalPath,
  });

  await check('T1', 'health returns mod/version', async () => {
    const r = await client.health();
    assert(r.ok === true, JSON.stringify(r));
    assert(r.mod === 'numen_tree_tentacle', `mod=${r.mod}`);
    assert(r.version === '0.3.0', `version=${r.version}`);
    assert(r.authority.actionPrecondition === false, 'authority should be non-action');
  });

  await check('T2', 'perception returns all five projections', async () => {
    const r = await client.perception({ uuid: UUID_OK, fields: FIELDS });
    assert(r.ok === true, JSON.stringify(r));
    for (const f of FIELDS) assert(r.summary[f] != null, `missing projection ${f}`);
    assert(r.summary.self.hp === 20, 'self.hp');
    assert(r.summary.entities.hostiles === 1, 'hostile count');
    assert(r.summary.entities.animals === 1, 'animal count');
    assert(r.summary.water.open_count === 3, 'water count');
    assert(r.summary.landmarks.count === 2, 'landmark count');
    assert(r.authority.role === 'diagnostic', 'authority role');
    assert(r.authority.actionPrecondition === false, 'tentacle must not be an action precondition');
  });

  await check('T3', 'per-field queries select only that projection', async () => {
    for (const f of FIELDS) {
      const r = await client.query(f, { uuid: UUID_OK });
      assert(r.ok === true, `${f}: ${JSON.stringify(r)}`);
      assert(r.summary[f] != null, `${f} missing`);
      for (const other of FIELDS) {
        if (other !== f) assert(r.summary[other] === undefined, `${f} query leaked ${other}`);
      }
    }
  });

  await check('T4', 'missing uuid rejected locally (no HTTP)', async () => {
    requests.length = 0;
    const r = await client.perception({});
    assert(r.ok === false && r.error.code === 'missing_uuid', JSON.stringify(r));
    assert(requests.length === 0, 'sent HTTP without uuid');
  });

  await check('T5', 'invalid uuid rejected locally', async () => {
    const r = await client.perception({ uuid: 'not-a-uuid' });
    assert(r.ok === false && r.error.code === 'invalid_uuid', JSON.stringify(r));
  });

  await check('T6', 'timeout is structured', async () => {
    const fast = createTentacleClient({
      host: '127.0.0.1',
      port,
      timeoutMs: 60,
      runId: 'tentacle-selftest-run',
      journalPath,
    });
    const r = await fast.perception({ uuid: UUID_SLOW });
    assert(r.ok === false && r.error.code === 'timeout', JSON.stringify(r));
  });

  await check('T7', 'bad JSON is invalid_response', async () => {
    const r = await client.perception({ uuid: UUID_BAD_JSON });
    assert(r.ok === false && r.error.code === 'invalid_response', JSON.stringify(r));
    assert(r.httpStatus === 200, `status=${r.httpStatus}`);
  });

  await check('T8', 'mod ok:false is structured (server_not_ready)', async () => {
    const r = await client.perception({ uuid: UUID_NOT_READY });
    assert(r.ok === false && r.error.code === 'server_not_ready', JSON.stringify(r));
    assert(r.tentacleError === 'server not ready', `tentacleError=${r.tentacleError}`);
  });

  await check('T9', 'network error is structured', async () => {
    const closed = await freeClosedPort();
    const dead = createTentacleClient({
      host: '127.0.0.1',
      port: closed,
      timeoutMs: 300,
      runId: 'tentacle-selftest-run',
      journalPath,
    });
    const r = await dead.perception({ uuid: UUID_OK });
    assert(r.ok === false && r.error.code === 'network_error', JSON.stringify(r));
  });

  await check('T10', 'non-loopback host refused by default', async () => {
    let threw = false;
    try {
      createTentacleClient({ host: '192.0.2.10', port: 8769 });
    } catch {
      threw = true;
    }
    assert(threw, 'non-loopback client created');
  });

  await check('T11', 'journal has runId/purpose/summary and non-authority flags', async () => {
    assert(fs.existsSync(journalPath), 'journal missing');
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    assert(lines.length >= 12, `journal lines=${lines.length}`);
    for (const line of lines) {
      const rec = JSON.parse(line);
      assert(rec.schema === 'numen-tentacle-use/1', `schema=${rec.schema}`);
      assert(rec.source === 'tentacle-client', `source=${rec.source}`);
      assert(rec.runId === 'tentacle-selftest-run', `runId=${rec.runId}`);
      assert(typeof rec.purpose === 'string' && rec.purpose, `purpose missing: ${JSON.stringify(rec)}`);
      assert(rec.authority === 'diagnostic-only', `authority=${rec.authority}`);
      assert(rec.actionPrecondition === false, 'actionPrecondition should be false');
      assert(rec.assisted === false, 'diagnostic call must not be marked assisted');
      if (rec.ok) assert(rec.summary != null, 'successful call has no summary');
      else assert(rec.error && rec.error.code, 'failed call has no structured error');
    }
    const success = lines.map((l) => JSON.parse(l)).find((r) => r.ok && r.summary?.self);
    assert(success, 'no successful journal summary');
    assert(!JSON.stringify(success).includes('"raw"'), 'journal should not include raw perception');
  });

  await check('T12', 'journal path derives from runId/runDir', async () => {
    const runRoot = fs.mkdtempSync(path.join(journalDir, 'run-'));
    const derived = createTentacleClient({
      host: '127.0.0.1',
      port,
      timeoutMs: 500,
      runId: 'derived-run',
      purpose: 'derived-purpose',
      runDir: runRoot,
    });
    const r = await derived.health();
    assert(r.ok === true, JSON.stringify(r));
    const file = path.join(runRoot, 'tentacle_use.jsonl');
    assert(fs.existsSync(file), `journal not created at ${file} (journalPath=${derived.journalPath}, journalError=${r.journalError})`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert(rec.runId === 'derived-run', `runId=${rec.runId}`);
    assert(rec.purpose === 'derived-purpose', `purpose=${rec.purpose}`);
  });

  await stopMock();

  const report = {
    suite: 'tentacle-client',
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    passed: failures === 0,
    counts: { total: cases.length, failed: failures },
    cases,
    safety: {
      realTentacleContacted: false,
      port8769Contacted: false,
      mockServer: `ephemeral 127.0.0.1:${port}, stopped after test`,
      journalTempOnly: true,
      gameRestarted: false,
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.rmSync(journalDir, { recursive: true, force: true });
  console.log(`node=${cases.length - failures}/${cases.length}`);
  console.log(`evidence: ${path.relative(ROOT, OUT)}`);
  if (failures) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await stopMock();
  process.exitCode = 1;
});

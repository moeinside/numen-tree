#!/usr/bin/env node
/**
 * gm-provider-selftest.mjs — mock-HTTP self-test for GMProvider.
 *
 * Starts an ephemeral 127.0.0.1 mock server; never contacts the real game or
 * port 8770. Also aggregates the Java policy/HTTP evidence and build artifact
 * metadata into logs/gm-portal-selftest.json.
 *
 * Usage:
 *   node tools/pilot/gm-provider-selftest.mjs
 *   node tools/pilot/gm-provider-selftest.mjs --java-evidence=devtools/build/selftest.json
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createGMProvider } from './gm-provider.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'logs', 'gm-portal-selftest.json');
const BUILD_INFO = path.join(ROOT, 'devtools', 'build', 'build-info.json');
const argv = process.argv.slice(2);
const javaArg = argv.find((a) => a.startsWith('--java-evidence='));
const JAVA_EVIDENCE = javaArg
  ? path.resolve(ROOT, javaArg.slice('--java-evidence='.length))
  : path.join(ROOT, 'devtools', 'build', 'selftest.json');

const TOKEN = 'e'.repeat(64);
const cases = [];
const requests = [];
let failures = 0;
let mock = null;
let baseUrl = null;
let journalDir = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function check(id, name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      cases.push({ id, name, ok: true });
      console.log(`PASS ${id} ${name}`);
    })
    .catch((e) => {
      failures += 1;
      const detail = String(e?.message || e);
      cases.push({ id, name, ok: false, detail });
      console.log(`FAIL ${id} ${name} -- ${detail}`);
    });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function validBody(command = 'tp @s 0 0 0') {
  return {
    runId: 'gm-selftest-001',
    command,
    reason: 'stuck_water',
    selfChallenge: ['really no non-GM path?', 'minimal op is tp', 'mark assisted'],
  };
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function startMock() {
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, raw });

    if (req.url === '/health') {
      json(res, 200, { ok: true, mod: 'numen_devtools', version: '0.1.0', portal: 'dev' });
      return;
    }
    if (req.url !== '/dev/v1/command') {
      json(res, 404, { ok: false, error: { code: 'not_found', message: 'nope' } });
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } });
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { ok: false, error: { code: 'invalid_json', message: 'bad json' } });
      return;
    }
    if (body.command === 'forbidden') {
      json(res, 403, { ok: false, error: { code: 'forbidden_root', message: 'root forbidden' } });
      return;
    }
    if (body.command === 'rate') {
      json(res, 429, { ok: false, error: { code: 'rate_limited', message: 'too many' } }, { 'Retry-After': '7' });
      return;
    }
    if (body.command === 'slow') {
      await sleep(250);
      json(res, 200, { ok: true, result: 1, output: [], world: 'numen-test' });
      return;
    }
    if (body.command === 'commandfail') {
      json(res, 200, { ok: false, error: { code: 'command_failed', message: 'dispatcher rejected' }, result: 0 });
      return;
    }
    if (body.command === 'badjson') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not json');
      return;
    }
    if (body.command === 'huge') {
      json(res, 413, { ok: false, error: { code: 'body_too_large', message: 'too large' } });
      return;
    }
    json(res, 200, { ok: true, result: 1, output: ['Teleported bigwhale'], world: 'numen-test' });
  });
  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.listen(0, '127.0.0.1', resolve);
  });
  const port = mock.address().port;
  assert(port !== 8770, 'mock server must not bind the real GM port');
  baseUrl = `http://127.0.0.1:${port}`;
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
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-provider-selftest-'));
  await startMock();

  const provider = createGMProvider({ baseUrl, token: TOKEN });
  const journalPath = path.join(journalDir, 'gm.jsonl');

  await check('N1', 'valid command succeeds and sends required fields', async () => {
    requests.length = 0;
    const r = await provider.command(validBody());
    assert(r.ok === true, JSON.stringify(r));
    assert(r.result === 1, `result=${r.result}`);
    assert(r.world === 'numen-test', `world=${r.world}`);
    assert(requests.length === 1, `requests=${requests.length}`);
    const req = requests[0];
    assert(req.method === 'POST', `method=${req.method}`);
    assert(req.url === '/dev/v1/command', `url=${req.url}`);
    assert(req.headers.authorization === `Bearer ${TOKEN}`, 'authorization header missing/wrong');
    assert(req.headers['content-type'] === 'application/json', `content-type=${req.headers['content-type']}`);
    const body = JSON.parse(req.raw);
    assert(body.runId === 'gm-selftest-001', 'runId not sent');
    assert(body.reason === 'stuck_water', 'reason not sent');
    assert(Array.isArray(body.selfChallenge) && body.selfChallenge.length === 3, 'selfChallenge not sent');
    assert(body.command === 'tp @s 0 0 0', 'command not sent');
  });

  await check('N2', 'missing runId rejected locally (no HTTP)', async () => {
    requests.length = 0;
    const body = validBody();
    delete body.runId;
    const r = await provider.command(body);
    assert(r.ok === false, 'should fail');
    assert(r.error.code === 'invalid_run_id', JSON.stringify(r));
    assert(requests.length === 0, 'sent HTTP for invalid request');
  });

  await check('N3', 'missing reason rejected locally', async () => {
    requests.length = 0;
    const body = validBody();
    delete body.reason;
    const r = await provider.command(body);
    assert(r.ok === false && r.error.code === 'invalid_reason', JSON.stringify(r));
    assert(requests.length === 0, 'sent HTTP for invalid request');
  });

  await check('N4', 'empty selfChallenge rejected locally', async () => {
    const body = validBody();
    body.selfChallenge = [];
    const r = await provider.command(body);
    assert(r.ok === false && r.error.code === 'invalid_self_challenge', JSON.stringify(r));
  });

  await check('N5', 'missing token rejected locally', async () => {
    requests.length = 0;
    const noToken = createGMProvider({ baseUrl, token: null });
    const r = await noToken.command(validBody());
    assert(r.ok === false && r.error.code === 'missing_token', JSON.stringify(r));
    assert(requests.length === 0, 'sent HTTP without token');
  });

  await check('N6', 'HTTP 401 is structured', async () => {
    const bad = createGMProvider({ baseUrl, token: 'f'.repeat(64) });
    const r = await bad.command(validBody());
    assert(r.ok === false, 'should fail');
    assert(r.httpStatus === 401, `status=${r.httpStatus}`);
    assert(r.error.code === 'unauthorized', JSON.stringify(r));
  });

  await check('N7', 'HTTP 403 preserves policy error code', async () => {
    const r = await provider.command(validBody('forbidden'));
    assert(r.ok === false, JSON.stringify(r));
    assert(r.httpStatus === 403, `status=${r.httpStatus}`);
    assert(r.error.code === 'forbidden_root', JSON.stringify(r));
  });

  await check('N8', 'HTTP 429 exposes Retry-After', async () => {
    const r = await provider.command(validBody('rate'));
    assert(r.ok === false && r.httpStatus === 429, JSON.stringify(r));
    assert(r.error.code === 'rate_limited', JSON.stringify(r));
    assert(r.retryAfter === '7', `retryAfter=${r.retryAfter}`);
  });

  await check('N9', 'timeout is structured', async () => {
    const fast = createGMProvider({ baseUrl, token: TOKEN, timeoutMs: 50 });
    const r = await fast.command(validBody('slow'));
    assert(r.ok === false && r.error.code === 'timeout', JSON.stringify(r));
  });

  await check('N10', 'network error is structured', async () => {
    const port = await freeClosedPort();
    const dead = createGMProvider({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 500 });
    const r = await dead.command(validBody());
    assert(r.ok === false && r.error.code === 'network_error', JSON.stringify(r));
  });

  await check('N11', 'dispatcher failure (HTTP 200 ok=false) preserved', async () => {
    const r = await provider.command(validBody('commandfail'));
    assert(r.ok === false, JSON.stringify(r));
    assert(r.httpStatus === 200, `status=${r.httpStatus}`);
    assert(r.error.code === 'command_failed', JSON.stringify(r));
  });

  await check('N12', 'non-JSON success body is invalid_response', async () => {
    const r = await provider.command(validBody('badjson'));
    assert(r.ok === false && r.error.code === 'invalid_response', JSON.stringify(r));
  });

  await check('N13', 'journal gm.jsonl has assisted/selfChallenge and no token', async () => {
    const jp = createGMProvider({ baseUrl, token: TOKEN, journalPath });
    const r = await jp.command({ ...validBody(), before: { hp: 5 }, after: { hp: 6 } });
    assert(r.ok === true, JSON.stringify(r));
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    assert(lines.length === 1, `lines=${lines.length}`);
    assert(!lines[0].includes(TOKEN), 'token leaked into journal');
    const rec = JSON.parse(lines[0]);
    assert(rec.assisted === true, 'assisted not true');
    assert(rec.source === 'gm-provider', `source=${rec.source}`);
    assert(rec.runId === 'gm-selftest-001', 'runId missing');
    assert(rec.reason === 'stuck_water', 'reason missing');
    assert(Array.isArray(rec.selfChallenge) && rec.selfChallenge.length === 3, 'selfChallenge missing');
    assert(rec.before && rec.before.hp === 5, 'before missing');
    assert(rec.after && rec.after.hp === 6, 'after missing');
    assert(rec.outcome && rec.outcome.ok === true, 'outcome missing');
  });

  await check('N14', 'non-loopback baseUrl refused by default', async () => {
    let threw = false;
    try {
      createGMProvider({ baseUrl: 'http://192.0.2.10:8770', token: TOKEN });
    } catch {
      threw = true;
    }
    assert(threw, 'non-loopback provider created');
  });

  await check('N15', 'health endpoint works', async () => {
    const h = await provider.health();
    assert(h.ok === true, JSON.stringify(h));
    assert(h.mod === 'numen_devtools', `mod=${h.mod}`);
  });

  await check('N16', 'overlong command rejected locally', async () => {
    const r = await provider.command(validBody(`tp @s 0 0 0 ${'x'.repeat(600)}`));
    assert(r.ok === false && r.error.code === 'invalid_command', JSON.stringify(r));
  });

  await check('N17', 'non-array selfChallenge rejected', async () => {
    const body = validBody();
    body.selfChallenge = 'really?';
    const r = await provider.command(body);
    assert(r.ok === false && r.error.code === 'invalid_self_challenge', JSON.stringify(r));
  });

  await check('N18', 'build artifacts exist; production jar omits portal classes', async () => {
    assert(fs.existsSync(BUILD_INFO), `missing ${BUILD_INFO}; run devtools/build.ps1`);
    const info = readJsonFile(BUILD_INFO);
    assert(info.devJar && info.devJar.portalClasses === true, 'dev jar portalClasses should be true');
    assert(info.prodJar && info.prodJar.portalClasses === false, 'prod jar portalClasses should be false');
    for (const [label, meta] of [['devJar', info.devJar], ['prodJar', info.prodJar]]) {
      const file = path.join(ROOT, meta.path);
      assert(fs.existsSync(file), `${label} missing: ${file}`);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      assert(sha === meta.sha256, `${label} sha256 mismatch`);
    }
  });

  await stopMock();

  const javaPresent = fs.existsSync(JAVA_EVIDENCE);
  let java = { present: javaPresent, evidencePath: path.relative(ROOT, JAVA_EVIDENCE) };
  if (javaPresent) {
    try {
      const report = readJsonFile(JAVA_EVIDENCE);
      java = {
        ...java,
        passed: report.passed === true,
        counts: report.counts || null,
        cases: Array.isArray(report.cases) ? report.cases : [],
      };
    } catch (e) {
      java = { ...java, passed: false, error: String(e?.message || e) };
    }
  }

  let artifacts = null;
  if (fs.existsSync(BUILD_INFO)) {
    try {
      artifacts = readJsonFile(BUILD_INFO);
    } catch {
      artifacts = null;
    }
  }

  const nodePassed = failures === 0;
  const javaPassed = java.present && java.passed === true;
  const passed = nodePassed && javaPassed;
  const report = {
    suite: 'gm-portal',
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    passed,
    counts: {
      node: { total: cases.length, failed: failures },
      java: java.counts || null,
    },
    node: { passed: nodePassed, cases },
    java,
    artifacts: artifacts
      ? {
          devJar: artifacts.devJar,
          prodJar: artifacts.prodJar,
          buildGeneratedAt: artifacts.generatedAt,
        }
      : null,
    safety: {
      realGameContacted: false,
      realWorldCommandsSent: false,
      installedIntoGame: false,
      gameRestarted: false,
      port8770Contacted: false,
      mockServer: 'ephemeral 127.0.0.1 port, stopped after test',
      journalTempOnly: true,
    },
    pending: [
      'real NeoForge load + /tp on a test world (needs Lead authorization and one game restart)',
      'real portal token/config on the operator machine',
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.rmSync(journalDir, { recursive: true, force: true });

  console.log(`node=${cases.length - failures}/${cases.length} java=${javaPresent ? (javaPassed ? 'PASS' : 'FAIL') : 'MISSING'}`);
  console.log(`evidence: ${path.relative(ROOT, OUT)}`);
  if (!passed) process.exitCode = 1;
}

main()
  .catch(async (e) => {
    console.error(e);
    await stopMock();
    process.exitCode = 1;
  });

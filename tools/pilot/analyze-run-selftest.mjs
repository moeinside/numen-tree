#!/usr/bin/env node
/**
 * analyze-run-selftest.mjs — temp-run self-test for the one-shot analyzer.
 *
 * Creates a synthetic run under the OS temp dir (never touches runs/ or the
 * real archive/), analyzes it into a temp archive, and verifies:
 * - summary fields (segments, failures, tokens/calls, repeated observations, GM/tentacle usage);
 * - archive/<runId>/analysis.{json,md} are written;
 * - the run directory is unchanged by analysis;
 * - the default CLI output contains paths + one sentence, no trace body.
 *
 * Evidence: logs/analyze-run-selftest.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { analyzeRun, formatAnalysisSummary, ANALYSIS_SCHEMA } from './analyze-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(HERE, 'analyze-run.mjs');
const OUT = path.join(ROOT, 'logs', 'analyze-run-selftest.json');
const MARKER = 'TRACE_MARKER_9f3'; // must never appear in default output/analysis body

const cases = [];
let failures = 0;
let tmpRoot = null;
let runDir = null;
let archiveRoot = null;

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

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
}

function fingerprint(dir) {
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return `${name}:${st.size}:${Math.round(st.mtimeMs)}`;
    });
}

function buildRun() {
  const base = Date.parse('2026-11-10T00:00:00.000Z');
  const at = (ms) => new Date(base + ms).toISOString();
  const manifest = {
    runId: 'selftest-run-001',
    dir: runDir,
    mode: 'reference-pilot',
    provider: 'mock',
    companion: 'bigwhale',
    dryRun: false,
    caps: { steps: 10, minutes: 5, maxTokens: 5000 },
    startedAt: at(0),
    endedAt: at(15 * 60_000),
    steps: 4,
    approvals: 1,
    cheatCount: 0,
    abortReason: 'action_error:boom',
    tokens: 1234,
    llmCalls: 3,
    repeatedObservations: 2,
    assisted: false,
    owner: 'pilot-selftest',
    fencing: 9,
    codeVersion: 'selftest',
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(runDir, 'report.md'),
    `# Pilot run selftest-run-001\n\n- steps: 4\n- tokens: 1234\n`,
    'utf8',
  );
  writeJsonl(path.join(runDir, 'observations.jsonl'), [
    { kind: 'observe', at: at(1000), companions: 'c', events: 'e', self: `hp=20 ${MARKER}`, hash: 'h1', unchanged: false },
    { kind: 'observe', at: at(2000), companions: 'c', events: 'e', self: 'hp=20', hash: 'h1', unchanged: true },
    { kind: 'observe', at: at(3000), companions: 'c', events: 'e', self: 'hp=19', hash: 'h2', unchanged: false },
    { kind: 'observe', at: at(20 * 60_000), companions: 'c2', events: 'e2', self: 'hp=18', hash: 'h3', unchanged: false },
    { kind: 'observe', at: at(20 * 60_000 + 1000), companions: 'c2', events: 'e2', self: 'hp=18', hash: 'h3', unchanged: true },
    { kind: 'observe_error', at: at(20 * 60_000 + 2000), error: 'lua failed: timeout' },
  ]);
  writeJsonl(path.join(runDir, 'actions.jsonl'), [
    { at: at(1000), step: 0, action: { action: 'observe' } },
    { at: at(2000), step: 1, action: { action: 'get_events' } },
    { at: at(3000), step: 2, action: { action: 'lua', code: 'return 1', usage: { total_tokens: 1000 } } },
    { at: at(4 * 60_000), step: 3, action: { action: 'lua', code: 'return 2', usage: { total_tokens: 234 } } },
  ]);
  writeJsonl(path.join(runDir, 'raw.jsonl'), [
    { at: at(1000), kind: 'step', step: 0, result: { ok: true, text: 'ok' } },
    { at: at(3000), kind: 'step', step: 2, result: { ok: true, text: 'ok' } },
    { at: at(4 * 60_000), kind: 'step', step: 3, result: { ok: false, isError: false, text: 'action failed: boom' } },
  ]);
  fs.writeFileSync(
    path.join(runDir, 'console.log'),
    [
      `[2026-11-10T00:00:01.000Z] run start selftest-run-001`,
      `[2026-11-10T00:00:04.000Z] error: boom`,
      `[2026-11-10T00:00:05.000Z] dev lease release: {"ok":true}`,
    ].join('\n') + '\n',
    'utf8',
  );
  writeJsonl(path.join(runDir, 'gm.jsonl'), [
    {
      ts: at(5 * 60_000),
      schema: 'numen-gm/1',
      source: 'gm-provider',
      assisted: true,
      runId: 'selftest-run-001',
      reason: 'stuck_water',
      command: 'tp @s 0 0 0',
      outcome: { ok: true, result: 1 },
    },
    {
      ts: at(6 * 60_000),
      schema: 'numen-gm/1',
      source: 'gm-provider',
      assisted: true,
      runId: 'selftest-run-001',
      reason: 'reset_fixture',
      command: 'give @s bread 1',
      outcome: { ok: false, error: { code: 'forbidden_root', message: 'nope' } },
    },
  ]);
  writeJsonl(path.join(runDir, 'tentacle_use.jsonl'), [
    {
      ts: at(7 * 60_000),
      schema: 'numen-tentacle-use/1',
      source: 'tentacle-client',
      runId: 'selftest-run-001',
      purpose: 'diagnose water',
      fields: ['water'],
      ok: true,
      actionPrecondition: false,
      authority: 'diagnostic-only',
    },
    {
      ts: at(8 * 60_000),
      schema: 'numen-tentacle-use/1',
      source: 'tentacle-client',
      runId: 'selftest-run-001',
      purpose: 'health',
      fields: ['health'],
      ok: false,
      error: { code: 'network_error', message: 'down' },
      actionPrecondition: false,
      authority: 'diagnostic-only',
    },
  ]);
}

async function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-run-selftest-'));
  runDir = path.join(tmpRoot, 'runs', 'selftest-run-001');
  archiveRoot = path.join(tmpRoot, 'archive');
  fs.mkdirSync(runDir, { recursive: true });
  buildRun();

  const before = fingerprint(runDir);
  let result = null;

  await check('A1', 'analyzeRun succeeds and archives analysis.json/md', async () => {
    result = analyzeRun({ run: runDir, archiveRoot, now: new Date('2026-11-10T00:30:00.000Z') });
    assert(result.ok === true, 'analyzeRun not ok');
    assert(result.analysis.schema === ANALYSIS_SCHEMA, `schema=${result.analysis.schema}`);
    assert(result.runId === 'selftest-run-001', `runId=${result.runId}`);
    assert(fs.existsSync(result.files.json), `missing ${result.files.json}`);
    assert(fs.existsSync(result.files.md), `missing ${result.files.md}`);
    assert(result.files.json === path.join(archiveRoot, 'selftest-run-001', 'analysis.json'), 'json path');
    assert(result.files.md === path.join(archiveRoot, 'selftest-run-001', 'analysis.md'), 'md path');
  });

  await check('A2', 'segments split on the 17-minute gap', async () => {
    assert(result.analysis.segments.length === 2, `segments=${result.analysis.segments.length}`);
    const [s1, s2] = result.analysis.segments;
    assert(s1.observations === 3, `s1 observations=${s1.observations}`);
    assert(s2.observations === 3, `s2 observations=${s2.observations}`);
    assert(s2.errors === 1, `s2 errors=${s2.errors}`);
    assert(s1.repeated === 1 && s2.repeated === 1, 'repeated per segment');
  });

  await check('A3', 'failure list includes abort/action/observation/GM/tentacle', async () => {
    const codes = new Set(result.analysis.failures.map((f) => f.code));
    for (const code of ['abort', 'action_error', 'observe_error', 'forbidden_root', 'network_error']) {
      assert(codes.has(code), `missing failure code ${code}; got ${[...codes].join(',')}`);
    }
    assert(result.analysis.failures.some((f) => f.code === 'abort' && f.message === 'action_error:boom'), 'abort detail');
  });

  await check('A4', 'token/call/repeat metrics are populated', async () => {
    const u = result.analysis.usage;
    assert(u.tokens === 1234, `tokens=${u.tokens}`);
    assert(u.llmCalls === 3, `llmCalls=${u.llmCalls}`);
    assert(u.steps === 4, `steps=${u.steps}`);
    assert(u.repeatedObservations === 2, `repeated=${u.repeatedObservations}`);
    assert(u.repeatedRate === 0.4, `repeatedRate=${u.repeatedRate}`);
    assert(u.uniqueObservations === 3, `unique=${u.uniqueObservations}`);
    assert(u.effectiveObservations === 3, `effective=${u.effectiveObservations}`);
    assert(u.actions === 4, `actions=${u.actions}`);
    assert(u.actionCounts.lua === 2, `lua count=${u.actionCounts.lua}`);
    assert(u.tokensFromActions === 1234, `tokensFromActions=${u.tokensFromActions}`);
  });

  await check('A5', 'GM usage summary', async () => {
    const g = result.analysis.gm;
    assert(g.used === true && g.count === 2, JSON.stringify(g));
    assert(g.assistedCount === 2, `assisted=${g.assistedCount}`);
    assert(g.okCount === 1 && g.failCount === 1, `ok/fail=${g.okCount}/${g.failCount}`);
    assert(g.reasons.includes('stuck_water') && g.reasons.includes('reset_fixture'), 'reasons');
  });

  await check('A6', 'tentacle usage summary and non-authority flag', async () => {
    const t = result.analysis.tentacle;
    assert(t.used === true && t.count === 2, JSON.stringify(t));
    assert(t.okCount === 1 && t.failCount === 1, `ok/fail=${t.okCount}/${t.failCount}`);
    assert(t.purposes.includes('diagnose water'), 'purpose missing');
    assert(t.fields.includes('water'), 'fields missing');
    assert(t.nonAuthoritative === true, 'tentacle should be non-authoritative');
    assert(t.actionPreconditionTrue === 0, `actionPreconditionTrue=${t.actionPreconditionTrue}`);
  });

  await check('A7', 'run directory is unchanged (read-only)', async () => {
    const after = fingerprint(runDir);
    assert(JSON.stringify(before) === JSON.stringify(after), 'run dir changed during analysis');
    assert(result.analysis.readOnly.runUnchanged === true, 'analysis reported runUnchanged=false');
    assert(result.runUnchanged === true, 'result.runUnchanged=false');
  });

  await check('A8', 'analysis body does not embed raw observation text', async () => {
    const json = fs.readFileSync(result.files.json, 'utf8');
    const md = fs.readFileSync(result.files.md, 'utf8');
    const markdown = result.markdown;
    assert(!json.includes(MARKER), 'analysis.json leaked raw observation text');
    assert(!md.includes(MARKER), 'analysis.md leaked raw observation text');
    assert(!markdown.includes(MARKER), 'returned markdown leaked raw observation text');
  });

  await check('A9', 'default summary is paths + one sentence, no trace body', async () => {
    const text = formatAnalysisSummary(result);
    const lines = text.trim().split(/\r?\n/);
    assert(lines.length === 3, `lines=${lines.length}`);
    assert(lines[0].startsWith('analysis: '), lines[0]);
    assert(lines[1].startsWith('json: '), lines[1]);
    assert(lines[2].startsWith('summary: '), lines[2]);
    assert(!text.includes(MARKER), 'summary leaked trace body');
    assert(text.includes('step(s)') && text.includes('LLM call(s)'), 'summary lacks key metrics');
  });

  await check('A10', 'CLI default stdout has no body', async () => {
    const cliArchive = path.join(tmpRoot, 'cli-archive');
    const r = spawnSync(
      process.execPath,
      [SCRIPT, `--run=${runDir}`, `--archive-root=${cliArchive}`],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (r.error) throw r.error;
    assert(r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
    assert(r.stdout.includes('analysis: '), `stdout=${r.stdout}`);
    assert(r.stdout.includes('summary: '), `stdout=${r.stdout}`);
    assert(!r.stdout.includes(MARKER), 'CLI leaked trace body');
    assert(r.stdout.trim().split(/\r?\n/).length === 3, `stdout lines=${r.stdout}`);
    assert(fs.existsSync(path.join(cliArchive, 'selftest-run-001', 'analysis.json')), 'CLI archive missing');
  });

  await check('A11', 'missing run is a structured error', async () => {
    let code = null;
    try {
      analyzeRun({ run: path.join(tmpRoot, 'no-such-run'), archiveRoot });
    } catch (e) {
      code = e.code;
    }
    assert(code === 'run_not_found', `code=${code}`);
  });

  const report = {
    suite: 'analyze-run',
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    passed: failures === 0,
    counts: { total: cases.length, failed: failures },
    cases,
    sample: result
      ? {
          runId: result.runId,
          summary: result.summary,
          archiveDir: result.archiveDir,
          segments: result.analysis.segments.length,
          failures: result.analysis.failures.length,
          gm: result.analysis.gm.count,
          tentacle: result.analysis.tentacle.count,
          runUnchanged: result.runUnchanged,
        }
      : null,
    safety: {
      tempRunOnly: true,
      tempArchiveOnly: true,
      realRunsTouched: false,
      realArchiveTouched: false,
      runDirUnchanged: result?.runUnchanged === true,
      traceBodyPrinted: false,
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`node=${cases.length - failures}/${cases.length}`);
  console.log(`evidence: ${path.relative(ROOT, OUT)}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * analyze-run.mjs — one-shot, read-only analysis of a Pilot run directory.
 *
 * It reads `runs/<runId>/` (or an already-archived run), produces a compact
 * `analysis.json` + `analysis.md`, and writes them to `archive/<runId>/`.
 * It never writes into the run directory and never prints the trace body by
 * default: only the archive paths plus a one-line summary.
 *
 * CLI:
 *   node tools/pilot/analyze-run.mjs --run=<runId|path>
 *   node tools/pilot/analyze-run.mjs --run=<runId> --print
 *   node tools/pilot/analyze-run.mjs --run=<runId> --json
 *
 * No acceptance verdict is produced here; this is diagnostic material only
 * (docs/90 §1C / docs/84 §9).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export const ANALYZER_VERSION = '0.1.0';
export const ANALYSIS_SCHEMA = 'numen-run-analysis/1';
export const DEFAULT_SEGMENT_GAP_MS = 120_000;

const NORMAL_ABORTS = new Set([
  'target_reached',
  'stop',
  'max_steps',
  'max_minutes',
  'max_tokens',
  'sigint',
  'llm_stop',
  null,
]);

const RUN_FILES = [
  'manifest.json',
  'observations.jsonl',
  'actions.jsonl',
  'raw.jsonl',
  'console.log',
  'gm.jsonl',
  'tentacle_use.jsonl',
  'report.md',
];

function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return { records: [], badLines: 0, missing: true, bytes: 0 };
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { records, badLines, missing: false, bytes: Buffer.byteLength(text) };
}

function readText(file, maxBytes = 256 * 1024) {
  if (!fs.existsSync(file)) return { text: '', missing: true, bytes: 0 };
  const buf = fs.readFileSync(file);
  const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
  return { text: slice.toString('utf8').replace(/^\uFEFF/, ''), missing: false, bytes: buf.length };
}

function timeOf(rec) {
  const t = Date.parse(rec?.at || rec?.ts || rec?.time || '');
  return Number.isFinite(t) ? t : null;
}

function truncate(value, n = 240) {
  const s = String(value ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function unique(arr) {
  return [...new Set(arr.filter((x) => x != null && x !== ''))];
}

function countBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const key = keyFn(item) ?? 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function resolveRunDir(spec) {
  if (!spec) {
    const runsDir = path.join(ROOT, 'runs');
    if (!fs.existsSync(runsDir)) return null;
    const dirs = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => {
        const full = path.join(runsDir, d.name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return dirs[0]?.full || null;
  }
  const direct = path.resolve(String(spec));
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  for (const base of [path.join(ROOT, 'runs'), path.join(ROOT, 'archive')]) {
    const candidate = path.join(base, String(spec));
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

function fingerprintRun(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = fs.statSync(path.join(dir, d.name));
        return { name: d.name, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function buildSegments(observations, actions, gapMs) {
  const timed = observations
    .map((rec, index) => ({ rec, index, t: timeOf(rec) }))
    .filter((x) => x.t != null)
    .sort((a, b) => a.t - b.t || a.index - b.index);

  const segments = [];
  for (const item of timed) {
    const last = segments[segments.length - 1];
    if (!last || item.t - last._lastT > gapMs) {
      segments.push({
        index: segments.length,
        start: new Date(item.t).toISOString(),
        end: new Date(item.t).toISOString(),
        observations: 0,
        unique: 0,
        repeated: 0,
        errors: 0,
        actions: 0,
        _lastT: item.t,
        _hashes: new Set(),
      });
    }
    const seg = segments[segments.length - 1];
    seg.end = new Date(item.t).toISOString();
    seg._lastT = item.t;
    seg.observations += 1;
    if (item.rec.kind === 'observe_error' || item.rec.kind === 'target_error' || item.rec.error) {
      seg.errors += 1;
    }
    if (item.rec.unchanged === true) seg.repeated += 1;
    if (item.rec.hash) seg._hashes.add(item.rec.hash);
    else seg._hashes.add(JSON.stringify(item.rec));
  }

  for (const seg of segments) seg.unique = seg._hashes.size;

  for (const action of actions) {
    const t = timeOf(action);
    if (t == null) continue;
    let target = null;
    for (const seg of segments) {
      if (t >= Date.parse(seg.start)) target = seg;
      else break;
    }
    if (target) target.actions += 1;
  }

  return segments.map(({ _lastT, _hashes, ...rest }) => {
    const durationMs = Date.parse(rest.end) - Date.parse(rest.start);
    return { ...rest, durationMs, unique: _hashes.size };
  });
}

function collectFailures({ manifest, observations, actions, raw, consoleText, gm, tentacle }) {
  const failures = [];
  const add = (source, at, code, message, extra = {}) => {
    failures.push({ source, at: at ?? null, code, message: truncate(message), ...extra });
  };

  if (manifest?.abortReason && !NORMAL_ABORTS.has(manifest.abortReason)) {
    add('manifest', manifest.endedAt ?? null, 'abort', manifest.abortReason);
  }

  for (const rec of observations) {
    if (rec.kind === 'observe_error') {
      add('observations', rec.at ?? null, 'observe_error', rec.error ?? 'observation failed');
    } else if (rec.kind === 'target_error') {
      add('observations', rec.at ?? null, 'target_error', rec.error ?? 'target predicate failed');
    }
  }

  for (const rec of actions) {
    const action = rec.action || {};
    if (!action.action) {
      add('actions', rec.at ?? null, 'invalid_action', JSON.stringify(action), { step: rec.step ?? null });
    }
  }

  for (const rec of raw) {
    if (rec.kind === 'step' && rec.result && rec.result.ok === false) {
      add('raw', rec.at ?? null, rec.result.isError ? 'tool_error' : 'action_error', rec.result.text, {
        step: rec.step ?? null,
      });
    }
    if (rec.kind === 'fixture' && rec.ok === false) {
      add('raw', rec.at ?? null, 'fixture_failed', rec.text ?? 'fixture failed');
    }
  }

  for (const entry of gm) {
    if (entry?.outcome && entry.outcome.ok === false) {
      add('gm', entry.ts ?? null, entry.outcome.error?.code || 'gm_failed', entry.outcome.error?.message || 'GM failed');
    }
  }

  for (const entry of tentacle) {
    if (entry?.ok === false) {
      add('tentacle', entry.ts ?? null, entry.error?.code || 'tentacle_failed', entry.error?.message || 'tentacle failed', {
        purpose: entry.purpose ?? null,
      });
    }
  }

  // Console findings are advisory only; keep a short list, never the whole log.
  const consoleFindings = [];
  for (const line of String(consoleText || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/\b(error|failed|abort|refus|lock_lost|tree_reappeared)\b/i.test(line) && !/dev lease release/i.test(line)) {
      consoleFindings.push(truncate(line, 220));
      if (consoleFindings.length >= 20) break;
    }
  }

  return { failures, consoleFindings };
}

function buildMarkdown(a) {
  const lines = [];
  lines.push(`# Run analysis ${a.runId}`);
  lines.push('');
  lines.push('> Read-only diagnostic summary generated by `tools/pilot/analyze-run.mjs`.');
  lines.push('> Not acceptance evidence; raw trace remains in the run/archive directory.');
  lines.push('');
  lines.push('## Run');
  lines.push('');
  lines.push('| field | value |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(a.run)) {
    lines.push(`| ${k} | ${v == null ? '' : String(v).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push('## Usage');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(a.usage)) {
    if (v && typeof v === 'object') continue;
    lines.push(`| ${k} | ${v == null ? '' : v} |`);
  }
  lines.push('');
  lines.push('## Segments');
  lines.push('');
  if (!a.segments.length) lines.push('(no timed observations)');
  else {
    lines.push('| # | start | end | duration_ms | observations | unique | repeated | errors | actions |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const s of a.segments) {
      lines.push(
        `| ${s.index} | ${s.start} | ${s.end} | ${s.durationMs} | ${s.observations} | ${s.unique} | ${s.repeated} | ${s.errors} | ${s.actions} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  if (!a.failures.length) lines.push('(none detected)');
  else {
    lines.push('| source | at | code | message |');
    lines.push('|---|---|---|---|');
    for (const f of a.failures) {
      lines.push(
        `| ${f.source} | ${f.at ?? ''} | ${f.code} | ${String(f.message ?? '').replace(/\|/g, '\\|')} |`,
      );
    }
  }
  if (a.consoleFindings.length) {
    lines.push('');
    lines.push('### Console findings (advisory)');
    lines.push('');
    for (const line of a.consoleFindings) lines.push(`- ${line}`);
  }
  lines.push('');
  lines.push('## GM usage');
  lines.push('');
  lines.push(`- used: ${a.gm.used}`);
  lines.push(`- entries: ${a.gm.count}`);
  lines.push(`- assisted entries: ${a.gm.assistedCount}`);
  lines.push(`- reasons: ${a.gm.reasons.join(', ') || '(none)'}`);
  lines.push(`- run marked assisted: ${a.gm.runMarkedAssisted}`);
  lines.push('');
  lines.push('## Tentacle usage');
  lines.push('');
  lines.push(`- used: ${a.tentacle.used}`);
  lines.push(`- entries: ${a.tentacle.count}`);
  lines.push(`- purposes: ${a.tentacle.purposes.join(', ') || '(none)'}`);
  lines.push(`- fields: ${a.tentacle.fields.join(', ') || '(none)'}`);
  lines.push(`- non-authoritative: ${a.tentacle.nonAuthoritative}`);
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const [k, v] of Object.entries(a.files)) {
    lines.push(`- ${k}: ${v.missing ? '(missing)' : v.bytes + ' bytes'}`);
  }
  lines.push('');
  if (a.notes.length) {
    lines.push('## Notes');
    lines.push('');
    for (const note of a.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Analyze one run directory.
 * @returns {{ok:true, runId, summary, analysis, markdown, archiveDir, files, runUnchanged}}
 */
export function analyzeRun({
  run,
  archiveRoot = path.join(ROOT, 'archive'),
  segmentGapMs = DEFAULT_SEGMENT_GAP_MS,
  now = new Date(),
} = {}) {
  const runDir = resolveRunDir(run);
  if (!runDir) {
    const e = new Error(`run directory not found: ${run ?? '(latest)'}`);
    e.code = 'run_not_found';
    throw e;
  }
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const e = new Error(`manifest.json not found in ${runDir}`);
    e.code = 'missing_manifest';
    throw e;
  }

  const before = fingerprintRun(runDir);
  const manifest = readJsonFile(manifestPath);
  const runId = String(manifest.runId || path.basename(runDir));
  const observationsFile = readJsonl(path.join(runDir, 'observations.jsonl'));
  const actionsFile = readJsonl(path.join(runDir, 'actions.jsonl'));
  const rawFile = readJsonl(path.join(runDir, 'raw.jsonl'));
  const gmFile = readJsonl(path.join(runDir, 'gm.jsonl'));
  const tentacleFile = readJsonl(path.join(runDir, 'tentacle_use.jsonl'));
  const consoleFile = readText(path.join(runDir, 'console.log'));

  const observations = observationsFile.records;
  const actions = actionsFile.records;
  const raw = rawFile.records;
  const gm = gmFile.records;
  const tentacle = tentacleFile.records;

  const actionTokenSum = actions.reduce(
    (sum, rec) => sum + (Number(rec?.action?.usage?.total_tokens) || 0),
    0,
  );
  const observeRecords = observations.filter((r) => r?.kind === 'observe');
  const computedRepeated = observeRecords.filter((r) => r.unchanged === true).length;
  const hashes = new Set(observeRecords.map((r) => r.hash).filter(Boolean));
  const repeated = Number.isFinite(Number(manifest.repeatedObservations))
    ? Number(manifest.repeatedObservations)
    : computedRepeated;
  const steps = Number.isFinite(Number(manifest.steps)) ? Number(manifest.steps) : actions.length;
  const tokens = Number.isFinite(Number(manifest.tokens)) ? Number(manifest.tokens) : actionTokenSum;
  const llmCalls = Number.isFinite(Number(manifest.llmCalls)) ? Number(manifest.llmCalls) : actions.length;
  const uniqueObs = hashes.size || Math.max(0, observeRecords.length - computedRepeated);
  const effectiveObs = Math.max(0, observeRecords.length - repeated);

  const startedAt = manifest.startedAt ?? observations[0]?.at ?? null;
  const endedAt = manifest.endedAt ?? observations[observations.length - 1]?.at ?? null;
  const durationMs =
    startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null;

  const segments = buildSegments(observations, actions, segmentGapMs);

  const gmOutcomes = gm.map((e) => e?.outcome).filter(Boolean);
  const gmUsage = {
    used: gm.length > 0 || manifest.assisted === true || manifest.gm === true,
    count: gm.length,
    assistedCount: gm.filter((e) => e?.assisted === true).length,
    runMarkedAssisted: manifest.assisted === true || manifest.gm === true,
    reasons: unique(gm.map((e) => e?.reason)),
    okCount: gmOutcomes.filter((o) => o.ok === true).length,
    failCount: gmOutcomes.filter((o) => o.ok === false).length,
    commands: gm.slice(0, 10).map((e) => truncate(e?.command, 200)),
  };

  const tentacleUsage = {
    used: tentacle.length > 0,
    count: tentacle.length,
    okCount: tentacle.filter((e) => e?.ok === true).length,
    failCount: tentacle.filter((e) => e?.ok === false).length,
    purposes: unique(tentacle.map((e) => e?.purpose)),
    fields: unique(tentacle.flatMap((e) => (Array.isArray(e?.fields) ? e.fields : []))),
    nonAuthoritative: tentacle.every((e) => e?.actionPrecondition !== true),
    actionPreconditionTrue: tentacle.filter((e) => e?.actionPrecondition === true).length,
  };

  const { failures, consoleFindings } = collectFailures({
    manifest,
    observations,
    actions,
    raw,
    consoleText: consoleFile.text,
    gm,
    tentacle,
  });

  const after = fingerprintRun(runDir);
  const runUnchanged = JSON.stringify(before) === JSON.stringify(after);

  const usage = {
    steps,
    tokens,
    llmCalls,
    observations: observations.length,
    observeRecords: observeRecords.length,
    uniqueObservations: uniqueObs,
    effectiveObservations: effectiveObs,
    repeatedObservations: repeated,
    repeatedRate: observeRecords.length ? Number((repeated / observeRecords.length).toFixed(3)) : 0,
    tokensPerStep: steps ? Number((tokens / steps).toFixed(1)) : 0,
    tokensPerEffectiveObservation: effectiveObs ? Number((tokens / effectiveObs).toFixed(1)) : 0,
    actions: actions.length,
    actionCounts: countBy(actions, (r) => r?.action?.action),
    tokensFromManifest: Number.isFinite(Number(manifest.tokens)) ? Number(manifest.tokens) : null,
    tokensFromActions: actionTokenSum,
  };

  const files = {
    manifest: { missing: false, bytes: fs.statSync(manifestPath).size },
    observations: { missing: observationsFile.missing, bytes: observationsFile.bytes },
    actions: { missing: actionsFile.missing, bytes: actionsFile.bytes },
    raw: { missing: rawFile.missing, bytes: rawFile.bytes },
    console: { missing: consoleFile.missing, bytes: consoleFile.bytes },
    gm: { missing: gmFile.missing, bytes: gmFile.bytes },
    tentacleUse: { missing: tentacleFile.missing, bytes: tentacleFile.bytes },
  };

  const runInfo = {
    mode: manifest.mode ?? null,
    provider: manifest.provider ?? null,
    companion: manifest.companion ?? null,
    dryRun: manifest.dryRun ?? null,
    steps,
    startedAt,
    endedAt,
    durationMs,
    abortReason: manifest.abortReason ?? null,
    exitCode: manifest.exitCode ?? null,
    caps: manifest.caps ? JSON.stringify(manifest.caps) : null,
    approvals: manifest.approvals ?? null,
    cheatCount: manifest.cheatCount ?? null,
    owner: manifest.owner ?? null,
    fencing: manifest.fencing ?? null,
    codeVersion: manifest.codeVersion ?? null,
  };

  const notes = [];
  if (observationsFile.badLines) notes.push(`${observationsFile.badLines} malformed observations.jsonl line(s)`);
  if (actionsFile.badLines) notes.push(`${actionsFile.badLines} malformed actions.jsonl line(s)`);
  if (!gmFile.missing) notes.push('gm.jsonl present; GM run must stay assisted and out of acceptance/learning');
  if (gm.length && gmUsage.assistedCount !== gm.length) notes.push('some gm.jsonl entries are not marked assisted:true');
  if (gm.length && manifest.assisted !== true) {
    notes.push('GM used but manifest.assisted is not true; this run must not be acceptance/learning evidence');
  }
  if (tentacle.length) notes.push('tentacle use is diagnostic only; never an action precondition authority');
  if (!runUnchanged) notes.push('run directory changed during analysis (unexpected; inspect)');
  if (manifest.archiveDir && path.resolve(manifest.archiveDir) !== path.resolve(runDir)) {
    notes.push(`manifest.archiveDir points to ${manifest.archiveDir}`);
  }

  const summary = buildOneLine({
    steps,
    llmCalls,
    tokens,
    repeated,
    failures: failures.length,
    segments: segments.length,
    gm: gmUsage,
    tentacle: tentacleUsage,
    abortReason: manifest.abortReason ?? null,
  });

  const analysis = {
    schema: ANALYSIS_SCHEMA,
    version: ANALYZER_VERSION,
    generatedAt: now.toISOString(),
    runId,
    summary,
    source: { runDir, archiveDir: null },
    readOnly: { runUnchanged, fingerprintBefore: before, fingerprintAfter: after },
    run: runInfo,
    usage,
    segments,
    failures,
    consoleFindings,
    gm: gmUsage,
    tentacle: tentacleUsage,
    journalHealth: {
      observationsBadLines: observationsFile.badLines,
      actionsBadLines: actionsFile.badLines,
      rawBadLines: rawFile.badLines,
      gmBadLines: gmFile.badLines,
      tentacleBadLines: tentacleFile.badLines,
    },
    files,
    notes,
  };

  const safeRunId = String(runId).replace(/[^A-Za-z0-9._:-]/g, '_');
  const destDir = path.join(archiveRoot, safeRunId);
  fs.mkdirSync(destDir, { recursive: true });
  analysis.source.archiveDir = destDir;
  const markdown = buildMarkdown(analysis);
  const jsonPath = path.join(destDir, 'analysis.json');
  const mdPath = path.join(destDir, 'analysis.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, markdown, 'utf8');

  return {
    ok: true,
    runId,
    summary,
    analysis,
    markdown,
    archiveDir: destDir,
    files: { json: jsonPath, md: mdPath },
    runUnchanged,
  };
}

function buildOneLine({ steps, llmCalls, tokens, repeated, failures, segments, gm, tentacle, abortReason }) {
  return [
    `${steps} step(s)`,
    `${llmCalls} LLM call(s)`,
    `${tokens} token(s)`,
    `${repeated} repeated observation(s)`,
    `${failures} failure(s)`,
    `${segments} segment(s)`,
    `gm=${gm.count}`,
    `tentacle=${tentacle.count}`,
    `abort=${abortReason ?? 'none'}`,
  ].join(', ');
}

/** Only paths + one sentence; no trace body. */
export function formatAnalysisSummary(result) {
  return [
    `analysis: ${result.files.md}`,
    `json: ${result.files.json}`,
    `summary: ${result.summary}`,
  ].join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const value = eq >= 0 ? raw.slice(eq + 1) : true;
    out[key] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gapMs = args['segment-gap-ms'] ? Number(args['segment-gap-ms']) : DEFAULT_SEGMENT_GAP_MS;
  let result;
  try {
    result = analyzeRun({
      run: args.run || null,
      archiveRoot: args['archive-root'] ? path.resolve(String(args['archive-root'])) : path.join(ROOT, 'archive'),
      segmentGapMs: Number.isFinite(gapMs) && gapMs > 0 ? gapMs : DEFAULT_SEGMENT_GAP_MS,
    });
  } catch (e) {
    console.error(
      JSON.stringify({ ok: false, error: { code: e?.code || 'analysis_failed', message: String(e?.message || e) } }),
    );
    process.exitCode = 1;
    return;
  }

  if (args.print === true || args.print === 'true') {
    process.stdout.write(result.markdown);
    return;
  }
  if (args.json === true || args.json === 'true') {
    console.log(
      JSON.stringify(
        {
          ok: true,
          runId: result.runId,
          summary: result.summary,
          archiveDir: result.archiveDir,
          files: result.files,
          runUnchanged: result.runUnchanged,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(formatAnalysisSummary(result));
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: { code: 'fatal', message: String(e?.message || e) } }));
    process.exitCode = 1;
  });
}

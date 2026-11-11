/**
 * run 目录 / manifest / JSONL 记录
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function createRun({
  mode = 'reference-pilot',
  provider = 'mock',
  companion = null,
  caps = {},
  dryRun = false,
  outDir = null,
} = {}) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  const dir = outDir || path.join(ROOT, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    raw: path.join(dir, 'raw.jsonl'),
    actions: path.join(dir, 'actions.jsonl'),
    observations: path.join(dir, 'observations.jsonl'),
    console: path.join(dir, 'console.log'),
    report: path.join(dir, 'report.md'),
    manifest: path.join(dir, 'manifest.json'),
  };
  for (const f of Object.values(files)) fs.writeFileSync(f, '', { flag: 'a' });
  const manifest = {
    runId,
    dir,
    mode,
    provider,
    companion,
    dryRun,
    caps,
    startedAt: new Date().toISOString(),
    endedAt: null,
    steps: 0,
    approvals: 0,
    cheatCount: 0,
    abortReason: null,
    codeVersion: process.env.PILOT_CODE_VERSION || null,
    host: process.env.COMPUTERNAME || null,
  };
  fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));
  return { runId, dir, files, manifest };
}

export function appendJsonl(file, obj) {
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

export function logConsole(file, line) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
}

export function saveManifest(run) {
  run.manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(run.files.manifest, JSON.stringify(run.manifest, null, 2));
}

export function finishRun(
  run,
  {
    abortReason = run.manifest.abortReason ?? null,
    endedAt = new Date().toISOString(),
  } = {},
) {
  run.manifest.endedAt = endedAt;
  run.manifest.abortReason = abortReason;
  saveManifest(run);
}

export function writeReport(run, extra = {}) {
  const m = run.manifest;
  const lines = [
    `# Pilot run ${m.runId}`,
    '',
    `- mode: ${m.mode}`,
    `- provider: ${m.provider}`,
    `- companion: ${m.companion}`,
    `- dryRun: ${m.dryRun}`,
    `- steps: ${m.steps}`,
    `- tokens: ${m.tokens ?? 0}`,
    `- llmCalls: ${m.llmCalls ?? 0}`,
    `- repeatedObservations: ${m.repeatedObservations ?? 0}`,
    `- approvals: ${m.approvals}`,
    `- cheatCount: ${m.cheatCount}`,
    `- started: ${m.startedAt}`,
    `- ended: ${m.endedAt}`,
    `- abortReason: ${m.abortReason ?? 'none'}`,
    `- caps: ${JSON.stringify(m.caps)}`,
    `- raw: ${run.files.raw}`,
    `- actions: ${run.files.actions}`,
    `- observations: ${run.files.observations}`,
    ...(extra.lines || []),
  ];
  fs.writeFileSync(run.files.report, lines.join('\n'), 'utf8');
}

/** 原样归档一次 run（trace 留档，防上下文/日志丢失）。 */
export function archiveRun(run) {
  const dest = path.join(ROOT, 'archive', run.runId);
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(run.dir, dest, { recursive: true, force: true });
    run.manifest.archivedAt = new Date().toISOString();
    run.manifest.archiveDir = dest;
    saveManifest(run);
    // 把补上 archivedAt/archiveDir 的最终 manifest 也放进归档副本。
    try {
      fs.copyFileSync(run.files.manifest, path.join(dest, 'manifest.json'));
    } catch { /* 归档已成功；manifest 同步失败不改变结果 */ }
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

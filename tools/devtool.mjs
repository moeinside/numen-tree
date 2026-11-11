#!/usr/bin/env node
/**
 * devtool.mjs — thin orchestration for the docs/91 pipeline:
 *
 *   GOAL -> prepare/lease -> Operator subagent -> close -> analyze/pack -> advisors
 *
 * It does NOT start the tree or the game, does NOT taskkill, and does NOT call
 * GM / LLM endpoints. The DSH subagent is the Operator path; the OpenAI
 * provider in run.mjs remains optional.
 *
 * Commands:
 *   node tools/devtool.mjs prepare --goal=<goal.json|inline-json> [--run-id=] [--topic=]
 *   node tools/devtool.mjs operator-brief --run=<id>
 *   node tools/devtool.mjs close --run=<id> [--reason=]
 *   node tools/devtool.mjs analyze --run=<id>
 *   node tools/devtool.mjs status --run=<id>
 *
 * Isolation env (all optional):
 *   PILOT_RUNS_DIR, PILOT_MODE_RUN_DIR, PILOT_LOCK_DIR,
 *   PILOT_TREE_CONTROL_PORT, PILOT_TREE_MCP_PORT, PILOT_NUMEN_PORT,
 *   PILOT_ARCHIVE_DIR, PILOT_PREEMPTION_LOG.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  readLock,
  isPidAlive,
  lockPath,
} from './pilot/lock.mjs';
import {
  getStatus,
  readValidLease,
  currentFencing,
  exitDev,
  off as modeOff,
  writeJsonAtomic,
} from './pilot/mode.mjs';
import { analyzeRun } from './pilot/analyze-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MODE_CLI = path.join(HERE, 'pilot', 'mode.mjs');
const TEMPLATES = path.join(HERE, 'templates');
const VERSION = '2026-11-10.1';
const GOAL_KEYS = ['goal', 'budget', 'environment', 'allowed', 'forbidden', 'success', 'stop', 'logs', 'pack'];
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

const EXIT = { OK: 0, FAIL: 1, USAGE: 2 };

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 10_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runsRoot() {
  return path.resolve(process.env.PILOT_RUNS_DIR || path.join(ROOT, 'runs'));
}

function archiveRoot() {
  return path.resolve(process.env.PILOT_ARCHIVE_DIR || path.join(ROOT, 'archive'));
}

function runDirOf(runId) {
  return path.join(runsRoot(), runId);
}

function generatedRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function validRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function asList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function nonEmptyObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readGoalSource(raw) {
  if (!raw || raw === true) {
    throw Object.assign(new Error('prepare requires --goal=<goal.json|inline-json>'), { code: 'goal_required' });
  }
  const text = String(raw).trim();
  if (text.startsWith('{')) {
    return { raw: JSON.parse(text), source: '(inline)' };
  }
  const file = path.resolve(text);
  if (!exists(file)) {
    throw Object.assign(new Error(`goal file not found: ${file}`), { code: 'goal_not_found' });
  }
  return { raw: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), source: file };
}

function validateGoal(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['goal must be a JSON object'] };
  }
  for (const key of GOAL_KEYS) {
    if (!(key in raw)) errors.push(`missing field: ${key}`);
  }

  if ('goal' in raw && !nonEmptyString(raw.goal)) errors.push('goal must be a non-empty string');
  if ('budget' in raw) {
    if (typeof raw.budget === 'string') {
      if (!nonEmptyString(raw.budget)) errors.push('budget must be a non-empty string or object');
    } else if (nonEmptyObject(raw.budget)) {
      const positive = Object.values(raw.budget).some((v) => Number.isFinite(Number(v)) && Number(v) > 0);
      if (!positive) errors.push('budget must contain at least one positive numeric limit');
    } else {
      errors.push('budget must be a non-empty object or string');
    }
  }
  if ('environment' in raw && !nonEmptyString(raw.environment) && !nonEmptyObject(raw.environment)) {
    errors.push('environment must be a non-empty string or object');
  }
  if ('allowed' in raw && asList(raw.allowed).length === 0) {
    errors.push('allowed must be a non-empty array of action names');
  }
  if ('forbidden' in raw && !Array.isArray(raw.forbidden) && typeof raw.forbidden !== 'string') {
    errors.push('forbidden must be an array (may be empty)');
  }
  for (const key of ['success', 'stop', 'logs']) {
    if (key in raw && asList(raw[key]).length === 0) errors.push(`${key} must be a non-empty array of strings`);
  }
  if ('pack' in raw && !nonEmptyString(raw.pack)) errors.push('pack must be a non-empty string');

  return { ok: errors.length === 0, errors };
}

function normalizeGoal(raw) {
  return {
    goal: String(raw.goal),
    budget: raw.budget,
    environment: raw.environment,
    allowed: asList(raw.allowed),
    forbidden: asList(raw.forbidden),
    success: asList(raw.success),
    stop: asList(raw.stop),
    logs: asList(raw.logs),
    pack: String(raw.pack),
    extra: Object.fromEntries(Object.entries(raw).filter(([k]) => !GOAL_KEYS.includes(k))),
  };
}

function loadRun(runId) {
  if (!validRunId(runId)) {
    throw Object.assign(new Error(`invalid run id: ${runId || '(missing)'}`), { code: 'invalid_run_id' });
  }
  const dir = runDirOf(runId);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) {
    throw Object.assign(new Error(`run not found: ${dir}`), { code: 'run_not_found' });
  }
  return { runId, dir, manifestPath, manifest };
}

function template(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
}

function renderTemplate(text, vars) {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) => {
    if (!(key in vars)) return match;
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

function bullets(items) {
  return items.length ? items.map((x) => `- ${x}`).join('\n') : '- (none)';
}

function mdCell(value, max = 240) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function writeGoalMarkdown(run, goal, source) {
  const goalPath = path.join(run.dir, 'GOAL.md');
  const text = renderTemplate(template('GOAL.md'), {
    runId: run.runId,
    topic: run.topic,
    createdAt: run.createdAt,
    goal: goal.goal,
    budgetJson: JSON.stringify(goal.budget, null, 2),
    environmentJson: JSON.stringify(goal.environment, null, 2),
    allowed: bullets(goal.allowed),
    forbidden: bullets(goal.forbidden),
    success: bullets(goal.success),
    stop: bullets(goal.stop),
    logs: bullets(goal.logs),
    pack: goal.pack,
    goalSource: source,
    goalJson: JSON.stringify(goal.raw, null, 2),
  });
  fs.writeFileSync(goalPath, text, 'utf8');
  return goalPath;
}

function writeManifest(run) {
  writeJsonAtomic(run.manifestPath, run.manifest);
}

function briefMarkdown(run, goal) {
  const env = {
    PILOT_RUN_DIR: run.dir,
    PILOT_RUNS_DIR: runsRoot(),
    PILOT_LOCK_DIR: path.dirname(lockPath()),
    PILOT_MODE_RUN_DIR: path.resolve(process.env.PILOT_MODE_RUN_DIR || path.join(ROOT, 'run')),
    PILOT_TREE_CONTROL_PORT: String(process.env.PILOT_TREE_CONTROL_PORT || 8766),
    PILOT_TREE_MCP_PORT: String(process.env.PILOT_TREE_MCP_PORT || 8767),
    PILOT_NUMEN_PORT: String(process.env.PILOT_NUMEN_PORT || 8765),
  };
  const gmAllowed = goal.allowed.some((x) => /^gm$/i.test(x));
  const lines = [
    `# Operator brief — run ${run.runId}`,
    '',
    '> 你是 Operator 子体：**只执行，不分析，不写总结**。',
    '> 本页是唯一任务合同；GOAL.md / manifest.json 是权威来源。',
    '> 不启动/重启游戏，不 taskkill，不安装 mod。',
    '',
    '## 0. 环境（每个新 shell 先设置）',
    '',
    '```powershell',
    `$env:PILOT_RUN_DIR = "${run.dir}"`,
    `$env:PILOT_NUMEN_PORT = "${env.PILOT_NUMEN_PORT}"`,
    `node tools/pilot/dsh-bridge.mjs status`,
    '```',
    '',
    `- runDir: \`${run.dir}\``,
    `- GOAL: \`${path.join(run.dir, 'GOAL.md')}\``,
    `- manifest: \`${run.manifestPath}\``,
    '',
    '## 1. 目标',
    '',
    goal.goal,
    '',
    '## 2. 预算（先到先停）',
    '',
    '```json',
    JSON.stringify(goal.budget, null, 2),
    '```',
    '',
    '## 3. 允许',
    '',
    bullets(goal.allowed),
    '',
    '## 4. 禁止',
    '',
    bullets(goal.forbidden),
    '',
    '> GM 仅在 allowed 明确包含 GM 时可用；默认禁止。触手只读诊断，不能作为动作前置权威。',
    '',
    '## 5. 成功 / 停止',
    '',
    '成功：',
    '',
    bullets(goal.success),
    '',
    '停止（任一命中立即停）：',
    '',
    bullets(goal.stop),
    '',
    '## 6. 执行规则',
    '',
    '- 每次只发一个 bridge 调用；观察后再决定下一步；',
    '- 只通过 `tools/pilot/dsh-bridge.mjs` 操作 numen MCP；',
    '- 不探索 API、不打印整页 map/help、不重复读未变化状态；',
    '- 不写 summary、不写 `roundtable-pack.md`、不做验收判断；',
    '- 不直接写 `manifest.json`；不删除任何日志；',
    '- 卡住/不确定/危险/预算将尽 → 停，交回 Lead，不要自己扩大范围。',
    '',
    '## 7. 日志（只追加，不整理）',
    '',
    bullets(goal.logs.map((x) => `\`${path.join(run.dir, x)}\``)),
    '',
    '- actions / observations / gm / tentacle_use 均由工具写入；',
    '- 若手动记录，只追加 JSONL，不改既有行。',
    '',
    '## 8. 交接',
    '',
    `完成后回报 Lead：run id、日志路径、停止原因、是否触发禁止项。不要回灌全文。`,
    `Analyze 阶段由独立 Analyst 子体执行：\`node tools/devtool.mjs analyze --run=${run.runId}\`。`,
    '',
    gmAllowed
      ? '> 注意：GOAL 的 allowed/forbidden 仍需逐条遵守；GM 使用必须写 gm.jsonl 并标 assisted。'
      : '> 再次确认：本轮 GOAL 未明确允许 GM。',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function preflightMode() {
  const status = await getStatus({ repair: true });
  const valid = readValidLease();
  if (valid.reason === 'active') {
    const kind = valid.lease?.kind || 'dev';
    return {
      ok: false,
      code: kind === 'dev' ? 'dev_active' : 'tree_active',
      error:
        kind === 'dev'
          ? `lease already held by ${valid.lease?.owner}`
          : `tree lease held by ${valid.lease?.owner}`,
      lease: valid.lease,
      state: status.state,
    };
  }
  if (status.state === 'TREE' || status.ports?.controlOpen || status.ports?.mcpOpen) {
    return {
      ok: false,
      code: 'tree_active',
      error: 'tree is running or declared TREE (8766/8767); stop it before prepare',
      state: status.state,
      ports: status.ports,
    };
  }
  return { ok: true, state: status.state, ports: status.ports };
}

function startHolder(run, goal) {
  const owner = `devtool-${crypto.randomBytes(4).toString('hex')}`;
  const stopFile = path.join(run.dir, '.holder-stop');
  const logFile = path.join(run.dir, 'holder.log');
  const outFd = fs.openSync(logFile, 'a');
  const args = [
    MODE_CLI,
    'dev',
    '--hold',
    `--owner=${owner}`,
    `--run-id=${run.runId}`,
    `--mode=devtool`,
    `--ttl-ms=30000`,
    `--reason=${String(run.topic || 'devtool').slice(0, 120)}`,
  ];
  const env = {
    ...process.env,
    PILOT_HOLDER_STOP_FILE: stopFile,
  };
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, outFd],
    });
    child.on('error', () => { /* readiness timeout reports the structured failure */ });
    child.unref();
  } finally {
    fs.closeSync(outFd);
  }
  return { child, owner, stopFile, logFile };
}

async function cleanupFailedHolder(run, owner, pid) {
  const stopFile = path.join(run.dir, '.holder-stop');
  try {
    fs.writeFileSync(stopFile, `${JSON.stringify({ at: nowIso(), reason: 'prepare_failed' })}\n`, 'utf8');
  } catch { /* best effort */ }
  if (pid) await waitFor(() => !isPidAlive(pid), 5_000, 100);
  const lock = readLock();
  if (lock && lock.owner === owner) {
    await exitDev({ owner, fencing: lock.fencing, actor: 'devtool' });
  }
}

async function cmdPrepare(args) {
  let source;
  let raw;
  try {
    source = readGoalSource(args.goal);
    raw = source.raw;
  } catch (e) {
    print({ ok: false, code: e.code || 'invalid_goal', error: String(e.message || e) });
    return e.code === 'goal_required' ? EXIT.USAGE : EXIT.FAIL;
  }

  const validation = validateGoal(raw);
  if (!validation.ok) {
    print({ ok: false, code: 'invalid_goal', errors: validation.errors, source: source.source });
    return EXIT.USAGE;
  }
  const goal = normalizeGoal(raw);
  goal.raw = raw;

  const runId = args['run-id'] ? String(args['run-id']) : args.run ? String(args.run) : generatedRunId();
  if (!validRunId(runId)) {
    print({ ok: false, code: 'invalid_run_id', error: `invalid run id: ${runId}` });
    return EXIT.USAGE;
  }
  const runDir = runDirOf(runId);
  if (exists(path.join(runDir, 'manifest.json'))) {
    print({ ok: false, code: 'run_exists', error: `run already exists: ${runDir}` });
    return EXIT.FAIL;
  }

  const pre = await preflightMode();
  if (!pre.ok) {
    print({ ok: false, ...pre });
    return EXIT.FAIL;
  }

  const topic = args.topic ? String(args.topic) : goal.goal.slice(0, 80);
  fs.mkdirSync(runDir, { recursive: true });
  const createdAt = nowIso();
  const goalPath = writeGoalMarkdown({ runId, dir: runDir, topic, createdAt }, goal, source.source);
  const manifest = {
    runId,
    dir: runDir,
    mode: 'devtool',
    provider: 'dsh-subagent',
    companion: process.env.NUMEN_COMPANION || null,
    dryRun: false,
    phase: 'preparing',
    topic,
    goal: raw,
    goalPath,
    source: source.source,
    devtool: { version: VERSION, pid: process.pid, host: process.env.COMPUTERNAME || null },
    caps: goal.budget,
    startedAt: createdAt,
    endedAt: null,
    steps: 0,
    tokens: 0,
    llmCalls: 0,
    repeatedObservations: 0,
    approvals: 0,
    cheatCount: 0,
    assisted: false,
    abortReason: null,
    fencing: null,
    holder: null,
    lease: null,
  };
  const run = { runId, dir: runDir, manifestPath: path.join(runDir, 'manifest.json'), manifest, topic, createdAt };
  writeManifest(run);

  const started = startHolder(run, goal);
  const pid = started.child?.pid ?? null;
  const lockReady = await waitFor(() => {
    const lock = readLock();
    return !!lock && lock.owner === started.owner && Number(lock.pid) === Number(pid);
  }, 15_000, 100);

  if (!lockReady) {
    const lock = readLock();
    run.manifest.phase = 'prepare_failed';
    run.manifest.prepareError = 'lease holder did not become ready';
    run.manifest.endedAt = nowIso();
    writeManifest(run);
    await cleanupFailedHolder(run, started.owner, pid);
    print({
      ok: false,
      code: 'lease_not_ready',
      error: 'lease holder did not become ready',
      runId,
      runDir,
      holderPid: pid,
      holderLog: started.logFile,
      lease: lock,
    });
    return EXIT.FAIL;
  }

  const lock = readLock();
  const holder = {
    owner: started.owner,
    pid: Number(lock.pid),
    fencing: lock.fencing ?? currentFencing(),
    stopFile: started.stopFile,
    log: started.logFile,
    startedAt: lock.acquiredAt || nowIso(),
  };
  run.manifest.phase = 'prepared';
  run.manifest.preparedAt = nowIso();
  run.manifest.fencing = holder.fencing;
  run.manifest.holderPid = holder.pid;
  run.manifest.holder = holder;
  run.manifest.lease = {
    path: lockPath(),
    owner: holder.owner,
    pid: holder.pid,
    fencing: holder.fencing,
    kind: lock.kind || 'dev',
    expiresAt: lock.expiresAt || null,
  };
  writeManifest(run);

  const briefPath = path.join(runDir, 'OPERATOR-BRIEF.md');
  fs.writeFileSync(briefPath, briefMarkdown(run, goal), 'utf8');

  print({
    ok: true,
    runId,
    runDir,
    pilotRunDir: runDir,
    goalPath,
    manifestPath: run.manifestPath,
    operatorBrief: briefPath,
    holder,
    holderPid: holder.pid,
    fencing: holder.fencing,
    lease: run.manifest.lease,
    state: 'prepared',
    env: {
      PILOT_RUN_DIR: runDir,
      PILOT_RUNS_DIR: runsRoot(),
      PILOT_MODE_RUN_DIR: path.resolve(process.env.PILOT_MODE_RUN_DIR || path.join(ROOT, 'run')),
      PILOT_LOCK_DIR: path.dirname(lockPath()),
      PILOT_TREE_CONTROL_PORT: String(process.env.PILOT_TREE_CONTROL_PORT || 8766),
      PILOT_TREE_MCP_PORT: String(process.env.PILOT_TREE_MCP_PORT || 8767),
      PILOT_NUMEN_PORT: String(process.env.PILOT_NUMEN_PORT || 8765),
    },
    note: 'Operator subagent is the next step; no tree/game was started by devtool.',
  });
  return EXIT.OK;
}

function cmdOperatorBrief(args) {
  const runId = String(args.run || args['run-id'] || '');
  let run;
  try {
    run = loadRun(runId);
  } catch (e) {
    print({ ok: false, code: e.code || 'run_not_found', error: String(e.message || e) });
    return EXIT.FAIL;
  }
  const goal = run.manifest.goal && validateGoal(run.manifest.goal).ok ? normalizeGoal(run.manifest.goal) : null;
  if (!goal) {
    print({ ok: false, code: 'missing_goal', error: `manifest.goal missing/invalid for ${runId}` });
    return EXIT.FAIL;
  }
  const text = briefMarkdown({ ...run, topic: run.manifest.topic || '' }, goal);
  const briefPath = path.join(run.dir, 'OPERATOR-BRIEF.md');
  fs.writeFileSync(briefPath, text, 'utf8');
  process.stdout.write(text);
  return EXIT.OK;
}

async function stopHolderForRun(run) {
  const holder = run.manifest.holder || {};
  const lease = run.manifest.lease || {};
  const owner = holder.owner || lease.owner || null;
  const pid = Number(holder.pid || lease.pid || 0) || null;
  const stopFile = holder.stopFile || path.join(run.dir, '.holder-stop');
  fs.writeFileSync(stopFile, `${JSON.stringify({ at: nowIso(), reason: 'devtool-close' })}\n`, 'utf8');

  const stoppedByStopFile = pid ? await waitFor(() => !isPidAlive(pid), 10_000, 100) : null;
  let lock = readLock();
  let release = null;
  if (lock && owner && lock.owner !== owner) {
    return {
      ok: false,
      code: 'lease_not_owned',
      error: `lease owner is ${lock.owner}, expected ${owner}`,
      stoppedByStopFile,
      lock,
    };
  }
  if (lock && owner && lock.owner === owner) {
    release = await exitDev({ owner, fencing: lock.fencing, actor: 'devtool' });
  }
  const holderExited = pid ? await waitFor(() => !isPidAlive(pid), 5_000, 100) : true;

  lock = readLock();
  let offResult = null;
  if (lock && owner && lock.owner === owner) {
    offResult = await modeOff({ force: true, owner, actor: 'devtool', reason: 'devtool-close' });
    lock = readLock();
  }

  let status = await getStatus({ repair: true });
  if (!lock && status.state !== 'OFF' && !status.ports?.controlOpen && !status.ports?.mcpOpen) {
    offResult = await modeOff({ force: true, owner: owner || null, actor: 'devtool', reason: 'devtool-close' });
    status = await getStatus({ repair: true });
  }

  return {
    ok: !lock,
    stoppedByStopFile,
    holderExited,
    release,
    off: offResult,
    lockAfter: lock,
    modeState: status.state,
    leasePath: lockPath(),
  };
}

async function cmdClose(args) {
  const runId = String(args.run || args['run-id'] || '');
  let run;
  try {
    run = loadRun(runId);
  } catch (e) {
    print({ ok: false, code: e.code || 'run_not_found', error: String(e.message || e) });
    return EXIT.FAIL;
  }
  const result = await stopHolderForRun(run);
  run.manifest.phase = result.ok ? 'closed' : 'close_failed';
  run.manifest.closedAt = nowIso();
  if (result.ok) run.manifest.endedAt = nowIso();
  run.manifest.abortReason = args.reason ? String(args.reason) : (result.ok ? 'closed' : 'close_failed');
  run.manifest.close = result;
  const groundtruth = await fetchGroundtruthManifest(runId);
  if (groundtruth) run.manifest.groundtruth = groundtruth;
  writeManifest(run);

  print({
    ok: result.ok,
    runId,
    runDir: run.dir,
    ...result,
    groundtruth,
    manifestPath: run.manifestPath,
    note: 'devtool only stopped its own lease holder; no game/tree process was killed.',
  });
  return result.ok ? EXIT.OK : EXIT.FAIL;
}

async function fetchGroundtruthManifest(runId) {
  const base = (process.env.GROUNDTRUTH_BASE || 'http://127.0.0.1:8771').replace(/\/$/, '');
  const token = process.env.GROUNDTRUTH_TOKEN || '';
  if (!token) return { checked: false, reason: 'GROUNDTRUTH_TOKEN unset' };
  try {
    const res = await fetch(`${base}/dev/v1/manifest?runId=${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return { checked: false, reason: `http_${res.status}` };
    const body = await res.json();
    const m = body.manifest || {};
    const calls = Number(m.calls ?? 0);
    const clockFrozen = m.clockFrozen === true;
    return {
      checked: true,
      eligible: calls === 0 && !clockFrozen,
      calls,
      clockFrozen,
      byKind: m.byKind || {},
    };
  } catch (e) {
    return { checked: false, reason: String(e.message || e) };
  }
}

function goalFromRun(run) {
  if (run.manifest.goal && validateGoal(run.manifest.goal).ok) {
    const goal = normalizeGoal(run.manifest.goal);
    goal.raw = run.manifest.goal;
    return goal;
  }
  const md = path.join(run.dir, 'GOAL.md');
  if (!exists(md)) return null;
  const text = fs.readFileSync(md, 'utf8');
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of blocks) {
    try {
      const raw = JSON.parse(block);
      if (raw && typeof raw === 'object' && raw.goal && validateGoal(raw).ok) {
        const goal = normalizeGoal(raw);
        goal.raw = raw;
        return goal;
      }
    } catch { /* try next block */ }
  }
  return null;
}

function failureClass(code) {
  const c = String(code || '');
  if (/tool_error|action_error|invalid_action|fixture_failed|capability/i.test(c)) return 'capability';
  if (/observe_error|target_error|timeout|network|missing_|material|http_|server_not_ready/i.test(c)) return 'material';
  return 'unknown';
}

function conclusionFor(manifest, analysis) {
  if (manifest.groundtruth && manifest.groundtruth.eligible === false) {
    return `**Track A 失格**：groundtruth calls=${manifest.groundtruth.calls ?? '?'} clockFrozen=${manifest.groundtruth.clockFrozen ?? '?'}；本 run 不能作为 Track A 证据。`;
  }
  if (manifest.phase === 'prepared') {
    return '**阻塞/未收口**：run 仍处于 `prepared`，尚未 `close`；本文件只是机械初稿，不判定目标。';
  }
  if (manifest.abortReason === 'target_reached') {
    return '**可能达成**：`abortReason=target_reached`；仍需 Analyst 按 GOAL 成功谓词逐条核对，不能仅凭本行当验收证据。';
  }
  if (analysis.failures.length > 0) {
    return `**未达成/待复核**：机械分析检出 ${analysis.failures.length} 条失败/异常；分类见下，需 Analyst 判定是否 capability/material。`;
  }
  return '**待 Analyst 判定**：机械分析未检出失败，但这不等于成功谓词已满足。';
}

function segmentsMarkdown(analysis) {
  if (!analysis.segments.length) return '(no timed observations)';
  const lines = [
    '| # | start | end | duration_ms | observations | unique | repeated | errors | actions |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of analysis.segments) {
    lines.push(
      `| ${s.index} | ${s.start} | ${s.end} | ${s.durationMs} | ${s.observations} | ${s.unique} | ${s.repeated} | ${s.errors} | ${s.actions} |`,
    );
  }
  return lines.join('\n');
}

function failuresMarkdown(analysis) {
  if (!analysis.failures.length) return '(none detected; still needs Analyst review)';
  const lines = [
    '| class | source | at | code | message |',
    '|---|---|---|---|---|',
  ];
  for (const f of analysis.failures) {
    lines.push(
      `| ${failureClass(f.code)} | ${mdCell(f.source, 40)} | ${mdCell(f.at, 40)} | ${mdCell(f.code, 60)} | ${mdCell(f.message)} |`,
    );
  }
  return lines.join('\n');
}

function evidenceMarkdown(manifest, analysis, run) {
  const u = analysis.usage;
  const lines = [
    `- 机械摘要：${analysis.summary}`,
    `- steps=${u.steps} tokens=${u.tokens} llmCalls=${u.llmCalls} repeated=${u.repeatedObservations}（${u.repeatedRate}）`,
    `- abortReason=${manifest.abortReason ?? 'none'} · phase=${manifest.phase ?? 'unknown'} · runUnchanged=${analysis.readOnly.runUnchanged}`,
  ];
  if (analysis.consoleFindings.length) {
    lines.push('- console 提示（advisory，最多 5 条）：');
    for (const line of analysis.consoleFindings.slice(0, 5)) lines.push(`  - ${mdCell(line, 180)}`);
  }
  const missing = Object.entries(analysis.files).filter(([, v]) => v.missing).map(([k]) => k);
  if (missing.length) lines.push(`- 缺失文件：${missing.join(', ')}`);
  if (manifest.groundtruth) {
    const g = manifest.groundtruth;
    lines.push(`- groundtruth：checked=${g.checked} eligible=${g.eligible ?? 'unknown'} calls=${g.calls ?? '?'} clockFrozen=${g.clockFrozen ?? '?'}${g.reason ? ` reason=${g.reason}` : ''}`);
  }
  lines.push(`- 原始日志：\`${run.dir}\`；分析：\`${analysis.source.archiveDir}\``);
  return lines.join('\n');
}

function gmTentacleMarkdown(analysis) {
  const g = analysis.gm;
  const t = analysis.tentacle;
  return [
    `- GM：used=${g.used} entries=${g.count} assisted=${g.assistedCount} failures=${g.failCount} reasons=${g.reasons.join(', ') || '(none)'}；manifest assisted=${g.runMarkedAssisted}`,
    `- 触手：used=${t.used} entries=${t.count} failures=${t.failCount} nonAuthoritative=${t.nonAuthoritative} purposes=${t.purposes.join(', ') || '(none)'}`,
    '- 口径：GM/触手都不进验收/学习；GM 必须在 GOAL 明确允许时使用并标 assisted。',
  ].join('\n');
}

function questionsMarkdown(manifest, analysis, goal) {
  const qs = [];
  if (analysis.failures.length) {
    qs.push('这些失败应归为 capability、material 还是 unknown？哪一条最关键？');
  } else {
    qs.push(`成功谓词是否已被证据覆盖：${goal.success.slice(0, 2).join('；') || '(GOAL 未列)'}？`);
  }
  if (analysis.segments.length <= 1 || analysis.usage.repeatedRate > 0.5) {
    qs.push('分段不足或重复观测偏高：是测试设计问题、工具问题，还是场景本身没有新信息？');
  } else {
    qs.push('分段行为是否与预期阶段一致？有没有“看起来完成但实际未验证”的步骤？');
  }
  qs.push('下一步最小可证伪实验是什么？需要补哪类日志/观测？');
  return qs.slice(0, 3).map((q, i) => `${i + 1}. ${q}`).join('\n');
}

function packMarkdown(run, manifest, goal, analysis, outputFiles) {
  const goalPath = path.join(run.dir, 'GOAL.md');
  const paths = [
    `- run: \`${run.dir}\``,
    `- GOAL: \`${goalPath}\``,
    `- manifest: \`${run.manifestPath}\``,
    `- analysis.md: \`${outputFiles.md}\``,
    `- analysis.json: \`${outputFiles.json}\``,
    `- roundtable-pack: \`${path.join(analysis.source.archiveDir, 'roundtable-pack.md')}\``,
    `- actions: \`${path.join(run.dir, 'actions.jsonl')}\``,
    `- observations: \`${path.join(run.dir, 'observations.jsonl')}\``,
  ].join('\n');
  return renderTemplate(template('roundtable-pack.md'), {
    runId: run.runId,
    goal: goal.goal,
    budget: typeof goal.budget === 'string' ? goal.budget : JSON.stringify(goal.budget),
    mode: manifest.mode || 'devtool',
    phase: manifest.phase || 'unknown',
    abortReason: manifest.abortReason ?? 'none',
    goalPath,
    manifestPath: run.manifestPath,
    conclusion: conclusionFor(manifest, analysis),
    segments: segmentsMarkdown(analysis),
    failures: failuresMarkdown(analysis),
    evidence: evidenceMarkdown(manifest, analysis, run),
    gmTentacle: gmTentacleMarkdown(analysis),
    questions: questionsMarkdown(manifest, analysis, goal),
    paths,
  });
}

function cmdAnalyze(args) {
  const runId = String(args.run || args['run-id'] || '');
  let run;
  try {
    run = loadRun(runId);
  } catch (e) {
    print({ ok: false, code: e.code || 'run_not_found', error: String(e.message || e) });
    return EXIT.FAIL;
  }
  const goal = goalFromRun(run);
  if (!goal) {
    print({ ok: false, code: 'missing_goal', error: `GOAL/manifest.goal missing or invalid for ${runId}` });
    return EXIT.FAIL;
  }

  let result;
  try {
    result = analyzeRun({ run: run.dir, archiveRoot: archiveRoot() });
  } catch (e) {
    print({ ok: false, code: e.code || 'analysis_failed', error: String(e.message || e) });
    return EXIT.FAIL;
  }

  const packPath = path.join(result.archiveDir, 'roundtable-pack.md');
  fs.writeFileSync(packPath, packMarkdown(run, run.manifest, goal, result.analysis, result.files), 'utf8');

  console.log(`analysis: ${result.files.md}`);
  console.log(`json: ${result.files.json}`);
  console.log(`pack: ${packPath}`);
  console.log(`summary: ${result.summary}`);
  return EXIT.OK;
}

async function cmdStatus(args) {
  const runId = String(args.run || args['run-id'] || '');
  let run;
  try {
    run = loadRun(runId);
  } catch (e) {
    print({ ok: false, code: e.code || 'run_not_found', error: String(e.message || e) });
    return EXIT.FAIL;
  }
  const status = await getStatus({ repair: true });
  const lock = readLock();
  const holder = run.manifest.holder || {};
  const holderPid = Number(holder.pid || lock?.pid || 0) || null;
  const goal = goalFromRun(run);
  const analysisDir = path.join(archiveRoot(), runId);
  print({
    ok: true,
    runId,
    runDir: run.dir,
    phase: run.manifest.phase || null,
    topic: run.manifest.topic || null,
    goal: goal ? { valid: true, goal: goal.goal, budget: goal.budget } : { valid: false },
    mode: {
      state: status.state,
      declared: status.declared,
      ports: status.ports,
    },
    lease: lock
      ? {
          present: true,
          owner: lock.owner,
          pid: lock.pid,
          pidAlive: isPidAlive(lock.pid),
          fencing: lock.fencing,
          kind: lock.kind,
          expiresAt: lock.expiresAt,
          mine: holder.owner ? lock.owner === holder.owner : false,
        }
      : { present: false },
    holder: holder.owner
      ? { owner: holder.owner, pid: holder.pid, alive: isPidAlive(holderPid), fencing: holder.fencing }
      : null,
    paths: {
      goal: path.join(run.dir, 'GOAL.md'),
      manifest: run.manifestPath,
      brief: path.join(run.dir, 'OPERATOR-BRIEF.md'),
      holderLog: holder.log || path.join(run.dir, 'holder.log'),
      actions: path.join(run.dir, 'actions.jsonl'),
      observations: path.join(run.dir, 'observations.jsonl'),
      gm: path.join(run.dir, 'gm.jsonl'),
      tentacle: path.join(run.dir, 'tentacle_use.jsonl'),
      analysisDir,
      analysisMd: path.join(analysisDir, 'analysis.md'),
      pack: path.join(analysisDir, 'roundtable-pack.md'),
    },
    fencing: currentFencing(),
  });
  return EXIT.OK;
}

function usage() {
  process.stderr.write(`usage:
  node tools/devtool.mjs prepare --goal=<goal.json|inline-json> [--run-id=] [--topic=]
  node tools/devtool.mjs operator-brief --run=<id>
  node tools/devtool.mjs close --run=<id> [--reason=]
  node tools/devtool.mjs analyze --run=<id>
  node tools/devtool.mjs status --run=<id>

Pipeline: prepare -> Operator subagent -> close -> analyze -> roundtable-pack.md
No tree/game is started; no taskkill; GM/LLM are not implemented here.
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    return EXIT.USAGE;
  }
  if (cmd === 'prepare') return cmdPrepare(args);
  if (cmd === 'operator-brief') return cmdOperatorBrief(args);
  if (cmd === 'close') return cmdClose(args);
  if (cmd === 'analyze') return cmdAnalyze(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  return EXIT.USAGE;
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      print({ ok: false, code: e.code || 'fatal', error: String(e?.message || e) });
      process.exitCode = EXIT.FAIL;
    });
}

export {
  GOAL_KEYS,
  VERSION,
  validateGoal,
  normalizeGoal,
  runsRoot,
  archiveRoot,
};
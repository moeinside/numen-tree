#!/usr/bin/env node
/**
 * P0 行为切片：把两夜实录压成“可读的行为片段”，给行为学家评审用。
 * 不倾倒原始采样；按 day/phase/plan 变化/事件切段。
 *
 * 用法：
 *   node probe/p0/behavior-slices.mjs --file=logs/p0-natural-numen-test.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const file = arg.file
  ? path.resolve(arg.file)
  : (() => {
      const dir = path.resolve('logs');
      const files = fs.readdirSync(dir).filter((n) => /^p0-.*\.jsonl$/.test(n));
      files.sort();
      return files.length ? path.join(dir, files[files.length - 1]) : null;
    })();
if (!file || !fs.existsSync(file)) {
  console.error('找不到实录文件；先跑 probe/p0/run-recorder.mjs');
  process.exit(2);
}
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const samples = rows.filter((r) => r.kind === 'sample');
if (!samples.length) {
  console.error('实录里没有 sample');
  process.exit(2);
}

function phaseOf(s) {
  return s.phase ?? 'unknown';
}
function planKey(s) {
  return s.plan?.recipeId ?? 'idle';
}

const slices = [];
let cur = null;
function open(s) {
  cur = {
    id: slices.length + 1,
    day: s.day,
    phase: phaseOf(s),
    start: s.at,
    end: s.at,
    samples: 0,
    plans: [],
    intents: [],
    actions: [],
    events: [],
    hpMin: s.hp,
    hungerMin: s.hunger,
  };
  slices.push(cur);
}
function close(s) {
  if (!cur) return;
  cur.end = s?.at ?? cur.end;
}
function addPlan(s) {
  if (!cur) return;
  const k = planKey(s);
  if (!cur.plans.includes(k)) cur.plans.push(k);
}
function addIntent(s) {
  if (!cur) return;
  if (s.intent && !cur.intents.includes(s.intent)) cur.intents.push(s.intent);
}
function addAction(s) {
  if (!cur || !s.lastAction) return;
  const k = `${s.lastAction.skill}:${s.lastAction.ok ? 'ok' : s.lastAction.kind}`;
  if (!cur.actions.includes(k)) cur.actions.push(k);
}

for (const s of samples) {
  const boundary =
    !cur ||
    cur.day !== s.day ||
    cur.phase !== phaseOf(s) ||
    planKey(s) !== (cur.plans.at(-1) ?? 'idle') && cur.plans.length > 0;
  if (boundary) {
    close(s);
    open(s);
  }
  cur.samples += 1;
  cur.end = s.at;
  cur.hpMin = Math.min(cur.hpMin, s.hp ?? 20);
  cur.hungerMin = Math.min(cur.hungerMin, s.hunger ?? 20);
  addPlan(s);
  addIntent(s);
  addAction(s);
}
close(samples.at(-1));

for (const r of rows) {
  if (r.kind === 'sample') continue;
  if (slices.length) {
    const last = slices[slices.length - 1];
    last.events.push(r.kind);
  }
}

const report = {
  file,
  generatedAt: new Date().toISOString(),
  samples: samples.length,
  days: [...new Set(samples.map((s) => s.day).filter((x) => x != null))],
  phases: [...new Set(samples.map(phaseOf))],
  deaths: rows.filter((r) => r.kind === 'death').map((r) => r.deathAt),
  slices,
  planSequence: [...new Set(samples.map((s) => s.plan?.recipeId).filter(Boolean))],
  help: [...new Set(samples.map((s) => s.helpNeeded?.kind).filter(Boolean))],
};
console.log(JSON.stringify(report, null, 2));

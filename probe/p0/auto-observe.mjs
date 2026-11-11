#!/usr/bin/env node
/**
 * P0 自动观察器：
 *  - 只读轮询树 /status；
 *  - 写 JSONL 实录；
 *  - 到点自动生成 report + behavior slices（无需再手动跑）。
 *
 * 用法：
 *   node probe/p0/auto-observe.mjs --hours=0.5 --name=day1
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const hours = Number(arg.hours ?? 0.5);
const name = String(arg.name ?? `obs-${Date.now()}`);
const base = path.resolve('logs', `p0-${name}`);
const jsonlFile = `${base}.jsonl`;
const reportFile = `${base}-report.json`;
const slicesFile = `${base}-slices.json`;
const mdFile = `${base}-report.md`;
fs.mkdirSync(path.dirname(base), { recursive: true });
const stream = fs.createWriteStream(jsonlFile, { flags: 'a' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = Date.now();
const endAt = start + hours * 3600_000;
const rows = [];
const seen = { day: null, night: false, plans: new Set() };

function write(obj) {
  rows.push(obj);
  stream.write(`${JSON.stringify(obj)}\n`);
}

console.log(`P0 auto-observe → ${jsonlFile}（${hours}h）`);
write({ at: new Date().toISOString(), kind: 'start', name, hours });

while (Date.now() < endAt) {
  let s;
  try {
    const res = await fetch('http://127.0.0.1:8766/status', { signal: AbortSignal.timeout(3000) });
    s = await res.json();
  } catch (e) {
    write({ at: new Date().toISOString(), kind: 'status_error', error: String(e?.message ?? e) });
    await sleep(3000);
    continue;
  }
  const c = s.companions?.[0];
  if (!c) {
    write({ at: new Date().toISOString(), kind: 'no_companion' });
    await sleep(3000);
    continue;
  }
  const gameTime = Number(c.gameTime ?? 0);
  const day = gameTime ? Math.floor(gameTime / 24000) : null;
  const phase = c.timePhase ?? null;
  const night = phase === 'night' || phase === 'midnight' || phase === 'dusk';
  if (day != null && seen.day != null && day > seen.day) {
    write({ at: new Date().toISOString(), kind: 'day_change', from: seen.day, to: day });
  }
  if (night && !seen.night) write({ at: new Date().toISOString(), kind: 'night_start', day, phase });
  if (!night && seen.night) write({ at: new Date().toISOString(), kind: 'night_end', day, phase });
  seen.day = day ?? seen.day;
  seen.night = night;

  const plan = c.plan ? { recipeId: c.plan.recipeId, cursor: c.plan.cursor, status: c.plan.status } : null;
  if (plan?.recipeId && !seen.plans.has(plan.recipeId)) {
    seen.plans.add(plan.recipeId);
    write({ at: new Date().toISOString(), kind: 'plan_seen', plan });
  }
  if (c.deathAt) write({ at: new Date().toISOString(), kind: 'death', deathAt: c.deathAt });

  write({
    at: new Date().toISOString(),
    kind: 'sample',
    gameTime,
    day,
    phase,
    hp: c.hp,
    hunger: c.hunger,
    food: c.foodCount,
    pos: c.pos,
    plan,
    intent: c.intentState?.current?.need ?? c.intentState?.current?.intent ?? null,
    performanceFactor: c.performanceFactor ?? null,
    helpNeeded: c.helpNeeded ?? null,
    lastAction: c.lastAction ?? null,
  });
  await sleep(2000);
}

write({ at: new Date().toISOString(), kind: 'stop', elapsedMs: Date.now() - start });
stream.end();

// 自动 report
const samples = rows.filter((r) => r.kind === 'sample');
const avg = (arr) => {
  const nums = arr.map(Number).filter(Number.isFinite);
  return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)) : null;
};
const report = {
  name,
  file: jsonlFile,
  generatedAt: new Date().toISOString(),
  durationSeconds: Math.round((Date.now() - start) / 1000),
  samples: samples.length,
  days: [...new Set(samples.map((s) => s.day).filter((x) => x != null))],
  phases: [...new Set(samples.map((s) => s.phase).filter(Boolean))],
  nightStarts: rows.filter((r) => r.kind === 'night_start').length,
  nightEnds: rows.filter((r) => r.kind === 'night_end').length,
  deaths: rows.filter((r) => r.kind === 'death').map((r) => r.deathAt),
  plansSeen: [...new Set(rows.filter((r) => r.kind === 'plan_seen').map((r) => r.plan?.recipeId).filter(Boolean))],
  help: [...new Set(samples.map((s) => s.helpNeeded?.kind).filter(Boolean))],
  avgHp: avg(samples.map((s) => s.hp)),
  avgHunger: avg(samples.map((s) => s.hunger)),
  avgPerformance: avg(samples.map((s) => s.performanceFactor).filter((x) => x != null)),
  minHp: samples.length ? Math.min(...samples.map((s) => Number(s.hp) || 0)) : null,
  last: samples.at(-1) ?? null,
};

// 自动 slices（按 day/phase/plan 段）
const slices = [];
let cur = null;
for (const s of samples) {
  const key = `${s.day}|${s.phase}|${s.plan?.recipeId ?? 'idle'}`;
  if (!cur || cur.key !== key) {
    if (cur) slices.push(cur);
    cur = { key, day: s.day, phase: s.phase, plan: s.plan?.recipeId ?? 'idle', start: s.at, end: s.at, samples: 0, hpMin: s.hp, hungerMin: s.hunger, actions: [] };
  }
  cur.samples += 1;
  cur.end = s.at;
  cur.hpMin = Math.min(cur.hpMin, s.hp ?? 20);
  cur.hungerMin = Math.min(cur.hungerMin, s.hunger ?? 20);
  const a = s.lastAction ? `${s.lastAction.skill}:${s.lastAction.ok ? 'ok' : s.lastAction.kind}` : null;
  if (a && !cur.actions.includes(a)) cur.actions.push(a);
}
if (cur) slices.push(cur);

fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
fs.writeFileSync(slicesFile, JSON.stringify({ name, generatedAt: report.generatedAt, slices }, null, 2), 'utf8');
fs.writeFileSync(
  mdFile,
  [
    `# P0 observation: ${name}`,
    '',
    `- file: ${jsonlFile}`,
    `- samples: ${report.samples}`,
    `- days: ${report.days.join(', ')}`,
    `- nights: ${report.nightStarts} start / ${report.nightEnds} end`,
    `- deaths: ${report.deaths.length}`,
    `- plans: ${report.plansSeen.join(', ')}`,
    `- avgHp/Hunger: ${report.avgHp} / ${report.avgHunger}`,
    `- minHp: ${report.minHp}`,
    `- avgPerformance: ${report.avgPerformance}`,
    `- help: ${report.help.join(', ') || 'none'}`,
    '',
    '## slices',
    ...slices.map((s) => `- day ${s.day} ${s.phase} ${s.plan} (${s.samples} samples, hpMin=${s.hpMin}, hungerMin=${s.hungerMin})`),
  ].join('\n'),
  'utf8',
);

console.log(`report: ${reportFile}`);
console.log(`slices: ${slicesFile}`);
console.log(`md: ${mdFile}`);

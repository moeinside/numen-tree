#!/usr/bin/env node
/**
 * P0 实录报告：读 logs/p0-live-*.jsonl，输出可机读摘要。
 * 只读，不改树/游戏。
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
      const files = fs.readdirSync(dir).filter((n) => /^p0-live-.*\.jsonl$/.test(n));
      files.sort();
      return files.length ? path.join(dir, files[files.length - 1]) : null;
    })();
if (!file || !fs.existsSync(file)) {
  console.error('找不到 p0-live-*.jsonl；先跑 probe/p0/run-recorder.mjs');
  process.exit(2);
}

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const samples = rows.filter((r) => r.kind === 'sample');
const report = {
  file,
  generatedAt: new Date().toISOString(),
  samples: samples.length,
  days: [...new Set(samples.map((s) => s.day).filter((x) => x != null))],
  nightStarts: rows.filter((r) => r.kind === 'night_start').length,
  nightEnds: rows.filter((r) => r.kind === 'night_end').length,
  deaths: rows.filter((r) => r.kind === 'death').map((r) => r.deathAt),
  plansSeen: [...new Set(rows.filter((r) => r.kind === 'plan_seen').map((r) => r.plan?.recipeId).filter(Boolean))],
  help: [...new Set(samples.map((s) => s.helpNeeded?.kind).filter(Boolean))],
  avgHp: average(samples.map((s) => s.hp)),
  avgHunger: average(samples.map((s) => s.hunger)),
  avgPerformance: average(samples.map((s) => s.performanceFactor).filter((x) => x != null)),
  nightOutdoorSamples: samples.filter(
    (s) => (s.phase === 'night' || s.phase === 'midnight') && s.pos && s.pos.y != null,
  ).length,
  last: samples.at(-1) ?? null,
};

function average(arr) {
  const nums = arr.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
}

console.log(JSON.stringify(report, null, 2));

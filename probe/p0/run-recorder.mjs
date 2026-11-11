#!/usr/bin/env node
/**
 * P0 真实运行记录器（只读）：
 *  - 轮询树 /status；
 *  - 记录 gameTime/day/night、HP/饥饿/位置、计划、intent、resume/失败/GoalStore 状态；
 *  - 检测死亡、夜间隔、resume 抖动；
 *  - 不控制树/游戏。
 *
 * 用法：node probe/p0/run-recorder.mjs --hours=2 [--out=logs/p0-live.jsonl]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const hours = Number(args.hours ?? 2);
const outFile = path.resolve(args.out ?? `logs/p0-live-${new Date().toISOString().slice(0, 10)}.jsonl`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const stream = fs.createWriteStream(outFile, { flags: 'a' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = { day: null, night: false, death: 0, resumes: 0, suspended: 0, plans: new Set() };
const start = Date.now();
const endAt = start + hours * 3600_000;

function line(obj) {
  stream.write(`${JSON.stringify(obj)}\n`);
}

console.log(`P0 recorder → ${outFile}（${hours}h，只读）`);
line({ at: new Date().toISOString(), kind: 'recorder_start', outFile, hours });

while (Date.now() < endAt) {
  let s;
  try {
    const res = await fetch('http://127.0.0.1:8766/status', { signal: AbortSignal.timeout(3000) });
    s = await res.json();
  } catch (e) {
    line({ at: new Date().toISOString(), kind: 'status_error', error: String(e?.message ?? e) });
    await sleep(3000);
    continue;
  }
  const c = s.companions?.[0];
  if (!c) {
    line({ at: new Date().toISOString(), kind: 'no_companion' });
    await sleep(3000);
    continue;
  }
  const gameTime = Number(c.gameTime ?? 0);
  const day = gameTime ? Math.floor(gameTime / 24000) : null;
  const phase = c.timePhase ?? null;
  const night = phase === 'night' || phase === 'midnight' || phase === 'dusk';
  if (day != null && seen.day != null && day > seen.day) {
    line({ at: new Date().toISOString(), kind: 'day_change', from: seen.day, to: day });
  }
  if (night && !seen.night) {
    line({ at: new Date().toISOString(), kind: 'night_start', day, phase });
  }
  if (!night && seen.night) {
    line({ at: new Date().toISOString(), kind: 'night_end', day, phase });
  }
  seen.day = day ?? seen.day;
  seen.night = night;

  const plan = c.plan ? { recipeId: c.plan.recipeId, cursor: c.plan.cursor, status: c.plan.status } : null;
  if (plan?.recipeId && !seen.plans.has(plan.recipeId)) {
    seen.plans.add(plan.recipeId);
    line({ at: new Date().toISOString(), kind: 'plan_seen', plan });
  }
  if (c.deathAt && c.deathAt !== seen.death) {
    seen.death = c.deathAt;
    line({ at: new Date().toISOString(), kind: 'death', deathAt: c.deathAt });
  }
  const intent = c.intentState?.current?.need ?? c.intentState?.current?.intent ?? null;
  line({
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
    intent,
    performanceFactor: c.performanceFactor ?? null,
    helpNeeded: c.helpNeeded ?? null,
    goalStore: { activeDay: c.readinessAuditDay ?? null },
    lastAction: c.lastAction ?? null,
  });
  await sleep(2000);
}

line({ at: new Date().toISOString(), kind: 'recorder_stop', elapsedMs: Date.now() - start });
stream.end();
console.log(`P0 recorder stopped（${outFile}）`);

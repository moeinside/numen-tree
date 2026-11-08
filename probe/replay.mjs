#!/usr/bin/env node
/**
 * numen-tree 离线回放测试（M1）
 *
 * 用打桩的 numen 驱动**真实的 Lane**，不开游戏、不连 MCP、不写 logs/、
 * 不碰真实 places.json / world.json（一律用 $TEMP 下的临时文件，跑完删除），
 * 回归 M1 的：仲裁（自动开计划）/ 计划推进 / 中断抢占 / 上报预算 / 状态字段。
 *
 * 用法：
 *   node probe/replay.mjs                 跑全部 9 个场景
 *   node probe/replay.mjs --only=hungry   只跑某个（可逗号分隔多个）
 *   node probe/replay.mjs --list          列出场景
 *
 * 加新场景：见 probe/replay-notes.md / probe/fixtures/*.mjs。
 *
 * 边界（不要破坏）：
 *  - 这里只"驱动 + 断言"，不复制 Lane/Plan 的业务逻辑；
 *  - 场景数据都在 probe/fixtures/*.mjs，加场景不改这个文件（除了 import 列表）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { CompanionState, Inbox } from '../src/state.mjs';
import { Lane } from '../src/lane.mjs';
import { Planner } from '../src/plan.mjs';
import { RECIPES } from '../src/recipes.mjs';
import { PlaceBook } from '../src/places.mjs';
import { WorldMemory } from '../src/worldmem.mjs';
import { loadSkills } from '../src/skills/index.mjs';

import { obs } from './fixtures/_common.mjs';
import hungry from './fixtures/hungry.mjs';
import eatFirst from './fixtures/eat_first.mjs';
import lowHp from './fixtures/low_hp.mjs';
import night from './fixtures/night.mjs';
import nightGuard from './fixtures/night_guard.mjs';
import dayWork from './fixtures/day_work.mjs';
import autoWorkFail from './fixtures/auto_work_fail.mjs';
import taskEvents from './fixtures/task_events.mjs';
import lockRecover from './fixtures/lock_recover.mjs';
import bootstrapKit from './fixtures/bootstrap_kit.mjs';
import toolKit from './fixtures/tool_kit.mjs';
import reuseTable from './fixtures/reuse_table.mjs';
import steerYield from './fixtures/steer_yield.mjs';
import tacticLane from './fixtures/tactic_lane.mjs';
import tacticPreempt from './fixtures/tactic_preempt.mjs';
import instinctYield from './fixtures/instinct_yield.mjs';
import execMode from './fixtures/exec_mode.mjs';
import stuck from './fixtures/stuck.mjs';
import death from './fixtures/death.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const FIXTURES = [hungry, eatFirst, lowHp, night, nightGuard, dayWork, autoWorkFail, taskEvents, lockRecover, bootstrapKit, toolKit, reuseTable, steerYield, tacticLane, tacticPreempt, instinctYield, execMode, stuck, death];
const DEFAULT_TICK_MS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

/** 内存 trace：只收集，不落盘（绝不写 logs/）。 */
class MemoryTrace {
  constructor() {
    this.entries = [];
  }

  #push(level, kind, data = {}) {
    this.entries.push({ level, kind, ...data });
  }

  info(kind, data) {
    this.#push('info', kind, data);
  }

  warn(kind, data) {
    this.#push('warn', kind, data);
  }

  error(kind, data) {
    this.#push('error', kind, data);
  }

  of(kind) {
    return this.entries.filter((e) => e.kind === kind);
  }

  kinds() {
    return this.entries.map((e) => e.kind);
  }
}

/**
 * 按 **Lua 代码特征** 识别技能（不依赖调用方传进来的参数/顺序）。
 * 顺序很重要：先认观测，再认独占特征，最后认通用特征。
 */
export function classifyLua(code) {
  const c = String(code ?? '');
  // 技能自报标记（新增技能卡时优先用它，避免误判）
  const marker = c.match(/-- skill: ([a-z_]+)/);
  if (marker) return marker[1];
  // 快观测：只有危险字段（有 dark + hostile_n，没有 animal_n）
  if (c.includes('hostile_n') && c.includes('"dark"') && !c.includes('animal_n')) return 'observe_fast';
  if (c.includes('animal_n') && c.includes('numen.status.self')) return 'observe';
  if (c.includes('numen.inv.make')) return 'craft';
  if (c.includes('numen.gear.hold')) return 'equip';
  if (c.includes('numen.inv.smelt')) return 'smelt';
  if (c.includes('numen.work.mine') || c.includes('numen.scan.cluster')) return 'mine_nearby';
  if (c.includes('numen.work.dig')) return 'dig_nearby';
  if (c.includes('numen.inv.eat')) return 'eat';
  if (c.includes('numen.move.explore') && c.includes('numen.use.block')) return 'seek_food';
  if (c.includes('numen.move.explore')) return 'explore';
  if (c.includes('numen.scan.blocks') && c.includes('numen.use.block')) return 'store_items';
  // 只读扫描：找已有方块（不放置）；scan_ground 用单数 scan.block
  if (c.includes('numen.scan.blocks') && !c.includes('numen.use.block')) return 'find_block';
  if (c.includes('numen.scan.block(')) return 'scan_ground';
  if (c.includes('numen.work.dig')) return 'dig_nearby';
  if (c.includes('numen.fight.attack')) {
    if (c.includes('gave_up')) return 'fight_safe';
    if (c.includes('hp_before')) return 'fight_nearest';
    return 'forage';
  }
  // 捡东西（放在 forage 之后：forage 也会调 work.collect 捡肉）
  if (c.includes('numen.work.collect')) return 'collect_items';
  // go_to 现在走"分几段数到目标"的 waypoint 循环（有 distTo，用 move.to，不再用 route.plan）
  if (c.includes('distTo') && c.includes('numen.move.to')) return 'go_to';
  if (c.includes('numen.route.plan') || c.includes('numen.move.go')) return 'go_to';
  if (c.includes('numen.move.flee')) return 'retreat';
  if (c.includes('numen.move.follow')) return 'follow_owner';
  if (c.includes('numen.time.wait')) return 'idle';
  return 'unknown';
}

/** 打桩的 numen 动作客户端：观测 / 技能结果全部来自 fixture。 */
class FakeNumen {
  sessionGeneration = 1;

  constructor(ctx) {
    this.ctx = ctx;
    this.skillCounts = {};
    this.observeCount = 0;
  }

  async listCompanions() {
    return { companions: [{ name: this.ctx.state.name, id: this.ctx.state.id }], text: '' };
  }

  async say() {
    return '';
  }

  async lua(companion, code, timeoutMs) {
    const ctx = this.ctx;
    // 战术包 fixture 可以直接拦截原始 Lua 代码并给回执（原子没有对应的"技能名"可分类）
    const rawHook = ctx.fixture?.luaResult;
    if (typeof rawHook === 'function') {
      const got = rawHook(ctx, code, this);
      if (got) {
        ctx.luaCalls.push({ companion, skill: got.skill ?? 'atom', observe: false, timeoutMs });
        return got.result ?? got;
      }
    }
    const skill = classifyLua(code);
    const isObs = skill === 'observe' || skill === 'observe_fast';
    const call = { companion, skill, observe: isObs, timeoutMs };

    if (skill === 'observe' || skill === 'observe_fast') {
      // fixture 可以强制观测返回"错误信封"（例如模拟僵尸锁："a program is already running..."）
      const forced = ctx.fixture?.observeError?.(ctx, skill);
      if (forced) {
        call.observation = forced;
        ctx.luaCalls.push(call);
        return { ...forced };
      }
      // 快观测不消费 fixture 的观测脚本；第一条慢观测之前先返回 null（树会跳过）。
      let value;
      if (skill === 'observe_fast') {
        value = this.lastObservation ?? null;
      } else {
        value = ctx.nextObservation();
        this.lastObservation = value;
      }
      call.observation = value;
      ctx.luaCalls.push(call);
      return { kind: 'returned', value: JSON.stringify(value) };
    }

    const callIndex = this.skillCounts[skill] ?? 0;
    this.skillCounts[skill] = callIndex + 1;
    const spec = ctx.resolveSkillResult(skill, callIndex);
    call.callIndex = callIndex;
    call.result = spec;
    ctx.luaCalls.push(call);
    if (skill === 'unknown') {
      ctx.trace.warn('replay_unknown_skill', { note: String(code).slice(0, 160) });
    }

    // 允许 fixture 直接给"回执信封"（槽被占 / 超时 / 分离任务），其余当技能 JSON。
    if (spec && typeof spec === 'object' && 'kind' in spec && !('ok' in spec)) {
      return { ...spec, raw: spec.raw ?? spec.message ?? '' };
    }
    return { kind: 'returned', value: JSON.stringify(spec ?? { ok: 1 }) };
  }
}

/** 打桩的事件客户端：events() 第一轮给 fixture.events，之后给空。 */
class FakeEvents {
  constructor(ctx) {
    this.ctx = ctx;
    this.sent = false;
    this.callCount = 0;
  }

  async events() {
    this.callCount += 1;
    const fx = this.ctx.fixture;
    const ready =
      !this.sent &&
      (typeof fx.eventsWhen === 'function' ? fx.eventsWhen(this.ctx) : true) &&
      (fx.events?.length ?? 0) > 0;
    if (ready) {
      this.sent = true;
      return { events: fx.events };
    }
    await sleep(20); // 避免空转
    return { events: [] };
  }
}

/** 建驱动上下文：ctx 是 fixture 能看到的全部"世界 + 树"。 */
function makeCtx({ fixture, state, cfg, trace, inbox, places, worldmem, planner, tmpDir }) {
  const ctx = {
    fixture,
    state,
    cfg,
    trace,
    inbox,
    places,
    worldmem,
    planner,
    tmpDir,
    lane: null,
    numen: null,
    events: null,
    obsQueue: [...(fixture.observations ?? [])],
    observeCount: 0,
    lastObservation: obs(),
    luaCalls: [],
    ticks: 0,
    evidence: {},
    hookError: null,
  };

  ctx.traceOf = (kind) => trace.of(kind);
  ctx.inboxOf = (kind) => inbox.items.filter((i) => i.kind === kind);
  ctx.inboxHas = (kind) => ctx.inboxOf(kind).length > 0;
  ctx.skills = () => ctx.luaCalls.filter((c) => !c.observe).map((c) => c.skill);
  ctx.countSkill = (skill) => ctx.skills().filter((s) => s === skill).length;
  ctx.plan = () => state.planHistory?.[0] ?? null;

  ctx.nextObservation = () => {
    const n = ctx.observeCount;
    ctx.observeCount += 1;
    let value;
    if (typeof fixture.observation === 'function') {
      value = fixture.observation(ctx, n);
    } else {
      value = ctx.obsQueue.shift();
    }
    if (!value) value = ctx.lastObservation ?? obs();
    ctx.lastObservation = value;
    return value;
  };

  ctx.resolveSkillResult = (skill, callIndex) => {
    const spec = fixture.results;
    let r;
    if (typeof spec === 'function') r = spec(ctx, skill, callIndex);
    else if (spec && typeof spec === 'object') r = spec[skill];
    if (r === undefined) r = { ok: 1 };
    if (typeof r === 'function') r = r(ctx, skill, callIndex);
    return r;
  };

  return ctx;
}

function mergeInto(target, over) {
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      mergeInto(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

/**
 * 跑一个场景。返回 { id, title, ok, checks, ticks, ms, error }。
 * 失败不抛：把原因变成一条失败断言，最后统一汇总。
 */
async function runFixture(fixture, baseCfg) {
  const startedAt = nowMs();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `numen-replay-${fixture.id}-`));
  const result = { id: fixture.id, title: fixture.title, ok: false, checks: [], ticks: 0, ms: 0, error: null };
  let lane = null;
  let ctx = null;

  try {
    // ── 配置：tick 调小、文件全部指到临时目录 ─────────────────────────
    const cfg = structuredClone(baseCfg);
    cfg.loop.tickMs = DEFAULT_TICK_MS;
    cfg.loop.eventWaitSeconds = 0.05;
    cfg.loop.eventBackoffMs = 10;
    cfg.loop.actionTimeoutMs = 5000;
    // 回放里墙钟很慢（每 tick 8ms），把观测间隔压到 1ms 让每个 tick 都观测，
    // 否则观测的 3.6s 节流会让断言依赖真实耗时 → 场景时快时慢（曾出现 low_hp 偶发失败）。
    cfg.loop.observeFastMs = 1;
    cfg.loop.observeSlowMs = 1;
    cfg.lines.enabled = false;
    cfg.places.file = path.join(tmpDir, 'places.json');
    cfg.worldmem.file = path.join(tmpDir, 'world.json');
    if (fixture.cfg) mergeInto(cfg, fixture.cfg);

    // ── 真实组件 ───────────────────────────────────────────────────
    const state = new CompanionState({ name: 'tyrander', id: 'test-id' });
    const trace = new MemoryTrace();
    const inbox = new Inbox();
    const places = new PlaceBook({ file: cfg.places.file, trace, maxEntries: 50 }).load();
    const worldmem = new WorldMemory({
      file: cfg.worldmem.file,
      trace,
      maxContainers: 10,
      maxResources: 10,
    }).load();
    const planner = new Planner({ recipes: RECIPES, trace });
    const lines = { enabled: false, pick: () => null };

    ctx = makeCtx({ fixture, state, cfg, trace, inbox, places, worldmem, planner, tmpDir });
    const numen = new FakeNumen(ctx);
    const eventsClient = new FakeEvents(ctx);
    ctx.numen = numen;
    ctx.eventsClient = eventsClient;
    // fixture 可注入假的补丁客户端（测"外部清锁"路径，不连 8768）
    const lockfix = typeof fixture.lockfix === 'function' ? fixture.lockfix(ctx) : null;
    ctx.lockfix = lockfix;

    lane = new Lane({
      state,
      numen,
      eventsClient,
      trace,
      inbox,
      cfg,
      lines,
      places,
      planner,
      worldmem,
      lockfix,
    });
    ctx.lane = lane;

    // 地点簿种子（fixture 里声明的固定地点）
    for (const p of fixture.places ?? []) places.record(p);

    // fixture 自己的预置（预置状态 / 提前下计划等）
    if (typeof fixture.setup === 'function') await fixture.setup(ctx);

    // ── 驱动：真实时钟小 tick；每 tick 结束后才检查断言 ────────────────
    lane.start();
    const tickLimit = Number(fixture.maxTicks ?? 300);
    const timeLimit = Number(fixture.timeoutMs ?? 15_000);
    let lastSeen = state.lastTickAt;
    let settleAt = nowMs();
    let processedTick = 0;

    while (result.ticks < tickLimit && nowMs() - startedAt < timeLimit) {
      await sleep(1);
      const t = state.lastTickAt;
      if (t !== lastSeen) {
        lastSeen = t;
        settleAt = nowMs();
        continue;
      }
      if (t === processedTick) continue;
      if (nowMs() - settleAt < 1) continue; // 让本 tick 的微任务跑完再判定
      processedTick = t;
      result.ticks += 1;
      ctx.ticks = result.ticks;
      try {
        fixture.onTick?.(ctx);
      } catch (e) {
        ctx.hookError = e;
        break;
      }
      if (trace.of('tick_error').length) break;
      if (fixture.done?.(ctx)) break;
    }

    lane.stop();
    await sleep(40);
    lane = null;

    // ── 断言 ───────────────────────────────────────────────────────
    const tickErrors = trace.of('tick_error');
    result.checks.push({
      name: 'Lane 没有 tick_error',
      ok: tickErrors.length === 0,
      detail: tickErrors.map((e) => e.note).join(' | '),
    });
    result.checks.push({
      name: '驱动跑到了至少 1 个 tick',
      ok: result.ticks > 0,
      detail: `ticks=${result.ticks}`,
    });
    if (ctx.hookError) {
      result.checks.push({
        name: 'fixture.onTick 没抛错',
        ok: false,
        detail: String(ctx.hookError?.stack || ctx.hookError),
      });
    }
    const fixtureChecks = (await fixture.check?.(ctx)) ?? [];
    result.checks.push(...fixtureChecks);
    result.dump = {
      inbox: inbox.items.map((i) => ({ kind: i.kind, needsBrain: i.needsBrain, detailKind: i.detail?.recipeId ?? i.detail?.status })),
      trace: trace.kinds(),
      planHistory: (state.planHistory ?? []).map((p) => ({
        id: p.id,
        recipeId: p.recipeId,
        source: p.source,
        status: p.status,
        reason: p.lastError,
        steps: (p.stepResults ?? []).map((r) => `${r.as}:${r.ok ? 'ok' : r.kind}`),
      })),
      state: {
        hunger: state.hunger,
        food: state.foodCount,
        hp: state.hp,
        dark: state.dark,
        hostile: state.hostileCount,
        stuckSince: state.stuckSince,
        haltedUntil: state.survivalHaltedUntil,
      },
    };
  } catch (e) {
    result.error = String(e?.stack || e);
    result.checks.push({ name: '回放执行没有异常', ok: false, detail: result.error });
  } finally {
    try {
      lane?.stop();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // 软断言（soft=true）是"已知与 docs 不符、当前 src 如此"的提示，不计入 PASS/FAIL
  const hard = result.checks.filter((c) => !c.soft);
  result.ok = hard.length > 0 && hard.every((c) => c.ok);
  result.ms = nowMs() - startedAt;
  return result;
}

// ── 真实文件的"没被碰过"快照（只警告，不当失败：树进程可能同时在写）─────
function snapshotRealFiles() {
  return ['places.json', 'world.json'].map((name) => {
    const file = path.join(ROOT, name);
    try {
      const st = fs.statSync(file);
      return { file, exists: true, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return { file, exists: false };
    }
  });
}

function describeRealFileDiff(before, after) {
  const diffs = [];
  for (const b of before) {
    const a = after.find((x) => x.file === b.file);
    if (!a) continue;
    if (b.exists !== a.exists) diffs.push(`${path.basename(b.file)} 存在性变化`);
    else if (b.exists && (b.mtimeMs !== a.mtimeMs || b.size !== a.size)) {
      diffs.push(`${path.basename(b.file)} 被外部改动（mtime/size 变了）`);
    }
  }
  return diffs;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const f of FIXTURES) console.log(`${f.id}\t${f.title}`);
    return;
  }
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg
    ? new Set(
        onlyArg
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const fixtures = only ? FIXTURES.filter((f) => only.has(f.id)) : FIXTURES;
  if (!fixtures.length) {
    console.error(`没有匹配的场景：${[...(only ?? [])].join(',')}（用 --list 看可用场景）`);
    process.exit(1);
  }

  await loadSkills(); // Lane 派技能前必须先注册技能表

  const baseCfg = loadConfig();
  const before = snapshotRealFiles();

  console.log('=== numen-tree 离线回放（M1）===');
  console.log(
    `场景 ${fixtures.length} 个；tickMs=${DEFAULT_TICK_MS}；places/worldmem 用 $TEMP 临时文件；trace 只进内存（不写 logs/）`,
  );
  console.log('');

  const results = [];
  for (let i = 0; i < fixtures.length; i += 1) {
    const fixture = fixtures[i];
    process.stdout.write(`[${i + 1}/${fixtures.length}] ${fixture.id} — ${fixture.title}\n`);
    const r = await runFixture(fixture, baseCfg);
    results.push(r);

    for (const c of r.checks) {
      const mark = c.ok ? '✓' : c.soft ? '⚠' : '✗';
      console.log(`        ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    const hard = r.checks.filter((c) => !c.soft);
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(
      `        ${tag}  (ticks=${r.ticks}, ${Math.round(r.ms)}ms, 断言 ${hard.filter((c) => c.ok).length}/${hard.length})`,
    );
    if (r.error) console.log(`        ! ${r.error.split('\n')[0]}`);
    if (args.includes('--dump')) console.log(JSON.stringify(r.dump, null, 2));
    console.log('');
  }

  const after = snapshotRealFiles();
  const realDiffs = describeRealFileDiff(before, after);
  const passed = results.filter((r) => r.ok).length;
  const hardChecks = results.flatMap((r) => r.checks.filter((c) => !c.soft));
  const softChecks = results.flatMap((r) => r.checks.filter((c) => c.soft));
  const hardPassed = hardChecks.filter((c) => c.ok).length;
  const softFailed = softChecks.filter((c) => !c.ok).length;

  console.log('=== 汇总 ===');
  for (const r of results) {
    const hard = r.checks.filter((c) => !c.soft);
    const softWarn = r.checks.filter((c) => c.soft && !c.ok).length;
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(12)} ${r.ticks} ticks / ${Math.round(r.ms)}ms` +
        ` (断言 ${hard.filter((c) => c.ok).length}/${hard.length}${softWarn ? `, ⚠${softWarn}` : ''})`,
    );
  }
  console.log(`  场景：${passed}/${results.length} 通过；断言：${hardPassed}/${hardChecks.length} 通过`);
  if (softChecks.length) {
    console.log(
      `  软断言（已知 docs 偏差，不计入 PASS/FAIL）：${softChecks.length - softFailed}/${softChecks.length} 符合` +
        (softFailed ? `，⚠${softFailed} 条与 docs/12 不符（见上面的 ⚠）` : ''),
    );
  }
  console.log(
    realDiffs.length
      ? `  隔离：WARN 真实文件有外部改动（不是本次回放写的）：${realDiffs.join('；')}`
      : '  隔离：真实 places.json / world.json 未被读改（本次只用临时文件，跑完已删）',
  );

  if (passed !== results.length) {
    console.log('\n=== 失败场景重跑建议：node probe/replay.mjs --only=' +
      results.filter((r) => !r.ok).map((r) => r.id).join(',') + ' ===');
    process.exitCode = 1;
  } else {
    console.log('\n=== 全部场景通过 ===');
  }
}

main().catch((e) => {
  console.error('回放器自身崩溃：', e);
  process.exit(1);
});

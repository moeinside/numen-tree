import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, loadNumenEndpoint } from './config.mjs';
import { NumenClient } from './numen.mjs';
import { Trace } from './trace.mjs';
import { Inbox, CompanionState, makeGoal } from './state.mjs';
import { loadSkills, listSkills, getSkill, reloadSkills } from './skills/index.mjs';
import { Lane } from './lane.mjs';
import { createTreeMcpServer } from './mcpserver.mjs';
import { LineBank } from './lines.mjs';
import { PlaceBook } from './places.mjs';
import { Planner, planView, planAlive } from './plan.mjs';
import { RECIPES } from './recipes.mjs';
import { getTactic } from './tactics.mjs';
import { getStrategy } from './strategy.mjs';
import { declarationForStrategy, priorityClassForConsequence, consequenceForPriorityClass } from './priority-declarations.mjs';
import { INTERRUPTS } from './interrupts.mjs';
import { WorldMemory } from './worldmem.mjs';
import { lockFixFromConfig } from './lockfix.mjs';
import { tentacleFromConfig } from './tentacle.mjs';

// ── 启动 guard：dev 持有 lease 时，直接 node src/daemon.mjs 也必须拒绝 ──
// 权威仍是 runs/.pilot-lock.json（lease + 未过期 + PID 活）；mode.json 只是快照。
// 紧急人工绕过：TREE_ALLOW_DEV=1（会写日志，仅限确认 dev 已停但 lease 残留时）。
function activeDevLease() {
  if (process.env.TREE_ALLOW_DEV === '1') return null;
  const lockFile = process.env.TREE_GUARD_LOCK
    ? path.resolve(process.env.TREE_GUARD_LOCK)
    : path.resolve('runs', '.pilot-lock.json');
  let lease;
  try {
    // 容忍 Windows/PowerShell 常见的 UTF-8 BOM；否则 BOM 会让 guard 解析失败而误放行。
    const raw = fs.readFileSync(lockFile, 'utf8').replace(/^\uFEFF/, '');
    lease = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!lease || !lease.owner) return null;
  const kind = String(lease.kind || lease.mode || '');
  if (!/dev|pilot|mode/i.test(kind) && !/^(pilot|mode|dev)/i.test(String(lease.owner))) {
    return null;
  }
  const exp = Date.parse(lease.expiresAt || '');
  if (Number.isFinite(exp) && exp < Date.now()) return null;
  try {
    process.kill(Number(lease.pid), 0);
  } catch (e) {
    if (e?.code !== 'EPERM') return null;
  }
  return { ...lease, lockFile };
}

const devLease = activeDevLease();
if (devLease) {
  console.error(
    `[tree-guard] dev lease active: owner=${devLease.owner} pid=${devLease.pid} runId=${devLease.runId ?? ''}`,
  );
  console.error('[tree-guard] refuse to start tree while dev tool holds numen MCP.');
  console.error('[tree-guard] stop dev first: node tools/mode.mjs off --force');
  process.exit(3);
}

const cfg = loadConfig();
loadNumenEndpoint(cfg); // 尽早校验配置存在

// 僵尸锁外部清理客户端（补丁 v3 的 127.0.0.1:8768；补丁没装/游戏没重启时调用会优雅失败）
const lockfix = lockFixFromConfig(cfg);
// 只读触手（numen_tree_tentacle 127.0.0.1:8769；mod 不在时 getPerception 会优雅失败）
const tentacle = tentacleFromConfig(cfg);

const ep = loadNumenEndpoint(cfg);
const trace = new Trace(cfg.trace.dir, cfg.trace.keepDays);
const inbox = new Inbox();
const numen = new NumenClient(ep);
// 事件通道必须用独立 MCP 会话：get_events 长轮询会独占会话，混用会饿死动作调用。
const eventsClient = new NumenClient(ep);

const lanes = new Map();

// 只读模型版本号：treeview 等外部监控用（reload-skills / 配置变化时 +1）。
// 只是给外部"图=运行中的树"提供一个变更信号，不参与任何行为决策。
let modelVersion = 1;
let startedAt = new Date().toISOString();

// 地点簿：死亡点自动记录、基地/主人/自定义地点（持久化到 places.json）
const places = new PlaceBook({ file: cfg.places.file, trace }).load();

// 计划层：意图 → 配方（recipes.mjs 是数据；plan.mjs 是引擎）
const planner = new Planner({ recipes: RECIPES, trace });

// 世界记忆：容器内容 / 资源点（M1 最小集）
const worldmem = new WorldMemory({
  file: cfg.worldmem.file,
  trace,
  maxContainers: cfg.worldmem.maxContainers,
  maxResources: cfg.worldmem.maxResources,
}).load();

// ── 地点簿小工具（控制 API 与 CLI 用；MCP 工具在 mcpserver.mjs 里）─────────
const OWNER_WORDS = /主人|老板|你在哪|主人在哪|我的位置|我的地点|owner|master|where.*you/i;
const KIND_ALIASES = [
  [/家|基地|老巢|营地|据点|老窝|home|base|camp/i, 'base'],
  [/死|坟|尸体|挂了|death|died|grave/i, 'death'],
  [/主人|老板|owner|master/i, 'owner'],
];

function inferPlaceKind(name, kind) {
  if (kind) return kind;
  const s = String(name || '');
  for (const [re, k] of KIND_ALIASES) if (re.test(s)) return k;
  return 'poi';
}

function laneFor(companion) {
  return (companion && lanes.get(companion)) || [...lanes.values()][0] || null;
}

/** 把 CLI 传来的 pos（"here"/"owner"/"x,y,z"/{x,y,z}）解析成坐标 + 维度。 */
function resolvePlacePos(pos, lane) {
  const st = lane?.state || null;
  const dimension = st?.dimension || null;
  if (pos && typeof pos === 'object' && Number.isFinite(Number(pos.x))) {
    return {
      pos: { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) },
      dimension: pos.dimension || dimension,
    };
  }
  if (pos === 'here') return { pos: st?.pos || null, dimension };
  if (pos === 'owner') return { pos: st?.ownerPos || null, dimension };
  if (typeof pos === 'string' && /^-?\d/.test(pos.trim())) {
    const [x, y, z] = pos.split(',').map(Number);
    if ([x, y, z].every(Number.isFinite)) return { pos: { x, y, z }, dimension };
  }
  return { pos: null, dimension };
}

function placeSummary(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    dimension: p.dimension,
    pos: p.pos,
    note: p.note ?? '',
    createdAt: p.createdAt,
  };
}

/**
 * 开一个计划任务（MCP tree_task / 控制 API / CLI 共用入口）。
 * 模糊意图交给 Planner 匹配配方；匹配不上返回可用清单。
 */
function startTask({ companion, intent, deadlineSeconds = null, params = {} } = {}) {
  const lane = laneFor(companion);
  if (!lane) return { ok: false, reason: 'no_companion', message: `没有这个同伴：${companion}` };
  const i = String(intent ?? '').trim();
  if (!i) return { ok: false, reason: 'intent_required' };
  const overrides = params && typeof params === 'object' ? params : {};
  const r = lane.startPlan({
    intent: i,
    source: 'llm',
    deadlineSeconds: deadlineSeconds ?? null,
    overrides,
  });
  if (r.ok) {
    trace.info('task_started', {
      companion: lane.state.name,
      note: `${r.plan.id} ${r.recipe.id}「${i}」`,
    });
  }
  return r;
}

// 台词库：默认 preset + 人设覆盖（生成/更新机制以后再做）
const lines = new LineBank({
  dir: cfg.lines.dir,
  persona: cfg.lines.persona,
  enabled: cfg.lines.enabled,
}).load();

function json(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function statusPayload() {
  return {
    startedAt,
    modelVersion,
    numen: { endpoint: ep.endpoint },
    companions: [...lanes.keys()].map((k) => lanes.get(k).state.snapshot()),
    inboxSeq: inbox.seq,
  };
}

async function discoverCompanions() {
  const { companions } = await numen.listCompanions();
  const wanted = cfg.companions?.length
    ? companions.filter((c) => cfg.companions.includes(c.name) || cfg.companions.includes(c.id))
    : companions;

  for (const c of wanted) {
    if (lanes.has(c.name)) {
      const st = lanes.get(c.name).state;
      if (c.id !== st.id) st.id = c.id; // 重生/重建后 id 会变
      continue;
    }
    const state = new CompanionState(c);
    const lane = new Lane({ state, numen, eventsClient, trace, inbox, cfg, lines, places, planner, worldmem, lockfix });
    lanes.set(c.name, lane);
  }
  return [...lanes.keys()];
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, cfg.control.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, startedAt });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, statusPayload());
    }

    // ── 僵尸锁外部清理（补丁 v3 的 127.0.0.1:8768）────────────────
    // GET  /lock   → 补丁状态 + 每个同伴当前 slotBlocked
    // POST /lock   → {op:'unlock', companion?, all?}：清一个同伴的锁 / 清全部
    if (req.method === 'GET' && url.pathname === '/lock') {
      const patch = lockfix ? await lockfix.status() : { ok: false, error: 'lockRecovery 未启用' };
      return json(res, 200, {
        ok: patch?.ok !== false,
        patch,
        companions: [...lanes.values()].map((l) => ({
          name: l.state.name,
          id: l.state.id,
          slotBlocked: l.state.slotBlocked,
          slotBlockedSince: l.state.slotBlockedSince,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/lock') {
      const body = await readBody(req);
      if (body.op !== 'unlock' && body.op !== 'reset-brain') {
        return json(res, 400, { error: `未知操作：${body.op ?? '(空)'}（可用 unlock / reset-brain）` });
      }
      const lane = body.companion ? lanes.get(body.companion) : null;
      if (body.companion && !lane) {
        return json(res, 404, { error: `没有这个同伴：${body.companion}` });
      }
      let r;
      if (body.op === 'reset-brain') {
        if (!lockfix?.resetBrain) r = { ok: false, error: '补丁 v1.2 未加载（需重启游戏）' };
        else if (lane && !body.all) r = await lockfix.resetBrain({ uuid: lane.state.id });
        else r = await lockfix.resetBrain({ all: true });
      } else if (lane && !body.all) r = await lane.unlockNow({ all: false });
      else if (lockfix) r = await lockfix.unlock({ all: true });
      else r = { ok: false, error: 'lockRecovery 未启用' };
      trace.info('lock_request', {
        companion: lane?.state?.name ?? '(all)',
        note: `${body.op} ${JSON.stringify(r).slice(0, 200)}`,
      });
      return json(res, r?.ok ? 200 : 502, r);
    }

    if (req.method === 'GET' && url.pathname === '/skills') {
      return json(res, 200, { skills: listSkills() });
    }

    if (req.method === 'GET' && url.pathname === '/lines') {
      return json(res, 200, {
        enabled: cfg.lines.enabled,
        persona: cfg.lines.persona,
        count: lines.entries.size,
        stats: lines.stats,
        entries: lines.list(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/inbox') {
      const since = Number(url.searchParams.get('since') || 0);
      const brainOnly = url.searchParams.get('brainOnly') === '1';
      let items = inbox.since(since);
      if (brainOnly) items = items.filter((i) => i.needsBrain);
      return json(res, 200, { seq: inbox.seq, items });
    }

    // ── 计划任务（M1：意图 → 配方 → 分步执行）──────────────────
    if (req.method === 'GET' && url.pathname === '/task') {
      const lane = laneFor(url.searchParams.get('companion') || undefined);
      const live = lane?.state?.plan || null;
      const last = lane?.state?.planHistory?.[0] || null;
      return json(res, 200, {
        ok: true,
        companion: lane?.state?.name ?? null,
        alive: planAlive(live),
        plan: live ? planView(live) : null,
        lastPlan: !live && last ? planView(last) : null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/task') {
      const body = await readBody(req);
      const r = startTask({
        companion: body.companion,
        intent: body.intent,
        deadlineSeconds: body.deadlineSeconds ?? null,
        params: body.params || {},
      });
      return json(res, r.ok ? 200 : 400, r);
    }

    if (req.method === 'GET' && url.pathname === '/recipes') {
      return json(res, 200, {
        ok: true,
        recipes: planner.listRecipes(),
        interrupts: INTERRUPTS.map((i) => ({
          id: i.id,
          priority: i.priority,
          cooldownSeconds: i.cooldownSeconds,
          resume: i.resume ?? 'resume',
        })),
      });
    }

    // ── 地点簿（CLI / 调试用；对 LLM 的是 MCP 工具 tree_place）──────────

    if (req.method === 'GET' && url.pathname === '/places') {
      const kind = url.searchParams.get('kind') || undefined;
      const query = url.searchParams.get('query') || undefined;
      const companion = url.searchParams.get('companion') || undefined;
      const nearStr = url.searchParams.get('near');
      const lane = laneFor(companion);
      let near = null;
      if (nearStr) {
        const [x, y, z] = nearStr.split(',').map(Number);
        if ([x, y, z].every(Number.isFinite)) near = { x, y, z };
      } else if (lane?.state?.pos) {
        near = lane.state.pos;
      }
      const list = places.list({ kind });
      let match = null;
      if (query) {
        if (OWNER_WORDS.test(query) && lane?.state?.ownerPos) {
          match = {
            place: {
              name: '主人当前位置',
              kind: 'owner',
              dimension: lane.state.dimension,
              pos: lane.state.ownerPos,
              live: true,
            },
            why: '这是主人的实时位置，没有写进地点簿',
          };
        } else {
          match = places.find(query, { dimension: lane?.state?.dimension, near });
        }
      }
      return json(res, 200, { ok: true, places: list, match });
    }

    if (req.method === 'POST' && url.pathname === '/place') {
      const body = await readBody(req);
      const lane = laneFor(body.companion);
      const action = body.action || 'record';

      if (action === 'list') {
        return json(res, 200, { ok: true, places: places.list({ kind: body.kind }) });
      }

      if (action === 'find') {
        const q = String(body.query || body.name || '');
        if (!q) return json(res, 400, { ok: false, reason: 'query_required' });
        if (OWNER_WORDS.test(q) && lane?.state?.ownerPos) {
          return json(res, 200, {
            ok: true,
            live: true,
            place: {
              name: '主人当前位置',
              kind: 'owner',
              dimension: lane.state.dimension,
              pos: lane.state.ownerPos,
            },
            why: '主人实时位置（未写入地点簿）',
          });
        }
        const m = places.find(q, {
          dimension: lane?.state?.dimension,
          near: lane?.state?.pos || null,
        });
        if (!m) return json(res, 200, { ok: false, reason: 'not_found', query: q });
        return json(res, 200, { ok: true, ...m });
      }

      if (action === 'forget') {
        const q = String(body.query || body.name || body.id || '');
        if (!q) return json(res, 400, { ok: false, reason: 'query_required' });
        const gone = places.forget(q);
        return json(res, 200, { ok: !!gone, place: placeSummary(gone) });
      }

      // record
      const resolved = resolvePlacePos(body.pos, lane);
      if (!resolved.pos) {
        return json(res, 400, {
          ok: false,
          reason: 'no_position',
          hint: 'pos 需要 "here" / "owner" / {x,y,z}，或者先让同伴观测到位置',
        });
      }
      const place = places.record({
        name: String(body.name || '未命名地点'),
        kind: inferPlaceKind(body.name, body.kind),
        dimension: resolved.dimension,
        pos: resolved.pos,
        note: body.note || '',
        source: 'cli',
        companion: lane?.state?.name || null,
      });
      trace.info('place_recorded', { companion: lane?.state?.name, note: `${place.id} ${place.name}` });
      return json(res, 200, { ok: true, place: placeSummary(place) });
    }

    if (req.method === 'POST' && url.pathname === '/goal') {
      const body = await readBody(req);
      if (!body.companion) return json(res, 400, { error: '缺少 companion' });
      const lane = lanes.get(body.companion);
      if (!lane) return json(res, 404, { error: `没有这个同伴：${body.companion}` });
      if (body.skill === 'tactic') {
        if (!getTactic(body.params?.tactic)) {
          return json(res, 400, { error: `没有这个战术包：${body.params?.tactic}` });
        }
      } else if (body.skill === 'strategy') {
        if (!getStrategy(body.params?.strategy)) {
          return json(res, 400, { error: `没有这个战略包：${body.params?.strategy}` });
        }
      } else if (!getSkill(body.skill)) {
        return json(res, 400, { error: `没有这个技能：${body.skill}` });
      }
      const priority = Number(body.priority ?? 0);
      let priorityClass = null;
      let consequence = null;
      let reversal = null;
      if (body.skill === 'tactic') {
        const tactic = getTactic(body.params?.tactic);
        priorityClass = tactic?.priorityClass ?? null;
        consequence = consequenceForPriorityClass(priorityClass);
      } else if (body.skill === 'strategy') {
        const decl = declarationForStrategy(body.params?.strategy);
        priorityClass = decl.priorityClass;
        consequence = decl.consequence;
        reversal = decl.reversal;
      }
      const goal = makeGoal({
        skill: body.skill,
        params: body.params || {},
        priority,
        priorityClass,
        consequence,
        reversal,
        note: body.note || '',
      });
      lane.state.pushGoal(goal);
      trace.info('goal_added', {
        companion: lane.state.name,
        note: `${goal.id} ${goal.skill} ${JSON.stringify(goal.params)}`,
      });
      return json(res, 200, { goal });
    }

    if (req.method === 'POST' && url.pathname === '/control') {
      const body = await readBody(req);
      if (body.op === 'reload-skills') {
        // 开发用：改完 src/skills/*.mjs 热重载，不用重启树进程（不针对某个同伴）。
        // 顺带把配方表也重新 import 一次（?t= 破 ESM 缓存），这样新增配方也不用重启。
        await reloadSkills();
        try {
          const fresh = await import(`./recipes.mjs?t=${Date.now()}`);
          planner.recipes = fresh.RECIPES;
          trace.info('recipes_reloaded', { note: fresh.RECIPES.map((r) => r.id).join(',') });
        } catch (e) {
          trace.warn('recipes_reload_failed', { note: String(e?.message || e) });
        }
        trace.info('skills_reloaded', { note: listSkills().map((s) => s.id).join(',') });
        modelVersion += 1; // 让 treeview 知道"运行中的树定义变了"
        return json(res, 200, { ok: true, modelVersion, skills: listSkills(), recipes: planner.listRecipes() });
      }
      if (body.op === 'exit') {
        // 优雅退出：先停所有通道（不再派新动作），等在途动作自然结束再退出。
        // 直接 taskkill 可能把在途 lua 调用留在游戏里 → 僵尸锁。
        trace.info('exit_requested', {});
        for (const lane of lanes.values()) lane.stop();
        json(res, 200, { ok: true, note: '等待在途动作结束后退出' });
        const t0 = Date.now();
        const waitIdle = async () => {
          // 必须比任何技能的自报预算都长：在途 lua 被强行打断就会留僵尸锁
          while (Date.now() - t0 < 240_000) {
            const busy = [...lanes.values()].some((l) => l.state.actionLock);
            if (!busy) break;
            await sleep(500);
          }
          trace.info('exit', { note: `在途动作已收敛（${Math.round((Date.now() - t0) / 1000)}s）` });
          server.close();
          setTimeout(() => process.exit(0), 200);
        };
        waitIdle();
        return;
      }
      const lane = lanes.get(body.companion);
      if (!lane) return json(res, 404, { error: `没有这个同伴：${body.companion}` });
      const st = lane.state;
      switch (body.op) {
        case 'pause':
          st.paused = true;
          break;
        case 'resume':
          st.paused = false;
          break;
        case 'clear':
          st.cancelAll('cleared');
          break;
        case 'mode':
          st.mode = String(body.mode || 'normal');
          break;
        case 'tether': {
          // 动态牵引绳：owner=跟着主人 / home=绑地点簿的"家"
          const a = String(body.mode ?? body.anchor ?? '').toLowerCase();
          if (['owner', 'follow', '跟', '跟随', '跟着'].some((k) => a.includes(k))) st.tether = 'owner';
          else if (['home', '家', '基地', 'stay', '待'].some((k) => a.includes(k))) st.tether = 'home';
          else return json(res, 400, { error: 'tether 需要 mode: "owner" 或 "home"' });
          break;
        }
        case 'stop':
          st.paused = true;
          st.cancelAll('stopped');
          st.driveStartedAt = null;
          st.driveGoals = 0;
          st.driveStopReason = null;
          st.lastLlmGoalAt = 0;
          break;
        default:
          return json(res, 400, { error: `未知操作：${body.op}` });
      }
      trace.info('control', { companion: st.name, note: `${body.op}${body.mode ? ':' + body.mode : ''}` });
      return json(res, 200, { ok: true, state: st.snapshot() });
    }

    return json(res, 404, { error: 'unknown route' });
  } catch (e) {
    trace.error('http_error', { note: String(e?.stack || e) });
    return json(res, 500, { error: String(e?.message || e) });
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 游戏没开 / 还在加载时不要崩，等着就行。 */
async function connectWithRetry() {
  for (;;) {
    try {
      const info = await numen.connect();
      await eventsClient.connect();
      return info;
    } catch (e) {
      console.log(`[等待] 连不上 numen MCP（${e?.message || e}），5 秒后重试……（Ctrl+C 退出）`);
      await sleep(5000);
    }
  }
}

const startedLanes = new Set();

/** 后台发现循环：同伴可能晚点才召唤出来，也可能被重建/换 id。 */
async function discoveryLoop() {
  let lastSig = null;
  let lastErrAt = 0;
  for (;;) {
    try {
      const names = await discoverCompanions();
      for (const name of names) {
        if (!startedLanes.has(name)) {
          lanes.get(name).start();
          startedLanes.add(name);
        }
      }
      const sig = names.join(',');
      if (sig !== lastSig) {
        lastSig = sig;
        console.log(names.length ? `[同伴] 已接管：${sig}` : '[同伴] 暂时没有在线同伴，等待中……');
      }
    } catch (e) {
      const now = Date.now();
      if (now - lastErrAt > 30000) {
        lastErrAt = now;
        console.log(`[等待] 列不出同伴（${e?.message || e}），继续重试……`);
      }
    }
    await sleep(5000);
  }
}

async function main() {
  await loadSkills();
  const info = await connectWithRetry();
  trace.info('numen_connected', { note: `${info.serverInfo?.name} ${info.serverInfo?.version}` });

  // 先把服务起起来：即使暂时没有同伴，LLM 也能连上并看到 tree_status
  const mcpSrv = createTreeMcpServer({
    host: cfg.mcp.host,
    port: cfg.mcp.port,
    lanes,
    inbox,
    trace,
    numen,
    places,
    startTask,
    tentacle,
    skills: () => listSkills(),
  });
  await mcpSrv.listen().catch((e) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(
        `\n[错误] MCP 端口 ${cfg.mcp.port} 已被占用 —— 很可能已经有一个树进程在跑。\n` +
          `       用 启动树进程.bat 启动会自动结束旧进程；或手动查：\n` +
          `       netstat -ano | findstr :${cfg.mcp.port}\n`,
      );
      process.exit(2);
    }
    throw e;
  });

  server.on('error', (e) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(
        `\n[错误] 控制端口 ${cfg.control.port} 已被占用 —— 已经有一个树进程在跑。\n`,
      );
      process.exit(2);
    }
    throw e;
  });

  server.listen(cfg.control.port, cfg.control.host, () => {
    trace.info('control_listening', { note: cfg.control.url });
    console.log(`\n树进程已启动`);
    console.log(`  控制 API : ${cfg.control.url}`);
    console.log(`  MCP 工具 : http://${cfg.mcp.host}:${cfg.mcp.port}/mcp`);
    console.log(`  技能     : ${listSkills().map((s) => s.id).join(', ')}`);
    console.log(`  配方     : ${planner.listRecipes().map((r) => r.id).join(', ')}（中断 ${INTERRUPTS.length} 条）`);
    console.log(
      `  台词库   : ${lines.entries.size} 条（人设 ${cfg.lines.persona}${cfg.lines.enabled ? '' : '，已停用'}）`,
    );
    console.log(`  同伴     : 发现中……\n`);
  });

  discoveryLoop();
}

function shutdown() {
  trace.info('shutdown', {});
  for (const lane of lanes.values()) lane.stop();
  server.close();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});

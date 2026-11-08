#!/usr/bin/env node
/**
 * treeview 独立工具：树监控（不是树的组件，单向只读依赖）。
 *
 *   node tools/treeview/server.mjs                 # 默认 http://127.0.0.1:8780
 *   node tools/treeview/server.mjs --mock          # 无游戏/无树时演示（生成模拟运行态）
 *   node tools/treeview/server.mjs --port 8781 --tree http://127.0.0.1:8766
 *
 * 数据来源（全部只读）：
 *   - 静态结构：../src/recipes.mjs / interrupts.mjs / schedule.mjs / crafttree.mjs / skills/*
 *   - 运行态：GET {tree}/status（控制 API，含 modelVersion）
 *   - 历史：{repo}/logs/trace-*.jsonl 尾部（失败/步骤/派发事件）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel } from './model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // 仓库根（numen-tree）
const PUBLIC = path.join(HERE, 'public');

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argVal('--port', process.env.TREEVIEW_PORT || 8780));
const TREE = String(argVal('--tree', process.env.TREEVIEW_TREE || 'http://127.0.0.1:8766')).replace(/\/$/, '');
const MOCK = argv.includes('--mock');
const TRACE_DIR = path.join(ROOT, 'logs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js.map': 'application/json',
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
};

// ── 模型缓存（modelVersion 变化时重建；treeview 自己不做 hot reload 渲染）──
let modelCache = null;
let modelCacheVersion = null;
let modelCacheAt = 0;
async function getModel({ force = false, version = null } = {}) {
  const stale = Date.now() - modelCacheAt > 3000;
  if (!force && modelCache && !stale && (version == null || version === modelCacheVersion)) return modelCache;
  const model = await buildModel();
  modelCache = model;
  modelCacheVersion = version;
  modelCacheAt = Date.now();
  return model;
}

// ── 运行态 ────────────────────────────────────────────────────
async function fetchTreeStatus() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    const r = await fetch(`${TREE}/status`, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function latestTraceFile() {
  try {
    const files = fs
      .readdirSync(TRACE_DIR)
      .filter((f) => /^trace-.*\.jsonl$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(TRACE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? path.join(TRACE_DIR, files[0].f) : null;
  } catch {
    return null;
  }
}

async function readTraceTail(maxBytes = 512 * 1024, maxLines = 400) {
  const file = latestTraceFile();
  if (!file) return { file: null, events: [] };
  const st = await fsp.stat(file);
  const start = Math.max(0, st.size - maxBytes);
  const fh = await fsp.open(file, 'r');
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const events = [];
    for (const line of lines.slice(-maxLines)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // 半行（正在写）忽略
      }
    }
    return { file: path.basename(file), events };
  } finally {
    await fh.close();
  }
}

/** 从 trace 原始事件归一化成前端好用的 activity（容错解析 note）。 */
function normalizeEvent(e) {
  const base = { t: e.t, kind: e.kind, companion: e.companion ?? null, level: e.level ?? 'info' };
  const note = String(e.note ?? '');
  const out = { ...base, note, activity: 'other', skill: null, goalId: null, recipeId: null, step: null, ok: null, failKind: null };
  try {
    if (e.kind === 'dispatch') {
      const m = note.match(/^(\S+)\s+(\S+)/);
      if (m) Object.assign(out, { activity: 'dispatch', goalId: m[1], skill: m[2], ok: null });
    } else if (e.kind === 'done') {
      const m = note.match(/^(\S+)\s+(\S+)\s+ok/);
      if (m) Object.assign(out, { activity: 'done', goalId: m[1], skill: m[2], ok: true });
    } else if (e.kind === 'failed') {
      const m = note.match(/^(\S+)\s+(\S+)\s+(\w+)\s+after/);
      if (m) Object.assign(out, { activity: 'fail', goalId: m[1], skill: m[2], failKind: m[3], ok: false });
    } else if (e.kind === 'plan_start') {
      const m = note.match(/^(\S+)\s+(\S+)/);
      if (m) Object.assign(out, { activity: 'plan_start', recipeId: m[2] });
    } else if (e.kind === 'plan_step') {
      const m = note.match(/^([^/\s]+)\/(\S+)\s+ok=(true|false)(?::(\w+))?/);
      if (m) Object.assign(out, { activity: 'plan_step', recipeId: m[1], step: m[2], ok: m[3] === 'true', failKind: m[4] ?? null });
    } else if (e.kind === 'plan_end') {
      const m = note.match(/^(\S+)\s+(\S+)/);
      if (m) Object.assign(out, { activity: 'plan_end', recipeId: m[2] });
    } else if (e.kind === 'goal_added') {
      const m = note.match(/^(\S+)\s+(\S+)/);
      if (m) Object.assign(out, { activity: 'goal_added', goalId: m[1], skill: m[2] });
    } else if (e.kind === 'auto_action' || e.kind === 'auto_plan') {
      out.activity = 'auto';
      const sm = note.match(/->\s*([a-z_]+)/);
      if (sm) out.skill = sm[1];
    } else if (e.kind === 'interrupt') {
      out.activity = 'interrupt';
    }
  } catch {
    // 忽略解析失败，保留 other
  }
  return out;
}

// ── mock（无游戏/无树时的演示数据）────────────────────────────
const MOCK_START = Date.now();
function mockState() {
  const step = Math.floor((Date.now() - MOCK_START) / 1500);
  const steps = ['chop', 'collect', 'home', 'report'];
  const planRecipe = 'gather_wood';
  const companions = ['bigWhale', 'tyrander'].map((name, ci) => {
    const hue = ci * 140;
    const cursor = steps[step % steps.length];
    const done = steps.slice(0, step % steps.length);
    const plan = {
      id: `pl${ci + 1}`,
      recipeId: planRecipe,
      title: '砍点木头',
      source: ci === 0 ? 'auto' : 'llm',
      status: 'active',
      cursor,
      steps_done: done.length,
      steps_total: steps.length,
      visits: Object.fromEntries(done.map((s) => [s, 1])),
    };
    return {
      name,
      id: `mock-${ci}`,
      pos: { x: 100 + ci * 3, y: 64, z: -40 },
      hp: 20 - ci, hunger: 12 + ci, mode: 'survival', paused: false, dark: step % 8 < 3,
      schedule: { id: ci === 0 ? 'day' : 'night', title: ci === 0 ? '白天' : '夜里守家', nightGuard: ci === 1 },
      plan,
      goals: [
        { id: `g${ci}1`, skill: cursor === 'chop' ? 'mine_nearby' : 'collect_items', status: 'running', priority: 20, note: 'mcp' },
        { id: `g${ci}2`, skill: 'go_home', status: 'pending', priority: 10, note: 'auto:' },
      ],
      current: { skill: cursor === 'chop' ? 'mine_nearby' : 'collect_items', startedAt: new Date().toISOString() },
      lastAction: { skill: cursor === 'chop' ? 'mine_nearby' : 'collect_items', ok: true, kind: 'ok' },
      drive: null,
      slotBlocked: 0,
      consecutiveFailures: 0,
      inventory: [{ item: 'minecraft:spruce_log', count: 7 }],
      hue,
    };
  });
  const events = [];
  for (let i = 0; i < 10; i++) {
    const t = new Date(Date.now() - (10 - i) * 600).toISOString();
    const s = steps[(step - 10 + i + steps.length * 4) % steps.length];
    events.push({
      t,
      kind: i % 5 === 0 ? 'failed' : i % 3 === 0 ? 'plan_step' : 'dispatch',
      level: i % 5 === 0 ? 'warn' : 'info',
      companion: companions[i % 2].name,
      note: i % 5 === 0
        ? `g${i} go_to no_path after 5000ms: mock no path`
        : i % 3 === 0
          ? `${planRecipe}/${s} ok=true -> advance:next`
          : `g${i} ${i % 2 ? 'mine_nearby' : 'collect_items'} {}`,
    });
  }
  return {
    startedAt: MOCK_START,
    modelVersion: 1,
    numen: { endpoint: 'mock' },
    companions,
    inboxSeq: 3,
    mode: 'mock',
    events,
  };
}

function mockModel() {
  // mock 模式仍用真实模型（树定义），只是运行态是假的
  return { mock: true };
}

// ── 静态文件 ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, port: PORT, tree: TREE, mock: MOCK, root: ROOT });
    }
    if (url.pathname === '/api/model') {
      const force = url.searchParams.get('force') === '1';
      const model = await getModel({ force, version: url.searchParams.get('v') ?? null });
      return json(res, 200, model);
    }
    if (url.pathname === '/api/state') {
      const trace = await readTraceTail();
      if (MOCK) {
        const st = mockState();
        return json(res, 200, {
          mode: 'mock',
          ts: new Date().toISOString(),
          tree: TREE,
          modelVersion: st.modelVersion,
          status: st,
          traceFile: 'mock',
          events: (st.events ?? []).map(normalizeEvent),
        });
      }
      let status = null;
      let mode = 'offline';
      try {
        status = await fetchTreeStatus();
        mode = 'live';
      } catch {
        status = null;
      }
      const events = (trace.events ?? []).map(normalizeEvent).slice(-300);
      return json(res, 200, {
        mode,
        ts: new Date().toISOString(),
        tree: TREE,
        modelVersion: status?.modelVersion ?? null,
        status,
        traceFile: trace.file,
        events,
      });
    }
    if (url.pathname === '/api/trace') {
      const trace = await readTraceTail(1024 * 1024, 1000);
      return json(res, 200, trace);
    }
    if (url.pathname === '/api/mock-model') {
      return json(res, 200, mockModel());
    }

    // 静态
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!full.startsWith(PUBLIC)) return json(res, 403, { ok: false });
    if (url.pathname.startsWith('/vendor/')) {
      const vf = path.join(HERE, 'vendor', path.normalize(url.pathname.slice('/vendor/'.length)));
      if (!vf.startsWith(path.join(HERE, 'vendor'))) return json(res, 403, { ok: false });
      return sendFile(res, vf);
    }
    return sendFile(res, full);
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`not found: ${file}`);
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`treeview 已启动: http://127.0.0.1:${PORT}`);
  console.log(`  树控制 API: ${TREE}`);
  console.log(`  模型来源: ${ROOT}\\src\\*.mjs（只读 import）`);
  console.log(MOCK ? '  模式: MOCK（无游戏/无树演示）' : '  模式: LIVE（读运行中的树）');
});

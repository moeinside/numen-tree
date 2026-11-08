#!/usr/bin/env node
/**
 * numen 能力全表生成器（静态盘点阶段）。
 *
 * 用法：
 *   node tools/numen-cap/build.mjs --probe          # 只探测：MCP 工具表 + help 输出格式（不改文件）
 *   node tools/numen-cap/build.mjs --mcp           # 抓 MCP 工具清单 → docs/18-data/mcp-tools.json
 *   node tools/numen-cap/build.mjs --lua           # 抓 Lua API help → JSONL + 每组分表
 *   node tools/numen-cap/build.mjs --all           # 全部
 *
 * 设计：脚本自己抓取/写文件；控制台只打印摘要（不回显大文本），避免 token 爆炸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.mjs';
import { loadNumenEndpoint } from '../../src/config.mjs';
import { NumenClient } from '../../src/numen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = path.join(ROOT, 'docs', '18-data');
const DOC_DIR = path.join(ROOT, 'docs', '18-numen能力');

const args = new Set(process.argv.slice(2));
const cfg = loadConfig();
const ep = loadNumenEndpoint(cfg);

// 官方 18 组（来自 numen.api.help("numen") 的索引）+ 仅模块形式的 numen.shape
const GROUPS = [
  'numen.api', 'numen.build', 'numen.creative', 'numen.fight', 'numen.gear',
  'numen.gui', 'numen.inv', 'numen.locate', 'numen.mc', 'numen.module',
  'numen.move', 'numen.route', 'numen.scan', 'numen.status', 'numen.task',
  'numen.time', 'numen.use', 'numen.work',
];
const MODULES = ['numen.shape', 'numen.status', 'numen.task', 'numen.move', 'numen.inv', 'numen.build', 'numen.fight', 'numen.gui', 'numen.work'];

function short(v, n = 120) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 帮助文本第一行摘要：去掉 --- 注释前缀/空行。 */
function cleanBrief(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.trim() && !l.trim().startsWith('---@') && !l.trim().startsWith('return'));
  return short(String(line ?? '').replace(/^---+\s*/, ''), 200);
}

async function rawRpc(endpoint, method, params, sessionId = null) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(ep.token ? { Authorization: `Bearer ${ep.token}` } : {}),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const sid = r.headers.get('mcp-session-id');
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text;
  let json;
  try {
    json = JSON.parse(line.replace(/^data:\s*/, ''));
  } catch {
    throw new Error(`${method} 返回无法解析: ${short(text, 200)}`);
  }
  return { result: json.result ?? json, sessionId: sid };
}

async function probe() {
  const numen = new NumenClient(ep);
  await numen.connect();
  const comps = await numen.listCompanions();
  console.log(`[probe] companions=${comps.companions?.length ?? 0}`);
  const comp = comps.companions?.[0];
  if (!comp) {
    console.log('[probe] 没有同伴，跳过 Lua 探测');
    return;
  }
  const r1 = await numen.lua(comp.name, 'return tostring(numen.api.help("numen.scan"))', 15000);
  console.log(`[probe] help(numen.scan) kind=${r1.kind} len=${String(r1.value ?? r1.message ?? '').length}`);
  const rAll = await numen.lua(comp.name, 'return tostring(numen.api.help())', 20000);
  const allText = String(rAll.value ?? rAll.message ?? '');
  console.log(`[probe] help() kind=${rAll.kind} len=${allText.length}`);
  console.log('[probe] help() head:', short(allText, 200));
  const r2 = await numen.lua(
    comp.name,
    'local m = numen.module.list() local t = {} for i, v in ipairs(m) do t[#t+1] = tostring(v.name or v.id or v) end return table.concat(t, ",")',
    15000,
  );
  console.log(`[probe] module.list kind=${r2.kind} => ${short(r2.value ?? r2.message, 400)}`);
}

async function fetchMcpTools() {
  // initialize（拿 session）再 tools/list
  const init = await rawRpc(ep.endpoint, 'initialize', {
    protocolVersion: '2024-10-07',
    capabilities: {},
    clientInfo: { name: 'numen-cap', version: '0.1.0' },
  });
  const sid = init.sessionId;
  const list = await rawRpc(ep.endpoint, 'tools/list', {}, sid);
  const tools = (list.result?.tools ?? []).map((t) => ({
    layer: 'mcp',
    name: t.name,
    description: short(t.description, 400),
    inputSchema: t.inputSchema ?? null,
  }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'mcp-tools.json'), JSON.stringify(tools, null, 2), 'utf8');
  console.log(`[mcp] tools=${tools.length} → docs/18-data/mcp-tools.json`);
}

async function fetchLua() {
  const numen = new NumenClient(ep);
  await numen.connect();
  const comps = await numen.listCompanions();
  const comp = comps.companions?.[0];
  if (!comp) {
    console.log('[lua] 没有同伴，退出（先重建/启动游戏）');
    return;
  }
  const lua = async (code, tries = 3) => {
    let last;
    for (let i = 0; i < tries; i++) {
      const r = await numen.lua(comp.name, code, 20000);
      const text = String(r.value ?? r.message ?? '');
      last = r;
      if (r.kind === 'returned' && !/a program is already running/i.test(text)) return text;
      await new Promise((res) => setTimeout(res, 600));
    }
    return String(last?.value ?? last?.message ?? '');
  };
  const rows = [];
  const rawDir = path.join(DATA_DIR, 'raw-help');
  fs.mkdirSync(rawDir, { recursive: true });
  const groups = [...new Set([...GROUPS, ...MODULES])];
  const validGroups = [];
  for (const g of groups) {
    const text = await lua(`return tostring(numen.api.help("${g}"))`);
    // 有效性判定：必须是真正的帮助文本（含 @class 或 numen.xxx = {}），而不是脚本报错
    const valid = text.length > 150 && /---@class\s+numen\.[a-z_]+|numen\.[a-z_]+\s*=\s*\{\}/.test(text);
    if (!valid) {
      console.log(`[lua] ${g}: 跳过（${short(text, 60)}）`);
      continue;
    }
    validGroups.push(g);
    fs.writeFileSync(path.join(rawDir, `${g.replace(/\./g, '-')}.txt`), text, 'utf8');
    // 解析 ---@field <fn> fun(...) 和 numen.<group>.<fn>( 两种写法
    const fns = new Map();
    for (const m of text.matchAll(/---@field\s+([a-zA-Z_][\w]*)\s+fun(?:\(([^\n]*?)\))?\s*:?\s*([^\n]*)/g)) {
      fns.set(m[1], { sig: `fun(${m[2] ?? ''})${m[3] ? ': ' + m[3].trim() : ''}` });
    }
    for (const m of text.matchAll(new RegExp(`(numen\\.${g.replace(/^numen\\./, '')}\\.[a-zA-Z_][\\w]*)\\s*\\(`, 'g'))) {
      const full = m[1];
      const fn = full.split('.').pop();
      if (!fns.has(fn)) fns.set(fn, { sig: '' });
    }
    // 组级行
    rows.push({
      layer: 'lua-group',
      group: g,
      name: g,
      signature: '',
      brief: cleanBrief(text),
      internal: '❓',
      cost: '❓',
      reliability: '❓',
      atomic: '❓',
      treeRole: '❓',
      priority: '❓',
      tested: '❓',
      notes: '',
      helpText: text,
    });
    for (const [fn, info] of fns) {
      const full = `${g}.${fn}`;
      const help = await lua(`return tostring(numen.api.help("${full}"))`);
      const ok = !!help && !/The script stopped|not_found|no function, group or module|bad_argument/i.test(help);
      const fieldLine = text.split('\n').find((l) => new RegExp(`---@field\\s+${fn}\\s+fun`).test(l)) ?? '';
      rows.push({
        layer: 'lua',
        group: g,
        name: full,
        signature: short(info.sig || fieldLine, 240),
        brief: ok ? cleanBrief(help) : '',
        internal: '❓',
        cost: '❓',
        reliability: '❓',
        atomic: '❓',
        treeRole: '❓',
        priority: '❓',
        tested: ok ? '❓' : '⚠️',
        notes: ok ? '' : 'help 取不到（可能是类方法/模块内部函数），待确认',
        helpText: ok ? help : '',
      });
    }
    console.log(`[lua] ${g}: functions=${fns.size}`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'capabilities.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`[lua] total rows=${rows.length} groups=${validGroups.length} → docs/18-data/capabilities.jsonl`);
  // 每组分表（小文件，按需读）
  writePerGroupDocs(rows);
}

function writePerGroupDocs(rows) {
  fs.mkdirSync(DOC_DIR, { recursive: true });
  // 清理上次生成的分表，避免旧组残留
  for (const f of fs.readdirSync(DOC_DIR)) {
    if (/^lua-.*\.md$/.test(f)) fs.unlinkSync(path.join(DOC_DIR, f));
  }
  const by = new Map();
  for (const r of rows) {
    if (r.layer !== 'lua' && r.layer !== 'lua-group') continue;
    if (!by.has(r.group)) by.set(r.group, []);
    by.get(r.group).push(r);
  }
  for (const [g, list] of by) {
    const fns = list.filter((r) => r.layer === 'lua');
    const groupRow = list.find((r) => r.layer === 'lua-group');
    const lines = [
      `# ${g}`,
      '',
      groupRow?.brief ? `> ${groupRow.brief}` : '',
      '',
      '| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |',
      '|---|---|---|---|---|---|---|',
      ...fns.map(
        (r) =>
          `| \`${r.name}\` | \`${r.signature.replace(/\|/g, '\\|')}\` | ${r.brief.replace(/\|/g, '\\|')} | ${r.atomic} | ${r.treeRole} | ${r.priority} | ${r.tested} |`,
      ),
      '',
      `原始帮助：\`docs/18-data/raw-help/${g.replace(/\./g, '-')}.txt\`（含完整说明，按需读）`,
    ];
    fs.writeFileSync(path.join(DOC_DIR, `lua-${g.replace(/^numen\./, '').replace(/\./g, '-')}.md`), lines.join('\n'), 'utf8');
  }
  console.log(`[docs] 分组表 ${by.size} 个 → docs/18-numen能力/`);
}

(async () => {
  try {
    if (args.has('--probe') || (!args.has('--mcp') && !args.has('--lua') && !args.has('--all'))) {
      await probe();
    }
    if (args.has('--mcp') || args.has('--all')) await fetchMcpTools();
    if (args.has('--lua') || args.has('--all')) await fetchLua();
  } catch (e) {
    console.error('[build] 失败:', e?.stack || e);
    process.exitCode = 1;
  }
})();

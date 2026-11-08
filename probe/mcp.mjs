// numen MCP 只读探针客户端
// 用法:
//   node probe/mcp.mjs tools
//   node probe/mcp.mjs call list_companions
//   node probe/mcp.mjs call lua '{"companion":"名字","code":"return numen.status.self()"}'
//   node probe/mcp.mjs lua 'return numen.api.help("numen.task")'
//
// 只读：本脚本不写任何 mod 文件；是否会改变游戏状态取决于你传的 code。
import fs from 'node:fs';

const CFG_PATH =
  'E:/game/HMCL/.minecraft/versions/1.21.1-NeoForge/config/numen/mcp_server.json';
const OVERRIDE = process.env.MCP_URL || null;
const cfg = OVERRIDE
  ? { host: '', port: 0, token: '' }
  : JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const ENDPOINT = OVERRIDE || `http://${cfg.host}:${cfg.port}/mcp`;
const TIMEOUT_MS = Number(process.env.NUMEN_TIMEOUT_MS || 180_000);

let sessionId = null;
let seq = 1;

function parsePayloads(text) {
  const out = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try { out.push(JSON.parse(trimmed)); } catch { /* ignore */ }
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload) continue;
    try { out.push(JSON.parse(payload)); } catch { /* ignore */ }
  }
  return out;
}

async function post(body) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(method, params) {
  const id = seq++;
  const { status, text } = await post({ jsonrpc: '2.0', id, method, params });
  const payloads = parsePayloads(text);
  const hit = payloads.find((p) => p && p.id === id);
  if (!hit) {
    throw new Error(`no matching response (http ${status})\nraw: ${text.slice(0, 1200)}`);
  }
  if (hit.error) throw new Error(`RPC error: ${JSON.stringify(hit.error)}`);
  return hit.result;
}

async function handshake() {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'numen-tree-probe', version: '0.1.0' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return init;
}

function render(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);

  const init = await handshake();
  console.error('[server]', init.serverInfo?.name, init.serverInfo?.version);

  if (cmd === 'tools') {
    const r = await rpc('tools/list', {});
    for (const t of r.tools || []) {
      console.log(`- ${t.name}(${(t.inputSchema?.required || []).join(', ')})`);
    }
    return;
  }

  if (cmd === 'callfile') {
    const name = a;
    const args = JSON.parse(fs.readFileSync(b, 'utf8'));
    const r = await rpc('tools/call', { name, arguments: args });
    console.log(render(r?.content?.[0]?.text ?? r));
    return;
  }

  if (cmd === 'call') {
    const name = a;
    const args = b ? JSON.parse(b) : {};
    const r = await rpc('tools/call', { name, arguments: args });
    console.log(render(r?.content?.[0]?.text ?? r));
    return;
  }

  if (cmd === 'luafile') {
    const code = fs.readFileSync(a, 'utf8');
    const companions = JSON.parse(process.env.NUMEN_COMPANIONS || '[]');
    const companion = process.env.NUMEN_COMPANION || companions[0];
    if (!companion) throw new Error('需要 NUMEN_COMPANION');
    const started = Date.now();
    const r = await rpc('tools/call', {
      name: 'lua',
      arguments: { companion, code },
    });
    const ms = Date.now() - started;
    console.log(render(r?.content?.[0]?.text ?? r));
    console.error(`[elapsed] ${ms} ms`);
    return;
  }

  if (cmd === 'lua') {
    const code = a;
    const companions = JSON.parse(
      process.env.NUMEN_COMPANIONS || '[]',
    );
    const companion = process.env.NUMEN_COMPANION || companions[0];
    if (!companion) throw new Error('需要 NUMEN_COMPANION 或先跑 call list_companions');
    const started = Date.now();
    const r = await rpc('tools/call', {
      name: 'lua',
      arguments: { companion, code },
    });
    const ms = Date.now() - started;
    console.log(render(r?.content?.[0]?.text ?? r));
    console.error(`[elapsed] ${ms} ms`);
    return;
  }

  console.error('usage: tools | call <tool> [json] | lua <code>');
  process.exit(2);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

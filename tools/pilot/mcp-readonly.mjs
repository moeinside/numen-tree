/**
 * 只读 numen MCP 客户端（preflight 用）
 * 只做 initialize + tools/list；不调 lua/不写状态。
 */
import fs from 'node:fs';

const CFG_PATH =
  'E:/game/HMCL/.minecraft/versions/1.21.1-NeoForge/config/numen/mcp_server.json';

function loadCfg() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  return {
    endpoint: `http://${cfg.host || '127.0.0.1'}:${cfg.port || 8765}/mcp`,
    token: cfg.token || '',
  };
}

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

export async function numenTools({ timeoutMs = 5000 } = {}) {
  const { endpoint, token } = loadCfg();
  let sessionId = null;
  let seq = 1;

  async function post(body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return { status: res.status, text: await res.text() };
  }

  async function rpc(method, params) {
    const id = seq++;
    const { text, status } = await post({ jsonrpc: '2.0', id, method, params });
    const hit = parsePayloads(text).find((p) => p && p.id === id);
    if (!hit) throw new Error(`no response (http ${status})`);
    if (hit.error) throw new Error(JSON.stringify(hit.error));
    return hit.result;
  }

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'pilot-preflight', version: '0.1.0' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await rpc('tools/list', {});
  return {
    endpoint,
    server: init?.serverInfo ?? null,
    tools: (tools.tools || []).map((t) => ({
      name: t.name,
      required: t.inputSchema?.required || [],
    })),
  };
}

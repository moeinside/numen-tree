/**
 * numen MCP 客户端（pilot 用）
 * - initialize / tools/list / tools/call
 * - streamable HTTP + session
 * - 只负责传输；不决定动作
 */
import fs from 'node:fs';

const CFG_PATH =
  'E:/game/HMCL/.minecraft/versions/1.21.1-NeoForge/config/numen/mcp_server.json';

function loadCfg() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  return {
    endpoint:
      process.env.NUMEN_MCP_URL ||
      `http://${cfg.host || '127.0.0.1'}:${cfg.port || 8765}/mcp`,
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

function maybeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function createNumenClient({ timeoutMs = 120_000 } = {}) {
  const { endpoint, token } = loadCfg();
  let sessionId = null;
  let seq = 1;

  async function post(body, { timeout = timeoutMs } = {}) {
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
      signal: AbortSignal.timeout(timeout),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return text;
  }

  async function rpc(method, params, opts) {
    const id = seq++;
    const text = await post({ jsonrpc: '2.0', id, method, params }, opts);
    const hit = parsePayloads(text).find((p) => p && p.id === id);
    if (!hit) throw new Error(`MCP no matching response: ${text.slice(0, 500)}`);
    if (hit.error) throw new Error(`MCP RPC error: ${JSON.stringify(hit.error)}`);
    return hit.result;
  }

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'numen-pilot', version: '0.1.0' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  async function toolsList() {
    const r = await rpc('tools/list', {});
    return r.tools || [];
  }

  async function callTool(name, args) {
    const started = Date.now();
    const r = await rpc('tools/call', { name, arguments: args || {} });
    const text = r?.content?.map((c) => c?.text ?? '').join('\n') ?? '';
    return {
      name,
      args: args || {},
      ok: !r?.isError,
      isError: !!r?.isError,
      text,
      json: maybeJson(text),
      raw: r,
      ms: Date.now() - started,
    };
  }

  return {
    endpoint,
    server: init?.serverInfo ?? null,
    sessionId: () => sessionId,
    toolsList,
    callTool,
    // 只读便捷
    async listCompanions() {
      return callTool('list_companions', {});
    },
    async getEvents(companion) {
      return callTool('get_events', { companion });
    },
  };
}

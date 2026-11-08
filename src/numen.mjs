/**
 * numen MCP 客户端（streamable HTTP / JSON-RPC）
 *
 * 只做三件事：建会话、调工具、把 lua 回执解析成结构化结果。
 * 所有"业务判断"都不在这里。
 */

const PROTOCOL_VERSION = '2025-06-18';

function parsePayloads(text) {
  const out = [];
  const trimmed = (text || '').trim();
  if (!trimmed) return out;
  if (trimmed.startsWith('{')) {
    try {
      out.push(JSON.parse(trimmed));
      return out;
    } catch {
      /* fall through */
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload) continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * 把 lua 工具回执解析成结构化结果。
 *
 * 回执形态（实测）：
 *   ok · 5 calls · 0 s
 *   stderr:
 *   ...
 *   returned: {"ok":1,...}
 *   your owner spoke; t3 keeps running. Nothing after that ran.
 *   The script stopped at line 3 after 1 call: no_function — ...
 */
export function parseLuaReceipt(text) {
  const raw = (text || '').trim();

  const ret = raw.match(/returned:\s*([\s\S]*)$/);
  if (ret) {
    const body = ret[1].trim();
    let value = body;
    try {
      value = JSON.parse(body);
    } catch {
      /* 保持字符串 */
    }
    return { kind: 'returned', value, raw };
  }

  if (/keeps running/i.test(raw)) {
    const m = raw.match(/\b(t\d+)\b/);
    return { kind: 'detached', taskId: m ? m[1] : null, message: raw, raw };
  }

  const stopped = raw.match(/^The script stopped at line (\d+)/);
  if (stopped) {
    return { kind: 'error', line: Number(stopped[1]), message: raw, raw };
  }

  return { kind: 'text', message: raw, raw };
}

/** 把 <events> 文本解析成事件数组。 */
export function parseEvents(text) {
  const raw = (text || '').trim();
  if (!raw || /no new events/i.test(raw)) return [];

  const out = [];
  const push = (kind, attrs, message) => {
    out.push({ kind, ...attrs, message: (message || '').trim() });
  };

  // 事件：<event kind="..." a="b" ...>message</event>
  const evRe = /<event\s+([^>]*)>([\s\S]*?)<\/event>/g;
  let m;
  while ((m = evRe.exec(raw))) {
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2];
    push(attrs.kind || 'event', attrs, m[2]);
  }

  // 主人说话：<query>...</query>
  const qRe = /<query>([\s\S]*?)<\/query>/g;
  while ((m = qRe.exec(raw))) push('owner_query', {}, m[1]);

  return out;
}

export class NumenClient {
  #sessionId = null;
  #seq = 1;
  #endpoint;
  #token;
  #defaultTimeoutMs;

  /** 每次建立 MCP 会话 +1。游戏换档/重启会换新会话，用它当"世界可能变了"的信号。 */
  sessionGeneration = 0;
  #lastConnectAt = 0;
  // 注意：numen 的响应不一定回 Mcp-Session-Id 头，不能用 #sessionId 判断"是否已连接"，
  // 否则每次调用都会重新 initialize，造成重连风暴。
  #connected = false;

  constructor({ endpoint, token, callTimeoutSeconds = 300 }) {
    this.#endpoint = endpoint;
    this.#token = token;
    this.#defaultTimeoutMs = Math.max(5, callTimeoutSeconds - 5) * 1000;
  }

  #headers() {
    const h = {
      Authorization: `Bearer ${this.#token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.#sessionId) h['Mcp-Session-Id'] = this.#sessionId;
    return h;
  }

  async #post(body, timeoutMs = this.#defaultTimeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.#endpoint, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.#sessionId = sid;
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  async #rpc(method, params, timeoutMs) {
    const id = this.#seq++;
    const { status, text } = await this.#post(
      { jsonrpc: '2.0', id, method, params },
      timeoutMs,
    );
    const hit = parsePayloads(text).find((p) => p && p.id === id);
    if (!hit) {
      throw new Error(`MCP 无响应（http ${status}）：${text.slice(0, 400)}`);
    }
    if (hit.error) throw new Error(`MCP 错误：${JSON.stringify(hit.error)}`);
    return hit.result;
  }

  async connect() {
    this.#sessionId = null;
    const init = await this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'numen-tree', version: '0.1.0' },
    });
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // 只有真正建成会话才算数（失败不 +1，否则会误判成换档）
    this.#connected = true;
    this.sessionGeneration += 1;
    this.#lastConnectAt = Date.now();
    return init;
  }

  async #ensure() {
    if (!this.#connected) await this.connect();
  }

  async #tool(name, args, timeoutMs, { retry = true } = {}) {
    await this.#ensure();
    try {
      return await this.#rpc('tools/call', { name, arguments: args }, timeoutMs);
    } catch (e) {
      const msg = String(e?.message || e);
      // 只有"传输层/会话"类错误才重连；业务错误（工具报错）原样抛回去
      const transportish =
        /MCP 无响应/.test(msg) ||
        /fetch failed|aborted|ECONNREFUSED|socket|terminated|network|session|not initialized/i.test(msg);
      if (!transportish || !retry) throw e;

      // 防重连风暴：2 秒内只重连一次
      const now = Date.now();
      if (now - this.#lastConnectAt < 2000) throw e;
      this.#connected = false;
      this.#sessionId = null;
      await this.connect();
      return await this.#rpc('tools/call', { name, arguments: args }, timeoutMs);
    }
  }

  async listCompanions() {
    const r = await this.#tool('list_companions', {});
    const text = r?.content?.[0]?.text || '';
    const out = [];
    const re = /^-\s+(\S+)\s+\(id:\s*([0-9a-f-]{36})\)/gim;
    let m;
    while ((m = re.exec(text))) out.push({ name: m[1], id: m[2] });
    return { companions: out, text };
  }

  /**
   * 执行一段 Lua 程序。
   *
   * 铁律（僵尸锁的唯一防线）：**客户端绝不放弃在途的 lua 调用，也绝不重试**。
   * 一旦本端 abort 掉 HTTP 请求，游戏里的程序还在跑、结果却没人收，
   * 就变成"槽位被占"的僵尸锁，只能重启游戏。
   * 所以：超时只返回 kind='timeout' 让树去观测，不重连、不重发。
   */
  async lua(companion, code, timeoutMs) {
    let r;
    try {
      r = await this.#tool('lua', { companion, code }, timeoutMs, { retry: false });
    } catch (e) {
      const msg = String(e?.message || e);
      if (/aborted|timeout|无响应/i.test(msg)) {
        return {
          kind: 'timeout',
          message: `等回执超时（${Math.round(timeoutMs / 1000)}s）：游戏里的程序可能仍在后台跑，先观测再决定。`,
          raw: msg,
        };
      }
      throw e;
    }
    const text = r?.content?.[0]?.text ?? '';
    return parseLuaReceipt(text);
  }

  async events(companion, waitSeconds = 0) {
    const r = await this.#tool(
      'get_events',
      { companion, wait_seconds: waitSeconds },
      (waitSeconds + 30) * 1000,
    );
    const text = r?.content?.[0]?.text ?? '';
    return { events: parseEvents(text), text };
  }

  async say(companion, text) {
    const r = await this.#tool('say', { companion, text });
    return r?.content?.[0]?.text ?? '';
  }

  /** 透传任意 numen 工具（供 say / memory 这类不占 Lua 槽的接口用）。 */
  async callTool(name, args, timeoutMs) {
    const r = await this.#tool(name, args, timeoutMs);
    return r?.content?.[0]?.text ?? '';
  }
}

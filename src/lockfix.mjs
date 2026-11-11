/**
 * Numen 僵尸锁外部清理客户端（对接 `patcher/` 补丁 v3 的本地控制端口）。
 *
 * 背景：numen 的 ServerPrograms.RUNNING 是 JVM 静态表；程序没正常结束就会把同伴 UUID
 * 永久留在表里，之后 lua 调用一律被拒（"a program is already running..."）。
 * 补丁 v3 在游戏进程里监听 `127.0.0.1:8768`，提供：
 *   GET  /status                     → 补丁版本 / 反射是否找到类 / 当前锁条目
 *   POST /unlock?uuid=<uuid>         → 清一个同伴的锁
 *   POST /unlock?all=1               → 清全部锁
 *   POST /reset-brain?uuid=<uuid>    → 清内置脑/任务槽（v1.2 新增，不删实体/不丢背包）
 *   POST /reset-brain?all=1          → 清所有同伴的内置脑/任务槽
 *
 * 这是"外部手段"：不需要玩家在游戏里敲命令，也不需要重建同伴（不丢背包）。
 * 树侧只在**报错两次**后自动调用 unlock；reset-brain 只在显式请求时使用。
 */

export class LockFixClient {
  constructor({ host = '127.0.0.1', port = 8768, timeoutMs = 2500 } = {}) {
    this.host = host;
    this.port = Number(port) || 8768;
    this.timeoutMs = Math.max(200, Number(timeoutMs) || 2500);
    this.last = null; // 最近一次响应（给 status 展示/排障）
  }

  get base() {
    return `http://${this.host}:${this.port}`;
  }

  async #request(path, { method = 'GET' } = {}) {
    const url = `${this.base}${path}`;
    try {
      const res = await fetch(url, {
        method,
        signal: AbortSignal.timeout ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: `响应不是 JSON：${String(text).slice(0, 120)}` };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
      this.last = data;
      return data;
    } catch (e) {
      const error =
        e?.name === 'TimeoutError' ? `补丁 ${this.base} 响应超时` : `连不上补丁 ${this.base}（游戏没重启加载 v3？）`;
      return { ok: false, error, detail: String(e?.message || e) };
    }
  }

  /** 补丁状态：{ok, patch, foundClass, count, running[]} */
  async status() {
    return this.#request('/status');
  }

  /** 清锁：{ok, cleared}；uuid 为空且 all=false 时直接拒绝，避免误清。 */
  async unlock({ uuid = null, all = false } = {}) {
    const q = new URLSearchParams();
    if (all) q.set('all', '1');
    else if (uuid) q.set('uuid', String(uuid));
    else return { ok: false, error: 'unlock 需要 uuid 或 all=1' };
    return this.#request(`/unlock?${q.toString()}`, { method: 'POST' });
  }

  /** 清内置脑/任务槽（v1.2）：{ok, reset, players}；不删实体、不丢背包。 */
  async resetBrain({ uuid = null, all = false } = {}) {
    const q = new URLSearchParams();
    if (all) q.set('all', '1');
    else if (uuid) q.set('uuid', String(uuid));
    else return { ok: false, error: 'reset-brain 需要 uuid 或 all=1' };
    return this.#request(`/reset-brain?${q.toString()}`, { method: 'POST' });
  }
}

/** 从配置建客户端；`behavior.lockRecovery.enabled=false` → null（完全关闭）。 */
export function lockFixFromConfig(cfg) {
  const rc = cfg?.behavior?.lockRecovery || {};
  if (rc.enabled === false) return null;
  return new LockFixClient({
    host: rc.host || '127.0.0.1',
    port: rc.port ?? 8768,
    timeoutMs: rc.timeoutMs ?? 2500,
  });
}

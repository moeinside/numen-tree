/**
 * Numen Tree Tentacle 客户端：只读具身感知（127.0.0.1:8769）。
 * mod 不在/没重启游戏时优雅失败，树继续用 numen MCP。
 */
import { dayPhase, PHASE_LABELS } from './time.mjs';

export class TentacleClient {
  constructor({ host = '127.0.0.1', port = 8769, timeoutMs = 2500 } = {}) {
    this.host = host;
    this.port = Number(port) || 8769;
    this.timeoutMs = Math.max(200, Number(timeoutMs) || 2500);
  }

  get base() {
    return `http://${this.host}:${this.port}`;
  }

  async #get(path) {
    try {
      const res = await fetch(`${this.base}${path}`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, error: `响应不是 JSON：${String(text).slice(0, 120)}` };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
      return data;
    } catch (e) {
      return {
        ok: false,
        error: `连不上触手 ${this.base}（mod 没装/游戏没重启/端口未监听）`,
        detail: String(e?.message || e),
      };
    }
  }

  async health() {
    return this.#get('/health');
  }

  async perception({ uuid, radius = 16, limit = 20, fov = 100 } = {}) {
    if (!uuid) return { ok: false, error: 'perception 需要 uuid' };
    const q = new URLSearchParams({ uuid: String(uuid), radius: String(radius), limit: String(limit), fov: String(fov) });
    return this.#get(`/perception?${q.toString()}`);
  }
}

export function tentacleFromConfig(cfg) {
  const t = cfg?.tentacle || cfg?.behavior?.tentacle || {};
  if (t.enabled === false) return null;
  return new TentacleClient({
    host: t.host || '127.0.0.1',
    port: t.port ?? 8769,
    timeoutMs: t.timeoutMs ?? 2500,
  });
}

/** 把触手原始感知压成 LLM 可读的小摘要（保守，默认不倾倒列表）。 */
export function summarizePerception(p, { detail = 'brief' } = {}) {
  if (!p?.ok) return { ok: false, error: p?.error || 'no perception' };
  const self = p.self || {};
  const entities = Array.isArray(p.entities) ? p.entities : [];
  const hostiles = entities.filter((e) => e.category === 'hostile');
  const animals = entities.filter((e) => e.category === 'animal');
  const landmarks = Array.isArray(p.landmarks) ? p.landmarks : [];
  const nearest = (arr) => arr.slice().sort((a, b) => Number(a.distance) - Number(b.distance))[0] || null;
  const out = {
    ok: true,
    source: 'tentacle',
    self: {
      hp: self.hp,
      food: self.food,
      pos: { x: self.x, y: self.y, z: self.z },
      yaw: self.yaw,
      light: self.light,
      day: self.day,
      day_time: self.day_time,
      phase: dayPhase(self.day_time),
      phase_label: PHASE_LABELS[dayPhase(self.day_time)] || null,
    },
    terrain: p.terrain
      ? {
          in_water: p.terrain.in_water,
          in_lava: p.terrain.in_lava,
          on_ground: p.terrain.on_ground,
          feet: p.terrain.feet,
          head: p.terrain.head,
          above: p.terrain.above,
          below: p.terrain.below,
          standable_dirs: (p.terrain.dirs || []).filter((d) => d.standable),
        }
      : null,
    water: p.water || null,
    threat: {
      hostileCount: hostiles.length,
      nearest: nearest(hostiles),
    },
    animals: { count: animals.length, nearest: nearest(animals) },
    landmarks: {
      counts: landmarks.reduce((acc, l) => ((acc[l.kind] = (acc[l.kind] || 0) + 1), acc), {}),
      nearest: landmarks.slice(0, 3),
    },
    limits: p.limits,
  };
  if (detail === 'entities') out.entities = entities.slice(0, 10);
  if (detail === 'landmarks') out.landmarks = landmarks.slice(0, 15);
  return out;
}

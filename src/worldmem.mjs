import fs from 'node:fs';
import path from 'node:path';

/**
 * 世界记忆（world.json）—— **纯存储 + 距离排序**。
 *
 * 设计边界（和 places.mjs 一致，别破坏）：
 *  - 只做"记住 / 按距离查回 / 忘掉"，**不读游戏、不联网、不做价值判断**；
 *  - 判断"该不该去这个箱子/这片林"是计划层（plan/lane）的事，这里只给事实；
 *  - 每次写盘都是 `.tmp + rename` 原子替换；文件不存在 / JSON 坏掉只降级为空簿，不抛；
 *  - 上限：容器 200 条、资源点 300 条，超了**先删旧的**（按 updatedAt，缺失时间视为最老）；
 *  - 同维度同坐标（三维欧氏距离 ≤ 1 格）视为同一个东西，覆盖更新而不是重复记。
 *
 * 存储格式（world.json）：
 * {
 *   "version": 1,
 *   "seq": 3,                     // 记住次数（单调计数，给未来排序/调试留的）
 *   "containers": [
 *     { "dimension": "minecraft:overworld",
 *       "pos": { "x": 120, "y": 64, "z": -35 },
 *       "contents": [ { "item": "minecraft:oak_log", "count": 8 } ],
 *       "note": "", "companion": "tyrander", "updatedAt": "ISO" }
 *   ],
 *   "resources": [
 *     { "kind": "wood|ore|animal|water|chest|poi",
 *       "dimension": "minecraft:overworld",
 *       "pos": { "x": 10.5, "y": 70, "z": 3 },
 *       "note": "", "updatedAt": "ISO" }
 *   ]
 * }
 */

export const RESOURCE_KINDS = ['wood', 'ore', 'animal', 'water', 'chest', 'poi'];
export const DEFAULT_MAX_CONTAINERS = 200;
export const DEFAULT_MAX_RESOURCES = 300;
/** 同一坐标的容差（格）：三维欧氏距离 ≤ 这个值就算同一个箱子/资源点。 */
export const SAME_POS_TOLERANCE = 1;

function normalizeDimension(dimension) {
  if (dimension == null) return null;
  const s = String(dimension).trim();
  return s || null;
}

/** 同维度判断：两边都缺省算同维度；一边缺省一边有值不算。忽略大小写。 */
function sameDimension(a, b) {
  const na = normalizeDimension(a);
  const nb = normalizeDimension(b);
  if (na === null || nb === null) return na === nb;
  return na.toLowerCase() === nb.toLowerCase();
}

/** 坐标归一化：数字对象或 "x,y,z" 字符串；保留 2 位小数。非法返回 null。 */
function normalizePos(pos) {
  let x;
  let y;
  let z;
  if (typeof pos === 'string') {
    const parts = pos.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 3) return null;
    [x, y, z] = parts;
  } else if (pos && typeof pos === 'object') {
    x = Number(pos.x);
    y = Number(pos.y);
    z = Number(pos.z);
  } else {
    return null;
  }
  if (![x, y, z].every(Number.isFinite)) return null;
  const round = (n) => Math.round(n * 100) / 100;
  return { x: round(x), y: round(y), z: round(z) };
}

/** 三维欧氏距离；任一坐标非法返回 null（调用方自己先判断 dimension）。 */
export function distanceBetween(a, b) {
  const pa = normalizePos(a);
  const pb = normalizePos(b);
  if (!pa || !pb) return null;
  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;
  const dz = pa.z - pb.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function timestampOf(entry) {
  const t = Date.parse(entry?.updatedAt);
  return Number.isFinite(t) ? t : 0;
}

/** 容器内容归一化：只保留 {item,count}，丢弃空 item；count 保留原数值（拿不到就 0）。 */
function normalizeContents(contents) {
  if (!Array.isArray(contents)) return [];
  const out = [];
  for (const c of contents) {
    if (!c || typeof c !== 'object') continue;
    const item = String(c.item ?? '').trim();
    if (!item) continue;
    const n = Number(c.count);
    out.push({ item, count: Number.isFinite(n) ? n : 0 });
  }
  return out;
}

/** kind 只认白名单；写了别的（或没写）按 poi 记，不让一条脏数据挡住整本记忆。 */
export function normalizeResourceKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase();
  return RESOURCE_KINDS.includes(k) ? k : 'poi';
}

function normalizeContainerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const pos = normalizePos(entry.pos);
  if (!pos) return null;
  return {
    dimension: normalizeDimension(entry.dimension),
    pos,
    contents: normalizeContents(entry.contents),
    note: String(entry.note ?? ''),
    companion: entry.companion == null ? null : String(entry.companion),
    updatedAt: String(entry.updatedAt ?? ''),
  };
}

function normalizeResourceEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const pos = normalizePos(entry.pos);
  if (!pos) return null;
  return {
    kind: normalizeResourceKind(entry.kind),
    dimension: normalizeDimension(entry.dimension),
    pos,
    note: String(entry.note ?? ''),
    updatedAt: String(entry.updatedAt ?? ''),
  };
}

function cloneContainer(entry) {
  if (!entry) return null;
  return {
    dimension: entry.dimension,
    pos: { ...entry.pos },
    contents: entry.contents.map((c) => ({ ...c })),
    note: entry.note,
    companion: entry.companion,
    updatedAt: entry.updatedAt,
  };
}

function cloneResource(entry) {
  if (!entry) return null;
  return {
    kind: entry.kind,
    dimension: entry.dimension,
    pos: { ...entry.pos },
    note: entry.note,
    updatedAt: entry.updatedAt,
  };
}

/** 超过上限时按 updatedAt 从旧到新删（同一时间按数组顺序，前面的更老）。 */
function trimOldest(list, maxEntries) {
  const over = list.length - maxEntries;
  if (over <= 0) return list;
  const removable = list
    .map((entry, index) => ({ index, updated: timestampOf(entry) }))
    .sort((a, b) => a.updated - b.updated || a.index - b.index);
  const drop = new Set(removable.slice(0, over).map((x) => x.index));
  return list.filter((_, i) => !drop.has(i));
}

/** 同维度 + 同坐标（≤1 格）的条目下标；没有返回 -1。 */
function findSameIndex(list, dimension, pos) {
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!sameDimension(e.dimension, dimension)) continue;
    const d = distanceBetween(e.pos, pos);
    if (d != null && d <= SAME_POS_TOLERANCE + 1e-9) return i;
  }
  return -1;
}

export class WorldMemory {
  /**
   * @param {object} opts
   * @param {string} opts.file          world.json 的绝对路径
   * @param {object} [opts.trace]       可选，有 .info/.warn 就用来留痕
   * @param {number} [opts.maxContainers] 容器上限，默认 200
   * @param {number} [opts.maxResources]  资源点上限，默认 300
   */
  constructor({ file, trace, maxContainers, maxResources } = {}) {
    this.file = file ? path.resolve(String(file)) : path.resolve('world.json');
    this.trace = trace || null;
    this.version = 1;
    this.seq = 0;
    this.containers = [];
    this.resources = [];
    this.maxContainers = Number.isFinite(Number(maxContainers))
      ? Math.max(1, Math.floor(Number(maxContainers)))
      : DEFAULT_MAX_CONTAINERS;
    this.maxResources = Number.isFinite(Number(maxResources))
      ? Math.max(1, Math.floor(Number(maxResources)))
      : DEFAULT_MAX_RESOURCES;
    // 构造时静默读一次：即使调用方忘了 load()，也不会用空簿覆盖已有文件。
    this.#load(true);
  }

  #trace(level, kind, data) {
    try {
      this.trace?.[level]?.(kind, data);
    } catch {
      /* trace 失败不能影响主流程 */
    }
  }

  #load(silent = false) {
    this.containers = [];
    this.resources = [];
    this.seq = 0;
    try {
      if (!fs.existsSync(this.file)) {
        if (!silent) this.#trace('info', 'worldmem_loaded', { note: '世界记忆为空（文件不存在）' });
        return this;
      }
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('顶层不是对象');
      }
      const seq = Number(data.seq);
      this.seq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
      const containers = Array.isArray(data.containers) ? data.containers : [];
      const resources = Array.isArray(data.resources) ? data.resources : [];
      this.containers = containers.map(normalizeContainerEntry).filter(Boolean);
      this.resources = resources.map(normalizeResourceEntry).filter(Boolean);
      this.#trim();
      if (!silent) {
        this.#trace('info', 'worldmem_loaded', {
          note: `${this.containers.length} 个容器 / ${this.resources.length} 个资源点（seq=${this.seq}）`,
        });
      }
    } catch (e) {
      // 坏文件不抛：降级成空簿，留一条 warn 供排查
      this.containers = [];
      this.resources = [];
      this.seq = 0;
      this.#trace('warn', 'worldmem_load_failed', {
        note: `读世界记忆失败，按空簿继续：${String(e?.message || e)}`,
      });
    }
    return this;
  }

  /** 读文件；不存在 / 坏掉就空簿，不抛。返回 this 方便链式 .load()。 */
  load() {
    return this.#load(false);
  }

  /** 原子写回：先写 .tmp，再 rename 覆盖。失败只留 warn，不抛。 */
  save() {
    try {
      this.#trim();
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = {
        version: this.version,
        seq: this.seq,
        containers: this.containers,
        resources: this.resources,
      };
      const tmp = `${this.file}.tmp`;
      // UTF-8、不带 BOM、换行收尾（方便人看 / diff）
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.#trace('warn', 'worldmem_save_failed', {
        note: `写世界记忆失败（内存里仍保留）：${String(e?.message || e)}`,
      });
      return false;
    }
  }

  #trim() {
    this.containers = trimOldest(this.containers, this.maxContainers);
    this.resources = trimOldest(this.resources, this.maxResources);
  }

  /** { containers, resources } 条数。 */
  get size() {
    return { containers: this.containers.length, resources: this.resources.length };
  }

  /**
   * 记一个容器（箱子/木桶）及其内容。
   * contents: [{ item, count }]；拿不到内容就传 []（不猜）。
   * 同维度同坐标（≤1 格）覆盖更新；坐标非法返回 null（调用方应先校验观测）。
   */
  rememberContainer({ dimension, pos, contents, note, companion } = {}) {
    const p = normalizePos(pos);
    if (!p) {
      this.#trace('warn', 'worldmem_bad_pos', { note: `rememberContainer 坐标非法：${JSON.stringify(pos)}` });
      return null;
    }
    const dim = normalizeDimension(dimension);
    const entry = {
      dimension: dim,
      pos: p,
      contents: normalizeContents(contents),
      note: String(note ?? ''),
      companion: companion == null ? null : String(companion),
      updatedAt: new Date().toISOString(),
    };
    const idx = findSameIndex(this.containers, dim, p);
    if (idx >= 0) this.containers[idx] = entry;
    else this.containers.push(entry);
    this.seq += 1;
    this.#trim();
    this.save();
    return cloneContainer(entry);
  }

  /** 同维度、maxDistance 内的容器，近→远，每条带 distance（米）。坐标非法返回 []。 */
  containersNear({ dimension, pos, maxDistance = 48 } = {}) {
    const p = normalizePos(pos);
    if (!p) return [];
    const limit = Number.isFinite(Number(maxDistance)) ? Math.max(0, Number(maxDistance)) : 48;
    const out = [];
    for (const entry of this.containers) {
      if (!sameDimension(entry.dimension, dimension)) continue;
      const d = distanceBetween(p, entry.pos);
      if (d == null || d > limit) continue;
      out.push({ ...cloneContainer(entry), distance: round2(d) });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** 忘掉同维度同坐标（≤1 格）的容器；真删了返回 true。 */
  forgetContainer({ dimension, pos } = {}) {
    const p = normalizePos(pos);
    if (!p) return false;
    const idx = findSameIndex(this.containers, normalizeDimension(dimension), p);
    if (idx < 0) return false;
    this.containers.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * 记一个资源点。kind: 'wood'|'ore'|'animal'|'water'|'chest'|'poi'（其它按 poi）。
   * 同维度同坐标（≤1 格）覆盖更新（kind 也一起更新）；坐标非法返回 null。
   */
  rememberResource({ kind, dimension, pos, note } = {}) {
    const p = normalizePos(pos);
    if (!p) {
      this.#trace('warn', 'worldmem_bad_pos', { note: `rememberResource 坐标非法：${JSON.stringify(pos)}` });
      return null;
    }
    const dim = normalizeDimension(dimension);
    const entry = {
      kind: normalizeResourceKind(kind),
      dimension: dim,
      pos: p,
      note: String(note ?? ''),
      updatedAt: new Date().toISOString(),
    };
    const idx = findSameIndex(this.resources, dim, p);
    if (idx >= 0) this.resources[idx] = entry;
    else this.resources.push(entry);
    this.seq += 1;
    this.#trim();
    this.save();
    return cloneResource(entry);
  }

  /**
   * 同维度、maxDistance 内的资源点，近→远，每条带 distance（米）。
   * kind 给了就只看这一类；坐标非法返回 []。
   */
  resourcesNear({ dimension, pos, maxDistance = 96, kind } = {}) {
    const p = normalizePos(pos);
    if (!p) return [];
    const limit = Number.isFinite(Number(maxDistance)) ? Math.max(0, Number(maxDistance)) : 96;
    const wantKind = kind == null || kind === '' ? null : normalizeResourceKind(kind);
    const out = [];
    for (const entry of this.resources) {
      if (!sameDimension(entry.dimension, dimension)) continue;
      if (wantKind != null && entry.kind !== wantKind) continue;
      const d = distanceBetween(p, entry.pos);
      if (d == null || d > limit) continue;
      out.push({ ...cloneResource(entry), distance: round2(d) });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }
}

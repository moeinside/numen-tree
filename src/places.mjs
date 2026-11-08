import fs from 'node:fs';
import path from 'node:path';

/**
 * 地点簿（纯数据 + 机械模糊解析）。
 *
 * 设计边界（别破坏）：
 *  - 只做"记住 / 查回"，**不做价值判断、不联网、不读游戏状态**；
 *  - 解析是查表式的固定顺序：精确 id/名称 → 时间词 → 别名 → 名称/备注子串 → null；
 *  - 每次写盘都是 `.tmp + rename` 原子替换；文件不存在 / 坏掉只降级为空簿，不抛；
 *  - 上限 500 条，超出先删旧的，`kind=base` 的优先保留。
 *
 * 存储格式（places.json）：
 * {
 *   "version": 1,
 *   "seq": 3,
 *   "places": [
 *     { "id": "p1", "name": "基地", "kind": "base",
 *       "dimension": "minecraft:overworld",
 *       "pos": { "x": -95.5, "y": 64, "z": 60.5 },
 *       "note": "", "source": "tree|llm|cli",
 *       "companion": "tyrander", "createdAt": "ISO" }
 *   ]
 * }
 */

export const PLACE_KINDS = ['base', 'death', 'owner', 'poi', 'custom'];
export const DEFAULT_MAX_ENTRIES = 500;

const KIND_LABELS = {
  base: '基地',
  death: '死亡点',
  owner: '主人位置',
  poi: '地点',
  custom: '地点',
};

const SOURCES = ['tree', 'llm', 'cli'];

/**
 * 别名表（中英都覆盖，允许子串命中）。
 * strong = 明确名词，权重 2；weak = 代词/指示词，权重 1。
 * 同类多条命中时取"更长 / 权重更高"的那个，冲突再用 KIND_PRIORITY 决。
 */
const ALIASES = {
  base: {
    strong: ['家', '基地', '老巢', '营地', '据点', '老窝', 'home', 'base', 'camp'],
    weak: [],
  },
  death: {
    strong: [
      '死亡', '死了', '挂了', '尸体', '上次死', '最后死',
      '死', '坟', 'death', 'died', 'dead', 'grave', 'corpse',
    ],
    weak: [],
  },
  owner: {
    strong: ['主人', '老板', 'owner', 'master'],
    weak: ['自己', '你', '我', 'me'],
  },
  poi: {
    strong: ['地方', '地点', '位置', 'place', 'spot', 'poi'],
    weak: ['那儿', '那里', '这儿', '这里', '那边', '这边'],
  },
};

/** 同一轮命中多个类型时的优先级：死 > 基地 > 主人 > 地点。 */
const KIND_PRIORITY = ['death', 'base', 'owner', 'poi'];

/** 时间词：取同类（或全部）最新一条。长的放前面，why 里显示命中的原词。 */
const TIME_WORDS = [
  '最近一次', '最后一次',
  '上一次', '刚才', '刚刚', '上次', '最后', '最近',
  'latest', 'recent', 'last',
];

/** "最近/附近"这类词：给了 near 坐标时按距离，而不是按时间。 */
const SPATIAL_WORDS = ['最近', '附近', '近的', 'nearest', 'near', 'closest'];

const ASCII_RE = /^[a-z][a-z ]*$/;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 归一化：去首尾空白、全角转半角、大小写不敏感。
 * 全角标点也一起转（"："→":"），方便英文别名边界判断。
 */
export function normalizeText(input) {
  let s = String(input ?? '');
  // 全角 ASCII（！到 ～）转半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  s = s.replace(/\u3000/g, ' ');
  return s.trim().toLowerCase();
}

/** 别名是否命中：英文按"词边界"匹配（避免 me 命中 somewhere），中文按子串。 */
function aliasIn(text, alias) {
  if (!alias || !text) return false;
  if (ASCII_RE.test(alias)) {
    const re = new RegExp(`(^|[^a-z])${escapeRe(alias)}([^a-z]|$)`);
    return re.test(text);
  }
  return text.includes(alias);
}

/** 扫描文本里的所有类型命中，按 权重→类型优先级→别名长度 排序返回。 */
function scanAliases(text, { strongOnly = false } = {}) {
  const q = normalizeText(text);
  if (!q) return [];
  const hits = [];
  for (const [kind, spec] of Object.entries(ALIASES)) {
    let best = null;
    const groups = strongOnly ? [[2, spec.strong]] : [[2, spec.strong], [1, spec.weak]];
    for (const [weight, aliases] of groups) {
      for (const alias of aliases) {
        if (!aliasIn(q, alias)) continue;
        if (
          !best ||
          weight > best.weight ||
          (weight === best.weight && alias.length > best.alias.length)
        ) {
          best = { kind, alias, weight };
        }
      }
    }
    if (best) hits.push(best);
  }
  hits.sort(
    (a, b) =>
      b.weight - a.weight ||
      KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind) ||
      b.alias.length - a.alias.length,
  );
  return hits;
}

function findTimeWord(text) {
  for (const w of TIME_WORDS) {
    if (ASCII_RE.test(w) ? aliasIn(text, w) : text.includes(w)) return w;
  }
  return null;
}

function isSpatialQuery(text) {
  return SPATIAL_WORDS.some((w) => (ASCII_RE.test(w) ? aliasIn(text, w) : text.includes(w)));
}

/** 从一句模糊说法推断 kind（record 用；只看明确名词，推断不出返回 fallback）。 */
export function inferKind(text, fallback = 'custom') {
  const hit = scanAliases(text, { strongOnly: true })[0];
  return hit ? hit.kind : fallback;
}

export function normalizeKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase();
  return PLACE_KINDS.includes(k) ? k : 'custom';
}

function normalizeSource(source) {
  const s = String(source ?? '').trim().toLowerCase();
  return SOURCES.includes(s) ? s : 'llm';
}

function normalizeDimension(dimension) {
  if (dimension == null) return null;
  const s = String(dimension).trim();
  return s || null;
}

function sameDimension(a, b) {
  return !!a && !!b && normalizeText(a) === normalizeText(b);
}

/** 坐标归一化：数字对象或 "x,y,z" 字符串；保留 2 位小数。 */
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

function validPos(pos) {
  return normalizePos(pos);
}

/** 两点直线距离（跨维度没有意义，调用方自己先判断 dimension）。 */
export function distanceBetween(a, b) {
  const pa = normalizePos(a);
  const pb = normalizePos(b);
  if (!pa || !pb) return null;
  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;
  const dz = pa.z - pb.z;
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;
}

function idNum(id) {
  const m = /^p(\d+)$/i.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
}

function createdMs(place) {
  const t = Date.parse(place?.createdAt);
  return Number.isFinite(t) ? t : 0;
}

function clonePlace(place) {
  if (!place) return null;
  return {
    id: place.id,
    name: place.name,
    kind: place.kind,
    dimension: place.dimension ?? null,
    pos: place.pos ? { ...place.pos } : null,
    note: place.note ?? '',
    source: place.source ?? 'llm',
    companion: place.companion ?? null,
    createdAt: place.createdAt,
  };
}

function normalizeEntry(entry) {
  const nowIso = new Date().toISOString();
  const t = Date.parse(entry?.createdAt);
  return {
    id: String(entry?.id ?? '').trim(),
    name: String(entry?.name ?? '').trim() || '未命名地点',
    kind: normalizeKind(entry?.kind),
    dimension: normalizeDimension(entry?.dimension),
    pos: normalizePos(entry?.pos),
    note: String(entry?.note ?? ''),
    source: normalizeSource(entry?.source),
    companion: entry?.companion == null ? null : String(entry.companion),
    createdAt: Number.isFinite(t) ? new Date(t).toISOString() : nowIso,
  };
}

export class PlaceBook {
  /**
   * @param {object} opts
   * @param {string} opts.file       places.json 的绝对路径
   * @param {object} [opts.trace]    可选，有 .info/.warn 就用来留痕
   * @param {number} [opts.maxEntries] 上限，默认 500
   */
  constructor({ file, trace, maxEntries } = {}) {
    this.file = file ? path.resolve(String(file)) : path.resolve('places.json');
    this.trace = trace || null;
    this.maxEntries = Number.isFinite(Number(maxEntries))
      ? Math.max(1, Number(maxEntries))
      : DEFAULT_MAX_ENTRIES;
    this.version = 1;
    this.seq = 0;
    this.places = [];
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
    this.places = [];
    this.seq = 0;
    try {
      if (!fs.existsSync(this.file)) {
        if (!silent) this.#trace('info', 'places_loaded', { note: '地点簿为空（文件不存在）' });
        return this;
      }
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      // 容忍直接存数组的老格式
      const arr = Array.isArray(data) ? data : data?.places;
      const baseSeq = Number(data?.seq);
      if (!Array.isArray(arr)) throw new Error('places 字段不是数组');

      const parsed = arr
        .filter((e) => e && typeof e === 'object')
        .map((e) => normalizeEntry(e));

      let maxId = Number.isFinite(baseSeq) && baseSeq > 0 ? Math.floor(baseSeq) : 0;
      for (const p of parsed) maxId = Math.max(maxId, idNum(p.id));

      // 补/修 id：缺失或重复就发新号
      const used = new Set();
      for (const p of parsed) {
        if (!p.id || used.has(p.id)) {
          maxId += 1;
          p.id = `p${maxId}`;
        }
        used.add(p.id);
        this.places.push(p);
      }
      this.seq = maxId;
      this.#trim();
      if (!silent) {
        this.#trace('info', 'places_loaded', {
          note: `${this.places.length} 条（seq=${this.seq}）`,
        });
      }
    } catch (e) {
      // 坏文件不抛：降级成空簿，留一条 warn 供排查
      this.places = [];
      this.seq = 0;
      this.#trace('warn', 'places_load_failed', {
        note: `读地点簿失败，按空簿继续：${String(e?.message || e)}`,
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
        places: this.places,
      };
      const tmp = `${this.file}.tmp`;
      // 写 UTF-8、不带 BOM、带换行收尾（方便 git diff / 人看）
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.#trace('warn', 'places_save_failed', {
        note: `写地点簿失败（内存里仍保留）：${String(e?.message || e)}`,
      });
      return false;
    }
  }

  /** 超过上限时删旧的：先删非 base，再删最老的 base。 */
  #trim() {
    const over = this.places.length - this.maxEntries;
    if (over <= 0) return;
    const removable = this.places
      .map((place, index) => ({
        index,
        rank: place.kind === 'base' ? 1 : 0,
        created: createdMs(place),
      }))
      .sort((a, b) => a.rank - b.rank || a.created - b.created || a.index - b.index);
    const drop = new Set(removable.slice(0, over).map((x) => x.index));
    this.places = this.places.filter((_, i) => !drop.has(i));
  }

  get size() {
    return this.places.length;
  }

  /**
   * 按新→旧列出（可按 kind / dimension 过滤）。
   * 返回的是副本，外部改不到簿里。
   */
  list({ kind, dimension } = {}) {
    let list = this.places;
    if (kind != null && kind !== '') {
      const k = normalizeKind(kind);
      list = list.filter((p) => p.kind === k);
    }
    if (dimension != null && dimension !== '') {
      const d = normalizeDimension(dimension);
      list = list.filter((p) => sameDimension(p.dimension, d));
    }
    return list
      .slice()
      .sort(
        (a, b) =>
          createdMs(b) - createdMs(a) || idNum(b.id) - idNum(a.id),
      )
      .map(clonePlace);
  }

  /** 记一个地点。kind 不合法 → custom；位置非法 → pos 为 null（调用方应自行校验）。 */
  record({ name, kind, dimension, pos, note, source, companion } = {}) {
    const k = normalizeKind(kind);
    const place = {
      id: (() => {
        this.seq += 1;
        return `p${this.seq}`;
      })(),
      name: String(name ?? '').trim() || KIND_LABELS[k],
      kind: k,
      dimension: normalizeDimension(dimension),
      pos: normalizePos(pos),
      note: String(note ?? ''),
      source: normalizeSource(source),
      companion: companion == null ? null : String(companion),
      createdAt: new Date().toISOString(),
    };
    this.places.push(place);
    this.#trim();
    this.save();
    return clonePlace(place);
  }

  /** 内部：按固定顺序解析出候选 + 排序。返回内部对象引用（forget 要用）。 */
  #resolve(rawQuery, { dimension, near } = {}) {
    const raw = String(rawQuery ?? '').trim();
    if (!raw) return null;
    const q = normalizeText(raw);
    if (!q || !this.places.length) return null;

    // 1) 精确匹配 id
    const idKey = raw.toLowerCase();
    const byId = this.places.find((p) => String(p.id).toLowerCase() === idKey);
    if (byId) {
      return this.#matchResult(
        this.#rank([byId], { dimension, near, mode: 'new' }),
        `精确匹配 id ${byId.id}`,
      );
    }

    // 2) 精确匹配 name（归一化后全等）
    const byName = this.places.filter((p) => normalizeText(p.name) === q);
    if (byName.length) {
      const why =
        byName.length > 1
          ? `精确匹配名称"${byName[0].name}"（同名 ${byName.length} 条，最近的优先）`
          : `精确匹配名称"${byName[0].name}"`;
      return this.#matchResult(this.#rank(byName, { dimension, near }), why);
    }

    // 3) 时间词：取同类（或全部）最新一条；带坐标时"最近/附近"按距离
    const timeWord = findTimeWord(q);
    if (timeWord) {
      const kindText = q.split(timeWord).join(' ');
      const kindHit = scanAliases(kindText)[0] || null;
      let pool = kindHit ? this.places.filter((p) => p.kind === kindHit.kind) : null;
      // 同类一条都没有时退回全部（why 里要说清楚，别让 LLM 误以为真有同类）
      const fellBack = !!kindHit && (!pool || !pool.length);
      if (!pool || !pool.length) pool = this.places;
      const spatial = !!validPos(near) && isSpatialQuery(q);
      const ranked = this.#rank(pool, {
        dimension,
        near,
        mode: spatial ? 'near' : 'new',
      });
      const kindNote = kindHit && !fellBack ? `，同类 ${kindHit.kind}` : '';
      const fallbackNote = fellBack ? `（簿里没有 ${kindHit.kind}，退回全部）` : '';
      const why = spatial
        ? `时间/近义表述"${timeWord}"+当前坐标 → 按距离最近${kindNote}${fallbackNote}`
        : `时间词"${timeWord}"→ 最新一条${kindNote}${fallbackNote}`;
      return this.#matchResult(ranked, why);
    }

    // 4) 别名表（中英子串）
    const hits = scanAliases(q);
    if (hits.length) {
      const hit = hits[0];
      const pool = this.places.filter((p) => p.kind === hit.kind);
      if (pool.length) {
        const ranked = this.#rank(pool, { dimension, near, mode: 'auto' });
        return this.#matchResult(ranked, `别名匹配：${hit.alias}→${hit.kind}`);
      }
    }

    // 5) name / note 子串包含
    const nameHits = this.places.filter((p) => normalizeText(p.name).includes(q));
    if (nameHits.length) {
      return this.#matchResult(
        this.#rank(nameHits, { dimension, near, mode: 'auto' }),
        `名称包含"${raw}"`,
      );
    }
    const noteHits = this.places.filter((p) => normalizeText(p.note).includes(q));
    if (noteHits.length) {
      return this.#matchResult(
        this.#rank(noteHits, { dimension, near, mode: 'auto' }),
        `备注包含"${raw}"`,
      );
    }
    return null;
  }

  /** 排序：同维度优先；mode='new' 最新优先，'near' 最近优先，'auto' 有 near 就近、否则最新。 */
  #rank(candidates, { dimension, near, mode = 'auto' } = {}) {
    let list = candidates;
    if (dimension) {
      const same = list.filter((p) => sameDimension(p.dimension, dimension));
      if (same.length) list = same;
    }
    const nearPos = validPos(near);
    const byNew = (a, b) =>
      createdMs(b.place) - createdMs(a.place) || idNum(b.place.id) - idNum(a.place.id);
    const byNear = (a, b) => {
      const da = a.distance ?? Infinity;
      const db = b.distance ?? Infinity;
      return da - db || byNew(a, b);
    };
    const ranked = list.map((place) => ({
      place,
      distance:
        nearPos && place.pos ? distanceBetween(nearPos, place.pos) : null,
    }));
    ranked.sort(mode === 'near' || (mode === 'auto' && nearPos) ? byNear : byNew);
    return ranked;
  }

  /** 第一条是匹配结果，第 2、3 条放 alternatives。 */
  #matchResult(ranked, why) {
    const top = ranked[0];
    const out = { place: clonePlace(top.place), why };
    if (top.distance != null) out.distance = top.distance;
    const alternatives = ranked.slice(1, 3).map(({ place, distance }) => {
      const p = clonePlace(place);
      if (distance != null) p.distance = distance;
      return p;
    });
    if (alternatives.length) out.alternatives = alternatives;
    return out;
  }

  /**
   * 模糊解析。返回 { place, why, distance?, alternatives? } 或 null。
   * query 可以很随意："家""上次死的地方""主人""离我最近的基地""矿洞"。
   */
  find(query, { dimension, near } = {}) {
    const matched = this.#resolve(query, { dimension, near });
    return matched || null;
  }

  /** 删一条（id 或模糊说法都行）。返回被删的那条；没有返回 null。 */
  forget(idOrQuery) {
    const raw = String(idOrQuery ?? '').trim();
    if (!raw) return null;
    const matched = this.#resolve(raw, {});
    if (!matched?.place) return null;
    const target = this.places.find((p) => p.id === matched.place.id) || null;
    if (!target) return null;
    this.places = this.places.filter((p) => p !== target);
    this.save();
    return clonePlace(target);
  }
}

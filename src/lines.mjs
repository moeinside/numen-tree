/**
 * 台词库（utterance library）
 *
 * 纪律：
 *  - 这里只有"数据"和"机械选择"，没有任何语言生成；
 *  - 台词由人写或离线生成（右脑），运行时只做 查表 → 冷却 → 权重 → 填槽；
 *  - 树不组织语言，只按事件挑一条已存在的句子。
 *
 * 文件格式（lines/*.json）：
 * {
 *   "persona": "default",
 *   "entries": [
 *     { "id": "arrived", "when": "arrived", "text": ["到了","我回来了"],
 *       "slots": [], "cooldownSeconds": 45, "weight": 2 }
 *   ]
 * }
 */
import fs from 'node:fs';
import path from 'node:path';

export class LineBank {
  constructor({ dir, persona = 'default', enabled = true, recentSize = 3 } = {}) {
    this.dir = dir;
    this.persona = persona;
    this.enabled = enabled;
    this.recentSize = recentSize;
    this.entries = new Map(); // id -> entry
    this.byWhen = new Map(); // when -> entry[]
    this.lastSaid = new Map(); // id -> ts
    this.recent = new Map(); // when -> id[]
    this.stats = { picks: 0, misses: 0 };
  }

  load() {
    this.entries.clear();
    this.byWhen.clear();
    if (!this.enabled) return this;

    const files = ['default.json'];
    if (this.persona && this.persona !== 'default') files.push(`${this.persona}.json`);

    for (const file of files) {
      const p = path.join(this.dir, file);
      if (!fs.existsSync(p)) continue;
      let bank;
      try {
        bank = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        console.error(`[lines] 解析失败 ${file}: ${e.message}`);
        continue;
      }
      for (const entry of bank.entries || []) this.#add(entry);
    }
    return this;
  }

  #add(raw) {
    if (!raw?.id || !raw?.when || raw?.text == null) return;
    const entry = {
      weight: 1,
      cooldownSeconds: 60,
      ...raw,
      text: Array.isArray(raw.text) ? raw.text : [raw.text],
    };
    this.entries.set(entry.id, entry);
    if (!this.byWhen.has(entry.when)) this.byWhen.set(entry.when, []);
    const arr = this.byWhen.get(entry.when);
    const i = arr.findIndex((x) => x.id === entry.id);
    if (i >= 0) arr[i] = entry;
    else arr.push(entry);
  }

  /** 按事件挑一句（机械选择：冷却 → 最近不复用 → 权重随机 → 填槽）。 */
  pick(when, slots = {}) {
    if (!this.enabled) return null;
    const now = Date.now();
    const all = this.byWhen.get(when) || [];
    const fresh = all.filter(
      (e) => now - (this.lastSaid.get(e.id) || 0) >= (e.cooldownSeconds ?? 60) * 1000,
    );
    if (!fresh.length) {
      this.stats.misses += 1;
      return null;
    }

    const recent = this.recent.get(when) || [];
    const avoidRecent = fresh.filter((e) => !recent.includes(e.id));
    const pool = avoidRecent.length ? avoidRecent : fresh;

    let total = 0;
    for (const e of pool) total += Number(e.weight) || 1;
    let r = Math.random() * total;
    let chosen = pool[0];
    for (const e of pool) {
      r -= Number(e.weight) || 1;
      if (r <= 0) {
        chosen = e;
        break;
      }
    }

    const text = this.#fill(chosen, slots);
    this.lastSaid.set(chosen.id, now);
    this.recent.set(when, [...recent, chosen.id].slice(-this.recentSize));
    this.stats.picks += 1;
    return { id: chosen.id, text, when };
  }

  #fill(entry, slots) {
    const tpl = entry.text[Math.floor(Math.random() * entry.text.length)];
    return String(tpl).replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(slots, k) ? String(slots[k]) : m,
    );
  }

  list() {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      when: e.when,
      variants: e.text.length,
      cooldownSeconds: e.cooldownSeconds,
      weight: e.weight,
    }));
  }
}

/** 把技能失败码翻成人话，供 {reason} 槽使用。 */
export const KIND_WORDS = {
  no_path: '过不去',
  out_of_reach: '够不着',
  not_found: '找不到',
  denied: '不让动',
  slot_blocked: '腾不出手',
  owner_offline: '你不在',
  bad_argument: '没听明白',
  failed: '没成',
};

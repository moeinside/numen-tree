/**
 * P0-0a：白名单三态 FactStore。
 *
 * 原则：
 *  - 只允许白名单 fact；
 *  - 单 key 单权威来源；非权威只作候选；
 *  - 冲突/过期 → unknown/stale，禁止 last-write-wins；
 *  - 新鲜度按游戏 tick，不按 wall clock；
 *  - 不采信执行器自报作为权威。
 */
export const FACT_WHITELIST = Object.freeze({
  in_water: { authority: 'tentacle', ttlGameTicks: 120, label: '是否在水里' },
  on_ground: { authority: 'tentacle', ttlGameTicks: 120, label: '是否在地面' },
  block_target_changed: { authority: 'postcheck', ttlGameTicks: 2400, label: '目标方块变化' },
  item_delta: { authority: 'postcheck', ttlGameTicks: 2400, label: '掉落/背包增量' },
  container_open: { authority: 'interaction', ttlGameTicks: 2400, label: '容器可交互' },
  player_moved: { authority: 'postcheck', ttlGameTicks: 600, label: '动作位移' },
});

export function isWhitelisted(key) {
  return Object.prototype.hasOwnProperty.call(FACT_WHITELIST, key);
}

export function createFactStore() {
  return { facts: {}, conflicts: [] };
}

/** 写入观测；非权威来源只进候选，不覆盖权威值。 */
export function observeFact(
  store,
  { key, value, source, gameTick = 0, ttlGameTicks = null, evidenceSeq = null, partial = false },
) {
  if (!isWhitelisted(key)) return { ok: false, reason: 'not_whitelisted', key };
  const spec = FACT_WHITELIST[key];
  const s = store || createFactStore();
  const prev = s.facts[key] || null;
  const now = Number(gameTick) || 0;
  const ttl = Number(ttlGameTicks ?? spec.ttlGameTicks) || spec.ttlGameTicks;

  if (spec.authority !== source) {
    // 非权威：只记候选；若已有权威值不被覆盖
    if (prev) {
      prev.candidates = [...(prev.candidates || []), { value, source, gameTick: now, evidenceSeq }].slice(-5);
      return { ok: true, fact: prev, candidate: true };
    }
    s.facts[key] = {
      key,
      value,
      status: 'unknown',
      authoritySource: spec.authority,
      source,
      observedAt: now,
      ttlGameTicks: ttl,
      evidenceSeq,
      partial: !!partial,
      candidates: [{ value, source, gameTick: now, evidenceSeq }],
    };
    return { ok: true, fact: s.facts[key], candidate: true };
  }

  if (prev && prev.status !== 'unknown' && prev.source && prev.source !== source) {
    // 权威来源变化/冲突：降 unknown，记录冲突
    const conflict = { key, prev, incoming: { value, source, gameTick: now }, at: now };
    s.conflicts = [...(s.conflicts || []), conflict].slice(-20);
    s.facts[key] = {
      ...prev,
      status: 'unknown',
      candidates: [
        ...(prev.candidates || []),
        { value: prev.value, source: prev.source, gameTick: prev.observedAt, evidenceSeq: prev.evidenceSeq },
        { value, source, gameTick: now, evidenceSeq },
      ].slice(-5),
      conflictAt: now,
    };
    return { ok: true, fact: s.facts[key], conflict: true };
  }

  s.facts[key] = {
    key,
    value,
    status: 'known',
    authoritySource: spec.authority,
    source,
    observedAt: now,
    ttlGameTicks: ttl,
    evidenceSeq,
    partial: !!partial,
    candidates: prev?.candidates || [],
  };
  return { ok: true, fact: s.facts[key] };
}

/** 取事实：过期自动 stale；缺失 unknown。 */
export function getFact(store, key, { gameTick = 0 } = {}) {
  if (!isWhitelisted(key)) return { key, status: 'unknown', value: null, reason: 'not_whitelisted' };
  const f = store?.facts?.[key];
  if (!f) return { key, status: 'unknown', value: null, reason: 'missing' };
  const age = Math.max(0, Number(gameTick) - Number(f.observedAt ?? 0));
  if (f.status === 'known' && age > Number(f.ttlGameTicks ?? 0)) {
    return { ...f, status: 'stale', age };
  }
  return { ...f, age };
}

/** 动作前 ensure：known 且未过期才 ok；否则返回需要观察/unknown。 */
export function ensureFact(store, key, { gameTick = 0 } = {}) {
  const f = getFact(store, key, { gameTick });
  if (f.status === 'known') return { ok: true, fact: f };
  return { ok: false, key, status: f.status, fact: f };
}

export function markUnknown(store, key, { reason = 'observed_unknown', gameTick = 0 } = {}) {
  if (!isWhitelisted(key)) return { ok: false, reason: 'not_whitelisted' };
  const s = store || createFactStore();
  const prev = s.facts[key] || null;
  s.facts[key] = {
    ...(prev || { key }),
    key,
    status: 'unknown',
    value: null,
    observedAt: Number(gameTick) || 0,
    ttlGameTicks: prev?.ttlGameTicks ?? FACT_WHITELIST[key].ttlGameTicks,
    reason,
  };
  return { ok: true, fact: s.facts[key] };
}

export function describeFacts(store) {
  return Object.fromEntries(
    Object.entries(store?.facts || {}).map(([k, f]) => [
      k,
      { status: f.status, value: f.value, source: f.source, observedAt: f.observedAt, age: f.age },
    ]),
  );
}

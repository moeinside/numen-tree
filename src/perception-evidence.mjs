/**
 * 字段级感知证据：来源、观测时间、半径、遮挡、TTL。
 * 只读辅助；不调用游戏。
 */
export const DEFAULT_FACT_TTL_MS = 5000;

export function markFact(state, key, { observedAt = Date.now(), source = 'unknown', radius = null, occluded = null, confidence = null, value = null } = {}) {
  state.factMeta ??= {};
  state.factMeta[String(key)] = {
    observedAt: Number(observedAt),
    source: String(source),
    radius: radius == null ? null : Number(radius),
    occluded: occluded == null ? null : !!occluded,
    confidence: confidence == null ? null : Number(confidence),
    value,
  };
  state.factCandidates ??= {};
  const list = (state.factCandidates[String(key)] ?? []).concat({
    value,
    observedAt: Number(observedAt),
    source: String(source),
    radius: radius == null ? null : Number(radius),
  });
  state.factCandidates[String(key)] = list.slice(-8);
  return state.factMeta[String(key)];
}

export function factFresh(state, key, { ttlMs = DEFAULT_FACT_TTL_MS, now = Date.now() } = {}) {
  const m = state?.factMeta?.[String(key)];
  if (!m) return { fresh: true, missing: true, meta: null, ageMs: null };
  const ageMs = now - Number(m.observedAt || 0);
  return { fresh: ageMs <= ttlMs, missing: false, meta: m, ageMs };
}

export function snapshotView(state) {
  return state?.factMeta ? JSON.parse(JSON.stringify(state.factMeta)) : {};
}

/**
 * 字段权威/冲突裁决。
 * - 只取 TTL 内候选；
 * - 按 authority 顺序取胜者；
 * - 两个同权威新鲜候选值不同 → conflict，不允许抢占。
 */
export function resolveFact(state, key, { ttlMs = DEFAULT_FACT_TTL_MS, now = Date.now(), authority = [] } = {}) {
  const candidates = (state?.factCandidates?.[String(key)] ?? [])
    .filter((c) => c && now - Number(c.observedAt || 0) <= ttlMs);
  if (!candidates.length) {
    return { fresh: false, conflict: false, value: null, source: null, candidates: [] };
  }
  const rank = (src) => {
    const i = authority.indexOf(String(src));
    return i < 0 ? authority.length + 1 : i;
  };
  const bestRank = Math.min(...candidates.map((c) => rank(c.source)));
  const best = candidates.filter((c) => rank(c.source) === bestRank);
  const values = new Set(best.map((c) => JSON.stringify(c.value)));
  if (values.size > 1) {
    return { fresh: false, conflict: true, value: null, source: null, candidates };
  }
  const winner = best.sort((a, b) => b.observedAt - a.observedAt)[0];
  return {
    fresh: true,
    conflict: false,
    value: winner.value,
    source: winner.source,
    observedAt: winner.observedAt,
    ageMs: now - winner.observedAt,
    candidates,
  };
}

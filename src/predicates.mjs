/**
 * B：谓词化验收（最小集）。
 *
 * 谓词只认外部观测/交互/记忆证据，不接受 executor 自评。
 * 纯函数，不执行动作。
 */
export const EVIDENCE_SOURCES = new Set(['observer', 'interaction', 'memory', 'world_snapshot']);

function countItem(state, item) {
  const id = String(item);
  return (state?.inventory || [])
    .filter((x) => String(x.item) === id && Number(x.count) > 0)
    .reduce((a, x) => a + Number(x.count), 0);
}

function evidenceOk(predicate) {
  const src = predicate?.evidence?.source;
  if (!src || src === 'executor' || src === 'self') {
    return { ok: false, reason: 'evidence_not_external' };
  }
  if (!EVIDENCE_SOURCES.has(src)) return { ok: false, reason: 'evidence_unknown_source' };
  if (predicate.evidence.snapshotSeq == null && predicate.evidence.observedAt == null) {
    return { ok: false, reason: 'evidence_missing_stamp' };
  }
  return { ok: true };
}

/**
 * @param {object} predicate { kind, item?, count?, siteKind?, evidence:{source,snapshotSeq|observedAt} }
 * @param {object} ctx { state, sites?, world? }
 */
export function evaluatePredicate(predicate, ctx = {}) {
  const ev = evidenceOk(predicate);
  if (!ev.ok) return { ok: false, value: null, reason: ev.reason, evidence: predicate?.evidence ?? null };
  const kind = String(predicate?.kind ?? '');
  let value = null;
  let reason = null;

  if (kind === 'item_count' || kind === 'has_item') {
    const n = countItem(ctx.state, predicate.item);
    value = n;
    const need = kind === 'has_item' ? 1 : Number(predicate.count ?? 1);
    if (n < need) reason = 'item_shortage';
  } else if (kind === 'site_valid') {
    const site = (ctx.sites || []).find(
      (s) => s && (!predicate.siteKind || s.kind === predicate.siteKind) && s.valid !== false,
    );
    value = site ?? null;
    if (!site) reason = 'site_missing_or_stale';
  } else if (kind === 'world_flag') {
    value = ctx.world?.[predicate.key] ?? null;
    if (predicate.equals != null && value !== predicate.equals) reason = 'flag_mismatch';
  } else {
    reason = 'unknown_predicate_kind';
  }

  return {
    ok: reason == null,
    value,
    reason,
    evidence: predicate.evidence,
    kind,
  };
}

export function evaluateMilestone(milestone, ctx = {}) {
  const preds = Array.isArray(milestone?.predicates) ? milestone.predicates : [];
  if (preds.length === 0) return { ok: false, reason: 'no_predicates', results: [] };
  const results = preds.map((p) => ({ id: p.id ?? p.kind, ...evaluatePredicate(p, ctx) }));
  return { ok: results.every((r) => r.ok), results };
}

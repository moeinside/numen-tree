#!/usr/bin/env node
/**
 * P0 审计核心。
 *
 * 原则：不采信执行器自报；所有结论必须能由外部快照/观测/事件复核。
 * 本文件是纯函数 + 指标，不驱动 Lane、不连游戏。
 */
import crypto from 'node:crypto';

export const AUDIT_VERSION = 'p0-audit-1';
export const FIXTURE_VERSION = 'p0-fixture-1';

export const DEFAULT_THRESHOLDS = Object.freeze({
  maxSuspensionRatio: 0.2,
  maxResumeWithoutObserve: 0,
  maxSamePlanResumes: 2,
  maxStaleFactUses: 0,
  maxUnknownAsFalse: 0,
  maxObservationOverBudget: 0,
  minSettleReobserveCoverage: 1,
});

function stable(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

export function hashBody(body) {
  return crypto.createHash('sha256').update(stable(body)).digest('hex');
}

function violation(code, detail = {}) {
  return { code, ...detail };
}

function snapshotIndex(run) {
  const list = Array.isArray(run?.snapshots) ? run.snapshots : [];
  const bySeq = new Map();
  const sorted = [...list].sort((a, b) => Number(a.seq) - Number(b.seq));
  for (const s of sorted) bySeq.set(Number(s.seq), s);
  return { list: sorted, bySeq };
}

/**
 * @param {object} run
 * @param {object} thresholds
 * @returns {{ok:boolean, violations:object[], metrics:object, auditVersion:string}}
 */
export function auditRun(run, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const violations = [];
  const { list: snaps, bySeq } = snapshotIndex(run);
  const meta = run?.meta || {};

  // 冻结/版本检查：没有冻结就不算通过
  if (!meta.thresholdsFrozenAt) {
    violations.push(violation('THRESHOLDS_NOT_FROZEN', { note: 'meta.thresholdsFrozenAt 缺失' }));
  }
  if (meta.auditVersion && meta.auditVersion !== AUDIT_VERSION) {
    violations.push(violation('AUDIT_VERSION_MISMATCH', { got: meta.auditVersion, want: AUDIT_VERSION }));
  }
  if (meta.fixtureVersion && meta.fixtureVersion !== FIXTURE_VERSION) {
    violations.push(violation('FIXTURE_VERSION_MISMATCH', { got: meta.fixtureVersion, want: FIXTURE_VERSION }));
  }

  // 快照完整性：序号连续 + hash 未篡改
  let snapshotGaps = 0;
  for (let i = 1; i < snaps.length; i++) {
    const prev = Number(snaps[i - 1].seq);
    const cur = Number(snaps[i].seq);
    if (cur !== prev + 1) {
      snapshotGaps += 1;
      violations.push(violation('SNAPSHOT_GAP', { prev, cur }));
    }
  }
  for (const s of snaps) {
    if (s.body == null || !s.hash) {
      violations.push(violation('SNAPSHOT_MISSING_HASH', { seq: s.seq }));
      continue;
    }
    const got = hashBody(s.body);
    if (got !== s.hash) {
      violations.push(violation('SNAPSHOT_TAMPERED', { seq: s.seq, expected: s.hash, got }));
    }
  }

  // 动作：自报成功但世界无变化 / 状态改变后未复观测
  const actions = Array.isArray(run?.actions) ? run.actions : [];
  let stateChanging = 0;
  let stateChangingReobserved = 0;
  let selfReportMismatch = 0;
  for (const a of actions) {
    if (a.stateChanging) {
      stateChanging += 1;
      if (a.settled && a.reobserved) stateChangingReobserved += 1;
      if (!a.settled || !a.reobserved) {
        violations.push(violation('SETTLE_REOBSERVE_MISSING', { action: a.id }));
      }
    }
    if (a.outcome === 'success' && a.reportedBy === 'executor' && a.observedWorldChanged !== true) {
      selfReportMismatch += 1;
      violations.push(violation('SELF_REPORT_WITHOUT_WORLD_CHANGE', { action: a.id }));
    }
    // 动作前后快照必须存在
    if (a.beforeSeq != null && !bySeq.has(Number(a.beforeSeq))) {
      violations.push(violation('ACTION_BEFORE_SNAPSHOT_MISSING', { action: a.id, seq: a.beforeSeq }));
    }
    if (a.afterSeq != null && !bySeq.has(Number(a.afterSeq))) {
      violations.push(violation('ACTION_AFTER_SNAPSHOT_MISSING', { action: a.id, seq: a.afterSeq }));
    }
  }

  // 决策：stale / unknown-as-false / 观察预算
  const decisions = Array.isArray(run?.decisions) ? run.decisions : [];
  let staleUses = 0;
  let unknownAsFalse = 0;
  for (const d of decisions) {
    const f = d.fact || {};
    if (f.status === 'stale') {
      staleUses += 1;
      violations.push(violation('STALE_FACT_USED', { decision: d.id, fact: f.key }));
    }
    if (f.status === 'unknown' && d.effectiveValue === false) {
      unknownAsFalse += 1;
      violations.push(violation('UNKNOWN_AS_FALSE', { decision: d.id, fact: f.key }));
    }
  }
  const observationCalls = Number(run?.observationCalls ?? 0);
  const observationBudget = Number(run?.observationBudget ?? Infinity);
  const overBudget = observationCalls > observationBudget ? observationCalls - observationBudget : 0;
  if (overBudget > 0) {
    violations.push(violation('OBSERVATION_OVER_BUDGET', { calls: observationCalls, budget: observationBudget }));
  }

  // milestone 谓词：必须由外部证据，不接受执行器自评
  const milestones = Array.isArray(run?.milestones) ? run.milestones : [];
  let predicates = 0;
  let predicateDone = 0;
  for (const m of milestones) {
    for (const p of m.predicates || []) {
      predicates += 1;
      if (!p.evidence) {
        violations.push(violation('PREDICATE_MISSING_EVIDENCE', { milestone: m.id, predicate: p.id }));
        continue;
      }
      if (p.evidence.source === 'executor' || p.evidence.source === 'self') {
        violations.push(violation('PREDICATE_SELF_EVALUATED', { milestone: m.id, predicate: p.id }));
      }
      if (p.achieved === true) predicateDone += 1;
    }
  }

  // resume：每次恢复必须有成功观测；同一计划恢复次数有上限
  const resumes = Array.isArray(run?.resumes) ? run.resumes : [];
  let resumeWithoutObserve = 0;
  const resumeByPlan = new Map();
  for (const r of resumes) {
    if (!r.successfulObserve) {
      resumeWithoutObserve += 1;
      violations.push(violation('RESUME_WITHOUT_OBSERVE', { at: r.at, plan: r.planId }));
    }
    const key = r.planId ?? 'unknown';
    resumeByPlan.set(key, (resumeByPlan.get(key) || 0) + 1);
  }
  for (const [planId, n] of resumeByPlan) {
    if (n > t.maxSamePlanResumes) {
      violations.push(violation('RESUME_LOOP', { planId, resumes: n, max: t.maxSamePlanResumes }));
    }
  }

  const metrics = {
    snapshots: snaps.length,
    snapshotGaps,
    actions: actions.length,
    stateChanging,
    settleReobserveCoverage: stateChanging ? stateChangingReobserved / stateChanging : 1,
    selfReportMismatch,
    staleUses,
    unknownAsFalse,
    observationCalls,
    observationBudget,
    overBudget,
    resumes: resumes.length,
    resumeWithoutObserve,
    predicateCount: predicates,
    predicateEvidenceRate: predicates ? (predicateDone / predicates) : 1,
  };

  // 阈值判定（在 violations 已有结构化项之外，再补一个总门）
  if (metrics.settleReobserveCoverage < t.minSettleReobserveCoverage) {
    violations.push(violation('SETTLE_COVERAGE_BELOW_THRESHOLD', metrics));
  }
  if (resumeWithoutObserve > t.maxResumeWithoutObserve) {
    violations.push(violation('RESUME_WITHOUT_OBSERVE_OVER_THRESHOLD', metrics));
  }
  if (staleUses > t.maxStaleFactUses) {
    violations.push(violation('STALE_USES_OVER_THRESHOLD', metrics));
  }
  if (unknownAsFalse > t.maxUnknownAsFalse) {
    violations.push(violation('UNKNOWN_AS_FALSE_OVER_THRESHOLD', metrics));
  }
  if (overBudget > t.maxObservationOverBudget) {
    violations.push(violation('OBSERVATION_BUDGET_OVER_THRESHOLD', metrics));
  }

  return { ok: violations.length === 0, violations, metrics, auditVersion: AUDIT_VERSION };
}

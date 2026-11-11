#!/usr/bin/env node
/**
 * P0 审计负样本演练：先证明审计会判负，再改树行为。
 *
 * 三类必须假通过：
 *  1) 执行器自报成功，但世界没变
 *  2) 谓词由执行器自评
 *  3) 快照被篡改/缺哈希
 * 另加：stale fact、unknown-as-false、settle 未复观测、resume 无观测、观察超预算。
 */
import { auditRun, hashBody, AUDIT_VERSION, FIXTURE_VERSION } from './audit.mjs';

let p = 0;
let f = 0;
const ck = (name, ok, detail = '') => {
  if (ok) {
    p += 1;
    console.log(`  ✓ ${name}`);
  } else {
    f += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function snapshot(seq, body) {
  return { seq, body, hash: hashBody(body), observedAt: `t${seq}`, source: 'observer' };
}

function positiveRun() {
  return {
    meta: {
      thresholdsFrozenAt: '2026-11-10T00:00:00Z',
      auditVersion: AUDIT_VERSION,
      fixtureVersion: FIXTURE_VERSION,
      seed: 'p0-fixed-1',
    },
    snapshots: [
      snapshot(1, { gameTick: 100, hp: 20, pos: { x: 0, y: 64, z: 0 }, inv: {} }),
      snapshot(2, { gameTick: 120, hp: 20, pos: { x: 1, y: 64, z: 0 }, inv: { cobblestone: 8 } }),
      snapshot(3, { gameTick: 140, hp: 19, pos: { x: 1, y: 64, z: 0 }, inv: { cobblestone: 8, furnace: 1 } }),
    ],
    actions: [
      {
        id: 'a1',
        stateChanging: true,
        settled: true,
        reobserved: true,
        outcome: 'success',
        reportedBy: 'observer',
        observedWorldChanged: true,
        beforeSeq: 1,
        afterSeq: 2,
      },
      {
        id: 'a2',
        stateChanging: true,
        settled: true,
        reobserved: true,
        outcome: 'success',
        reportedBy: 'observer',
        observedWorldChanged: true,
        beforeSeq: 2,
        afterSeq: 3,
      },
    ],
    decisions: [
      { id: 'd1', fact: { key: 'water.open', status: 'known' }, effectiveValue: true },
      { id: 'd2', fact: { key: 'chest.contents', status: 'known' }, effectiveValue: 'rod' },
    ],
    milestones: [
      {
        id: 'M1',
        predicates: [
          { id: 'furnace_placed', achieved: true, evidence: { source: 'observer', snapshotSeq: 3 } },
        ],
      },
    ],
    resumes: [{ at: 't1', planId: 'pl1', successfulObserve: true }],
    observationCalls: 2,
    observationBudget: 10,
  };
}

function clone(v) {
  return structuredClone(v);
}

const base = positiveRun();
const positive = auditRun(base);
ck('正样本通过', positive.ok === true, JSON.stringify(positive.violations));

const negatives = [];
{
  const r = clone(base);
  r.actions[0] = { ...r.actions[0], reportedBy: 'executor', outcome: 'success', observedWorldChanged: false };
  negatives.push(['自报成功但世界没变', r, 'SELF_REPORT_WITHOUT_WORLD_CHANGE']);
}
{
  const r = clone(base);
  r.milestones[0].predicates[0].evidence = { source: 'executor', snapshotSeq: 3 };
  negatives.push(['谓词由执行器自评', r, 'PREDICATE_SELF_EVALUATED']);
}
{
  const r = clone(base);
  r.snapshots[1].body.hp = 0; // hash 未重算 = 篡改
  negatives.push(['快照被篡改', r, 'SNAPSHOT_TAMPERED']);
}
{
  const r = clone(base);
  r.decisions[0].fact.status = 'stale';
  negatives.push(['stale fact 被使用', r, 'STALE_FACT_USED']);
}
{
  const r = clone(base);
  r.decisions[0].fact = { key: 'water.open', status: 'unknown' };
  r.decisions[0].effectiveValue = false;
  negatives.push(['unknown 被当 false', r, 'UNKNOWN_AS_FALSE']);
}
{
  const r = clone(base);
  r.actions[0].reobserved = false;
  negatives.push(['状态改变后未复观测', r, 'SETTLE_REOBSERVE_MISSING']);
}
{
  const r = clone(base);
  r.resumes = [
    { at: 't1', planId: 'pl1', successfulObserve: false },
    { at: 't2', planId: 'pl1', successfulObserve: false },
    { at: 't3', planId: 'pl1', successfulObserve: false },
  ];
  negatives.push(['resume 无成功观测/循环', r, 'RESUME_WITHOUT_OBSERVE']);
}
{
  const r = clone(base);
  r.observationCalls = 11;
  negatives.push(['观察超预算', r, 'OBSERVATION_OVER_BUDGET']);
}
{
  const r = clone(base);
  delete r.meta.thresholdsFrozenAt;
  negatives.push(['阈值未冻结', r, 'THRESHOLDS_NOT_FROZEN']);
}

for (const [name, run, code] of negatives) {
  const out = auditRun(run);
  ck(`判负：${name}`, out.ok === false && out.violations.some((v) => v.code === code), JSON.stringify(out.violations));
}

console.log(`P0 审计负样本演练：${p}/${p + f} 通过`);
if (f) process.exit(1);

/**
 * P0-0b Phase A 自测：node probe/priority-selftest.mjs
 */
import fs from 'node:fs';
import {
  CONSEQUENCE,
  REVERSAL,
  choosePriority,
  createPriorityState,
  canPreempt,
  normalizeCandidate,
  priorityEvent,
  consequenceFromScore,
} from '../src/priority.mjs';

const now = 1_000_000;
const cand = (id, over = {}) => ({
  id,
  consequence: CONSEQUENCE.REVERSIBLE_NEED,
  reversal: REVERSAL.RESUMABLE,
  priority: 50,
  eligible: () => true,
  ...over,
});

let pass = 0;
let fail = 0;
const cases = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  cases.push({ name, ok, detail: ok ? '' : detail });
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('优先级排序：');
{
  const state = createPriorityState(now);
  const r = choosePriority(
    [cand('reversible', { priority: 99 }), cand('death', { consequence: CONSEQUENCE.DEATH_RISK, priority: 1 })],
    {},
    state,
    { now, atAtomBoundary: true },
  );
  check('死亡风险压过满分可逆需求', r.choice?.id === 'death' && r.decision.code === 'no_current');
}
{
  const state = createPriorityState(now);
  const r = choosePriority(
    [cand('irreversible', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, priority: 1 }), cand('reversible', { priority: 99 })],
    {},
    state,
    { now, atAtomBoundary: true },
  );
  check('不可逆损失压过可逆需求', r.choice?.id === 'irreversible');
}
{
  const state = createPriorityState(now);
  const r = choosePriority(
    [cand('a', { consequence: CONSEQUENCE.DEATH_RISK, priority: 10 }), cand('b', { consequence: CONSEQUENCE.DEATH_RISK, priority: 20 })],
    {},
    state,
    { now, atAtomBoundary: true },
  );
  check('同后果层按 priority 排序', r.choice?.id === 'b');
}

console.log('\n抢占边界：');
{
  const state = createPriorityState(now);
  choosePriority([cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS })], {}, state, { now, atAtomBoundary: true });
  const r = choosePriority(
    [cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS }), cand('hungry', { priority: 100 })],
    {},
    state,
    { now: now + 1, atAtomBoundary: true },
  );
  check('不可逆损失不被可逆饥饿抢占', r.choice?.id === 'current' && r.decision.code === 'keep_current');
  check('canPreempt 拒绝可逆需求压不可逆损失', canPreempt(normalizeCandidate(cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS })), normalizeCandidate(cand('hungry', { priority: 100 })), { atAtomBoundary: true }).code === 'lower_consequence');
}
{
  const state = createPriorityState(now);
  choosePriority([cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS })], {}, state, { now, atAtomBoundary: true });
  const r = choosePriority(
    [cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS }), cand('drown', { consequence: CONSEQUENCE.DEATH_RISK })],
    {},
    state,
    { now: now + 1, atAtomBoundary: true },
  );
  check('不可逆段在原子边界可被死亡风险抢占', r.choice?.id === 'drown');
}
{
  const state = createPriorityState(now);
  choosePriority([cand('current')], {}, state, { now, atAtomBoundary: true });
  const r = choosePriority(
    [cand('current'), cand('death', { consequence: CONSEQUENCE.DEATH_RISK })],
    {},
    state,
    { now: now + 1, atAtomBoundary: false },
  );
  check('非原子边界禁止抢占', r.choice?.id === 'current' && r.decision.code === 'atomic_boundary_required');
}
{
  const current = normalizeCandidate(cand('c'));
  const next = normalizeCandidate(cand('n', { priority: 60 }));
  check('canPreempt 同层高优先允许', canPreempt(current, next, { atAtomBoundary: true }).allowed === true);
  check('canPreempt 同层低优先拒绝', canPreempt(current, normalizeCandidate(cand('low', { priority: 40 })), { atAtomBoundary: true }).allowed === false);
}

{
  const state = createPriorityState(now);
  choosePriority([cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.IRREVERSIBLE })], {}, state, { now, atAtomBoundary: true });
  const r = choosePriority(
    [cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.IRREVERSIBLE, eligible: () => false }), cand('other', { priority: 1 })],
    {},
    state,
    { now: now + 1, atAtomBoundary: false },
  );
  check('current 失效但非边界 → pending_release，不释放', r.choice?.id === 'current' && r.decision.code === 'pending_release' && state.currentId === 'current');
}
{
  const state = createPriorityState(now);
  choosePriority([cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.RESUMABLE })], {}, state, { now, atAtomBoundary: true });
  const r = choosePriority(
    [cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.RESUMABLE, eligible: () => false }), cand('other', { priority: 1 })],
    {},
    state,
    { now: now + 1, atAtomBoundary: true },
  );
  check('current 失效且到边界 → current_ineligible 重选', r.choice?.id === 'other' && r.decision.code === 'current_ineligible' && r.decision.from === 'current' && r.previous?.id === 'current' && state.currentId === 'other');
}
{
  const state = createPriorityState(now);
  choosePriority([cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.IRREVERSIBLE })], {}, state, { now, atAtomBoundary: true });
  const r = choosePriority(
    [cand('current', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.IRREVERSIBLE, eligible: () => false }), cand('other', { priority: 1 })],
    {},
    state,
    { now: now + 1, atAtomBoundary: true },
  );
  check('不可逆 current 失效不得直接释放', r.choice?.id === 'current' && r.decision.code === 'irreversible_release_blocked');
}
{
  const current = normalizeCandidate(cand('c', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.IRREVERSIBLE }));
  const same = normalizeCandidate(cand('same', { consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, priority: 99 }));
  const death = normalizeCandidate(cand('death', { consequence: CONSEQUENCE.DEATH_RISK }));
  check('不可逆段拒绝同后果层抢占', canPreempt(current, same, { atAtomBoundary: true }).code === 'irreversible_commitment');
  check('不可逆段允许死亡风险抢占', canPreempt(current, death, { atAtomBoundary: true }).allowed === true);
}

console.log('\n保持/空/归一化：');
{
  const state = createPriorityState(now);
  choosePriority([cand('a', { priority: 70 }), cand('b', { priority: 20 })], {}, state, { now, atAtomBoundary: true });
  const r = choosePriority([cand('a', { priority: 70 }), cand('b', { priority: 20 })], {}, state, { now: now + 1, atAtomBoundary: true });
  check('当前仍最高 → keep_current', r.choice?.id === 'a' && r.decision.code === 'keep_current');
}
{
  const state = createPriorityState(now);
  const r = choosePriority([], {}, state, { now, atAtomBoundary: true });
  check('无候选 → null/no_eligible', r.choice === null && r.decision.code === 'no_eligible');
}
{
  const n = normalizeCandidate({ id: 'x', consequence: 'bogus', reversal: 'bogus' });
  check('非法 consequence 不静默降级', n?.consequence === null && n?.consequenceDeclared === false && n?.reversal === REVERSAL.RESUMABLE);
}
{
  const state = createPriorityState(now);
  choosePriority([{ id: 'no-consequence', priority: 99 }], {}, state, { now, atAtomBoundary: true });
  choosePriority([{ id: 'no-consequence', priority: 99 }], {}, state, { now: now + 1, atAtomBoundary: true });
  check('缺失 consequence 按声明去重计数', state.invalidConsequences === 1);
}
{
  const state = createPriorityState(now);
  const r = choosePriority([cand('death', { consequence: CONSEQUENCE.DEATH_RISK })], {}, state, { now, atAtomBoundary: true });
  const ev = priorityEvent(r);
  check('priorityEvent 可观测字段', ev.type === 'priority/decision' && ev.to === 'death' && ev.atAtomBoundary === true);
}

{
  check('数字 priority 兼容映射', consequenceFromScore(95) === CONSEQUENCE.DEATH_RISK && consequenceFromScore(75) === CONSEQUENCE.IRREVERSIBLE_LOSS && consequenceFromScore(30) === CONSEQUENCE.REVERSIBLE_NEED);
}

const result = { suite: 'priority', phase: 'A', passed: fail === 0, total: pass + fail, pass, fail, cases, generatedAt: new Date().toISOString() };
fs.writeFileSync('logs/priority-selftest.json', JSON.stringify(result, null, 2), 'utf8');
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

/**
 * Phase B 离线三场景：allowed preempt / denied / keep + action-tx 中断记账。
 * node probe/priority-preempt-selftest.mjs
 */
import fs from 'node:fs';
import { beginTx, settleTx, interruptTx } from '../src/action-tx.mjs';
import { decidePreemption, recordInterruption, beginCommitment, markPreempted, settleCommitment } from '../src/priority-preempt.mjs';
import { CONSEQUENCE, REVERSAL } from '../src/priority.mjs';

const now = 1_000_000;
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

const goal = (over = {}) => ({ id: 'g1', priority: 50, priorityClass: 'P4', ...over });
const hit = (id, priority) => ({ entry: { id, priority }, why: id });

console.log('离线三场景：');
{
  const r = decidePreemption({ goal: goal(), goalPriority: 50, priorityClass: 'P4', hit: hit('near_death', 95), now });
  const state = {};
  recordInterruption(state, r);
  check('allowed preempt', r.preempt === true && r.decision.code === 'preempt' && r.event.type === 'priority/decision');
  check('lane 语义：incomingConsequence 非空', r.incoming?.consequence === CONSEQUENCE.DEATH_RISK && r.event.incomingConsequence === CONSEQUENCE.DEATH_RISK);
  check('allowed 留下被打断承诺', state.priority?.interruptions?.length === 1 && state.priority.lastInterruption.from === 'goal:g1');
  check('preempted 单独计数', state.priorityStats?.preempted === 1);
  check('reason 覆盖计数', state.priorityStats?.decisions === 1 && state.priorityStats?.reasoned === 1);
}
{
  const r = decidePreemption({
    goal: goal({ priority: 75, reversal: REVERSAL.IRREVERSIBLE }),
    goalPriority: 75,
    priorityClass: 'P1',
    hit: hit('hostile_close_fight', 80),
    now,
  });
  check('denied：不可逆段拒同后果抢占', r.preempt === false && r.decision.code === 'irreversible_commitment', JSON.stringify(r.decision));
}
{
  const r = decidePreemption({
    goal: goal({ priority: 90, consequence: CONSEQUENCE.DEATH_RISK }),
    goalPriority: 90,
    priorityClass: 'P0',
    hit: hit('stuck', 85),
    now,
  });
  check('keep：低后果中断不抢死亡风险', r.preempt === false && r.decision.code === 'lower_consequence', JSON.stringify(r.decision));
}

console.log('\naction-tx 中断记账：');
{
  const tx = beginTx({ action: 'fight', reversal: REVERSAL.IRREVERSIBLE, consequence: CONSEQUENCE.IRREVERSIBLE_LOSS });
  settleTx(tx, { ok: true });
  interruptTx(tx, 'preempted', { by: 'interrupt:near_death', incomingConsequence: CONSEQUENCE.DEATH_RISK });
  check('不可逆中断不携带 success', tx.status === 'unknown' && tx.actionOk === null);
  check('不可逆中断 recovery=needs_settle', tx.recovery === 'needs_settle' && tx.interruptedBy === 'interrupt:near_death');
}
{
  const tx = beginTx({ action: 'atom:move', consequence: CONSEQUENCE.REVERSIBLE_NEED, reversal: REVERSAL.RESUMABLE, goalId: 'g1', atomId: 'move', parentTxId: 'txp' });
  check('atom tx 三级关联', tx.goalId === 'g1' && tx.atomId === 'move' && tx.parentTxId === 'txp');
}
{
  const tx = beginTx({ action: 'move', reversal: REVERSAL.RESUMABLE, consequence: CONSEQUENCE.REVERSIBLE_NEED });
  interruptTx(tx, 'preempted');
  check('可恢复中断 recovery=reconcile', tx.recovery === 'reconcile');
}

console.log('\ncurrent 生命周期：');
{
  const state = {};
  beginCommitment(state, { id: 'goal:g1', consequence: CONSEQUENCE.IRREVERSIBLE_LOSS, reversal: REVERSAL.IRREVERSIBLE });
  check('begin → active', state.priority.current?.status === 'active');
  markPreempted(state, { decision: { to: 'interrupt:near_death', code: 'preempt' } });
  check('抢占 → preempted', state.priority.current?.status === 'preempted' && state.priority.current.interruptedBy === 'interrupt:near_death');
  settleCommitment(state, { ok: false, status: 'interrupted' });
  check('settle → 清空 current', state.priority.current === null);
  check('settle 保留 pendingMs/finalStatus', state.priority.settled.at(-1)?.finalStatus === 'interrupted' && state.priority.settled.at(-1)?.pendingMs !== null);
}
{
  const r = decidePreemption({ goal: { id: 'legacy', priority: 50 }, goalPriority: 50, priorityClass: null, hit: hit('near_death', 95), now });
  const state = {};
  recordInterruption(state, r);
  check('legacy 缺声明 → fail-closed', r.preempt === false && r.decision.code === 'legacy_undeclared' && r.legacy === true);
  check('legacy 决策单独计数', state.priorityStats?.legacy === 1);
}

const result = { suite: 'priority-preempt', phase: 'B', passed: fail === 0, total: pass + fail, pass, fail, cases, generatedAt: new Date().toISOString() };
fs.writeFileSync('logs/priority-preempt-selftest.json', JSON.stringify(result, null, 2), 'utf8');
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

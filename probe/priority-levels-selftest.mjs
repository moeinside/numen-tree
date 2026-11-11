/**
 * Phase B L0–L5 选择审计：每层至少一条真实 decision（不是报告文学）。
 * node probe/priority-levels-selftest.mjs
 */
import { decidePreemption } from '../src/priority-preempt.mjs';

const now = 1_000_000;
let pass = 0;
let fail = 0;
const cases = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  cases.push({ name, ok, detail: ok ? '' : detail });
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const run = (goal, priorityClass, hitId, hitPriority) => decidePreemption({
  goal,
  goalPriority: goal.priority,
  priorityClass,
  hit: { entry: { id: hitId, priority: hitPriority } },
  now,
});

{
  const r = run({ id: 'l0', priority: 40 }, 'P3', 'near_death', 95);
  check('L0 反射：死亡风险改变选择', r.preempt === true && r.decision.code === 'preempt');
}
{
  const r = run({ id: 'l1', priority: 40 }, 'P3', 'hostile_close_fight', 70);
  check('L1 危机：不可逆损失改变选择', r.preempt === true && r.decision.code === 'preempt');
}
{
  const r = run({ id: 'l2', priority: 40 }, 'P3', 'night_danger', 80);
  check('L2 生存：夜间危险改变选择', r.preempt === true && r.decision.code === 'preempt');
}
{
  const r = run({ id: 'l3', priority: 91 }, 'P0', 'stuck', 85);
  check('L3 资源/工具：低后果不改变当前', r.preempt === false && r.decision.code === 'lower_consequence');
}
{
  const r = run({ id: 'l4', priority: 75, reversal: 'irreversible' }, 'P1', 'owner_danger_help', 78);
  check('L4 承诺：不可逆拒绝同后果', r.preempt === false && r.decision.code === 'irreversible_commitment');
}
{
  const r = run({ id: 'l5', priority: 50 }, 'P3', 'stuck', 20);
  check('L5 探索：低后果保持当前', r.preempt === false && r.decision.code === 'not_higher_priority');
}

const result = { suite: 'priority-levels', phase: 'B', passed: fail === 0, total: pass + fail, pass, fail, cases, generatedAt: new Date().toISOString() };
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

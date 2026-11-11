import {
  createDispatchWatchdog,
  observePlan,
  noteAtomBegin,
  checkDispatchWatchdog,
} from '../src/dispatch-watchdog.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}`); }
}

const plan = { id: 'pl1', status: 'active', cursor: 'chop', stepResults: [] };
{
  const s = createDispatchWatchdog();
  observePlan(s, plan, 1000);
  const r = checkDispatchWatchdog(s, plan, 5000, 20_000);
  check('刚开始不判 stalled', r.stalled === false);
}
{
  const s = createDispatchWatchdog();
  observePlan(s, plan, 1000);
  const r = checkDispatchWatchdog(s, plan, 30_000, 20_000);
  check('20s 无 atom/进展 → stalled', r.stalled === true && /无 atom/.test(r.reason));
}
{
  const s = createDispatchWatchdog();
  observePlan(s, plan, 1000);
  noteAtomBegin(s, 29_000);
  const r = checkDispatchWatchdog(s, plan, 30_000, 20_000);
  check('有 atom begin 不 stalled', r.stalled === false);
}
{
  const s = createDispatchWatchdog();
  observePlan(s, plan, 1000);
  const p2 = { ...plan, stepResults: [{}, {}], cursor: 'table' };
  observePlan(s, p2, 25_000);
  const r = checkDispatchWatchdog(s, p2, 30_000, 20_000);
  check('steps/cursor 变化重置计时', r.stalled === false);
}
{
  const s = createDispatchWatchdog();
  observePlan(s, plan, 1000);
  const done = { ...plan, status: 'done' };
  const r = checkDispatchWatchdog(s, done, 60_000, 20_000);
  check('非 active 不 stalled', r.stalled === false);
}

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

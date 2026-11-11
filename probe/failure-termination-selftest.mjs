import {
  TERMINATION_ACTION,
  createTerminationState,
  recordTerminationAttempt,
  isBlocked,
  clearTerminationAttempt,
} from '../src/failure-termination.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

{
  const s = createTerminationState();
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  check('首次失败允许重试', r.action === TERMINATION_ACTION.RETRY && r.code === 'retry');
}
{
  const s = createTerminationState();
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1', hasAlternate: true });
  check('同参数第 2 次失败 → switch', r.action === TERMINATION_ACTION.SWITCH && r.code === 'param_switch');
}
{
  const s = createTerminationState();
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1', hasAlternate: false });
  check('同参数第 2 次且无备选 → help', r.action === TERMINATION_ACTION.HELP && r.code === 'param_help');
}
{
  const s = createTerminationState();
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  check('同参数第 3 次 → abandon', r.action === TERMINATION_ACTION.ABANDON && r.code === 'param_limit');
  check('abandon 记录 blocked', !!isBlocked(s, 'strategy', 'p1'));
}
{
  const s = createTerminationState();
  recordTerminationAttempt(s, { scope: 'tactic', kind: 'failed', atomId: 'atom.x' });
  recordTerminationAttempt(s, { scope: 'tactic', kind: 'failed', atomId: 'atom.x' });
  const r = recordTerminationAttempt(s, { scope: 'tactic', kind: 'failed', atomId: 'atom.x' });
  check('同一原子第 3 次 → abandon', r.action === TERMINATION_ACTION.ABANDON && r.code === 'atom_limit');
}
{
  const s = createTerminationState();
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p2' });
  check('不同参数计数独立', r.action === TERMINATION_ACTION.RETRY && r.paramAttempts === 1);
}
{
  const s = createTerminationState();
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'timeout', paramKey: 'p1' });
  check('超时 → wait（有上限等待）', r.action === TERMINATION_ACTION.WAIT && r.code === 'wait_bounded');
}
{
  const s = createTerminationState();
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'timeout', paramKey: 'p1' });
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'timeout', paramKey: 'p1' });
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'timeout', paramKey: 'p1' });
  check('等待 3 次无进展 → abandon', r.action === TERMINATION_ACTION.ABANDON && r.code === 'wait_limit');
}
{
  const s = createTerminationState();
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  clearTerminationAttempt(s, 'strategy', 'p1');
  const r = recordTerminationAttempt(s, { scope: 'strategy', kind: 'no_path', paramKey: 'p1' });
  check('成功后清除，不永久 abandon', r.action === TERMINATION_ACTION.RETRY && !isBlocked(s, 'strategy', 'p1'));
}

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

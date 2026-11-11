import { diagnose, mergeDiagnosis } from '../src/diagnose.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}: ${actual} != ${expected}`);
  }
}

const plan = { id: 'pl1', status: 'active', startedAt: 0 };
const now = 30_000;

check('world delta → progressing',
  diagnose({ now, plan, progress: { worldDelta: 2 } }).verdict, 'progressing');
check('steps delta → progressing',
  diagnose({ now, plan, progress: { stepsDelta: 1 } }).verdict, 'progressing');
check('legal wait → waiting',
  diagnose({ now, plan, wait: { active: true, reason: 'night_hold', blockedBy: 'schedule' }, progress: {} }).verdict, 'waiting');
check('invalid wait → unknown',
  diagnose({ now, plan, wait: { active: true, reason: 'night_hold' }, progress: {} }).verdict, 'unknown');
check('action lock → waiting',
  diagnose({ now, plan, actionLock: { owner: 'g1', since: 1 }, progress: {} }).verdict, 'waiting');
check('active no progress → stalled',
  diagnose({ now, plan, progress: { lastProgressAt: 0 } }).verdict, 'stalled');
check('no plan/no evidence → unknown',
  diagnose({ now, plan: null, progress: {} }).verdict, 'unknown');
check('unknown is not stalled',
  diagnose({ now, plan: { id: 'pl2', status: 'suspended', startedAt: 0 }, progress: {} }).verdict, 'unknown');
check('contradiction outranks all',
  diagnose({ now, plan, contradiction: true, progress: { worldDelta: 1 } }).verdict, 'contradiction');
check('auto contradiction: active + no current + no wait/lock >=2s',
  diagnose({ now, plan, currentMissing: true, progress: { lastProgressAt: 0 } }).verdict, 'contradiction');
check('active no current but legal wait → waiting',
  diagnose({ now, plan, currentMissing: true, wait: { active: true, reason: 'night_hold', blockedBy: 'schedule' }, progress: {} }).verdict,
  'waiting');
check('world delta out of scope → unknown',
  diagnose({ now, plan, progress: { worldDelta: 5 }, worldDeltaScope: 'local', worldDeltaOutOfScope: true }).verdict,
  'unknown');

check('merge: live unknown → internal waiting',
  mergeDiagnosis({ verdict: 'unknown' }, { verdict: 'waiting', evidence: { wait: { reason: 'night' } } }).verdict,
  'waiting');
check('merge: explicit internal wait beats live stalled',
  mergeDiagnosis({ verdict: 'stalled' }, { verdict: 'waiting', evidence: { wait: { reason: 'night' } } }).verdict,
  'waiting');
check('merge: live progressing beats internal unknown',
  mergeDiagnosis({ verdict: 'progressing', evidence: {} }, { verdict: 'unknown' }).verdict, 'progressing');

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

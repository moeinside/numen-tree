import { dayPhase, statePhase } from '../src/time.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    pass += 1;
    console.log(`  ✓ ${name} = ${actual}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}: ${actual} != ${expected}`);
  }
}

check('day 边界 0', dayPhase(0), 'dawn');
check('morning 1000', dayPhase(1000), 'morning');
check('noon 5000', dayPhase(5000), 'noon');
check('afternoon 11000', dayPhase(11000), 'dusk');
check('night 13000', dayPhase(13000), 'night');
check('midnight 18000', dayPhase(18000), 'midnight');

// 关键回归：/time set day 后 gameTime 与 day_time 脱钩
const st = { gameTime: 2661758, dayTime: 6000, dark: false };
check('dayTime 优先，不用绝对 gameTime', statePhase(st), 'noon');

check('tentacle day_time 兜底', statePhase({ gameTime: 2661758, tentacleDayTime: 6000 }), 'noon');
check('无有效日时 → unknown（不拿绝对 gameTime 猜）', statePhase({ gameTime: 6000 }), 'unknown');
check('dark 兜底', statePhase({ dark: true }), 'night');

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

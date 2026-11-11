/**
 * 效用仲裁自测：node probe/arbiter-selftest.mjs
 */
import {
  abandonCandidate,
  chooseCandidate,
  createArbiterState,
  evaluateCandidates,
} from '../src/arbiter.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const T = 1_000_000;
const cand = (id, total, over = {}) => ({
  id,
  eligible: () => true,
  score: () => ({ total, parts: {} }),
  ...over,
});

console.log('选择：');
{
  const state = createArbiterState(T);
  const r = chooseCandidate([cand('a', 50), cand('b', 70)], {}, state, { now: T });
  check('选最高分 b', r.choice.id === 'b' && r.reason === 'utility');
}
{
  const state = createArbiterState(T);
  const r = chooseCandidate(
    [cand('u', 90), cand('hard', 0, { hard: true, hardPriority: 85 })],
    {},
    state,
    { now: T },
  );
  check('硬优先级压过更高分普通候选', r.choice.id === 'hard' && r.reason === 'hard');
}
{
  const state = createArbiterState(T);
  const r = chooseCandidate([], {}, state, { now: T });
  check('没有候选 → null', r.choice === null && r.reason === 'no_eligible');
}
{
  const state = createArbiterState(T);
  const r = chooseCandidate(
    [cand('bad', 0, { score: () => { throw new Error('boom'); } }), cand('ok', 40)],
    {},
    state,
    { now: T },
  );
  check('score 抛错的候选被跳过', r.choice.id === 'ok');
}

console.log('迟滞/最短运行：');
{
  const state = createArbiterState(T);
  // 初始 b=54 胜出，成为当前
  chooseCandidate([cand('a', 50), cand('b', 54)], {}, state, { now: T });
  const r = chooseCandidate([cand('a', 62), cand('b', 54)], {}, state, { now: T + 1000 });
  check('分差小于 margin → 保持当前 b', r.choice.id === 'b' && r.reason === 'hysteresis', JSON.stringify(r.lastChoice));
  const r2 = chooseCandidate([cand('a', 70), cand('b', 54)], {}, state, { now: T + 2000 });
  check('分差超过 margin → 切到 a', r2.choice.id === 'a' && r2.switched === true);
}
{
  const state = createArbiterState(T);
  chooseCandidate([cand('a', 90, { minRunSeconds: 10 }), cand('b', 50)], {}, state, { now: T });
  const r = chooseCandidate([cand('a', 90, { minRunSeconds: 10 }), cand('b', 99)], {}, state, { now: T + 5000 });
  check('最短运行时间内不切', r.choice.id === 'a' && r.reason === 'min_run', JSON.stringify(r));
  const r2 = chooseCandidate([cand('a', 90, { minRunSeconds: 10 }), cand('b', 99)], {}, state, { now: T + 11000 });
  check('超过最短运行时间后切', r2.choice.id === 'b');
}
{
  const state = createArbiterState(T);
  chooseCandidate([cand('u', 60)], {}, state, { now: T });
  const r = chooseCandidate([cand('u', 0), cand('h', 0, { hard: true, hardPriority: 90 })], {}, state, { now: T + 1000 });
  check('硬需求可抢占当前普通战略', r.choice.id === 'h' && r.reason === 'hard');
}

console.log('冷却/放弃：');
{
  const state = createArbiterState(T);
  chooseCandidate([cand('a', 50), cand('b', 70)], {}, state, { now: T });
  abandonCandidate(state, 'a', T, 30);
  const r = chooseCandidate([cand('a', 90), cand('b', 60)], {}, state, { now: T + 5000 });
  check('放弃后冷却中不重选 a', r.choice.id !== 'a', JSON.stringify(r.lastChoice));
}

console.log('防饿死：');
{
  const state = createArbiterState(T);
  chooseCandidate([cand('big', 90), cand('small', 10)], {}, state, { now: T });
  // small 等了 150 秒（+5 分），仍低于 90；再等很久最多 +10
  const evals = evaluateCandidates([cand('big', 90), cand('small', 10)], {}, state, { now: T + 150_000 });
  const small = evals.find((e) => e.id === 'small');
  check('等待 150s 后 small 获得 starvation 加分', small.total === 15, String(small.total));
}

console.log('');
console.log(`效用仲裁自测：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);

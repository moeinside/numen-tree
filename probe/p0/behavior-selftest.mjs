#!/usr/bin/env node
import {
  classifyFailure,
  createFailureState,
  recordFailure,
  failureBudgetExceeded,
} from '../../src/failure.mjs';
import { fatigueFactor, fatigueBand, effectiveAutoTimeout } from '../../src/behavior.mjs';

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

ck('timeout → retry', classifyFailure('timeout') === 'retry');
ck('not_found → switch', classifyFailure('not_found') === 'switch');
ck('no_rod → help', classifyFailure('no_rod') === 'help');
ck('同类两次无备选 → help', classifyFailure('not_found', { attempts: 2, hasAlternate: false }) === 'help');

const st = createFailureState();
const r1 = recordFailure(st, 'no_food', { scope: 'plan' });
const r2 = recordFailure(st, 'no_food', { scope: 'plan' });
const r3 = recordFailure(st, 'no_food', { scope: 'plan' });
ck('同类计数', r3.attempts === 3);
ck('同因三次 → shouldHelp', r3.shouldHelp === true);
ck('近期记录保留', r3.state.recent.length === 3);
ck('预算窗口判断', failureBudgetExceeded(st, { max: 2 }).exceeded === true);

ck('疲劳 0 → 1', fatigueFactor({ fatigue: 0 }) === 1);
ck('疲劳 1 → 0.55', Math.abs(fatigueFactor({ fatigue: 1 }) - 0.55) < 1e-9);
ck('疲劳分段', fatigueBand({ fatigue: 0.9 }) === 'exhausted');
ck('疲劳缩短自动预算', effectiveAutoTimeout(60_000, { fatigue: 1 }) === 33_000);
ck('疲劳有下限', effectiveAutoTimeout(1000, { fatigue: 1 }) === 5000);

console.log(`P0 A/C/D 自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

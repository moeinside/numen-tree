import { createLearningState, recordStrategyOutcome, learningBonus, describeLearning } from '../src/learning.mjs';

let p = 0;
let f = 0;
const ck = (n, v, d = '') => (v ? (p++, console.log(`  ✓ ${n}`)) : (f++, console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`)));

const t = Date.now();
const s = createLearningState();
recordStrategyOutcome(s, { strategyId: 'secure_food', ok: false, kind: 'no_food', ms: 3000, now: t });
ck('失败统计', s.strategies.secure_food.fail === 1);
ck('样本<3 不加成', learningBonus(s, 'secure_food') === 0);
recordStrategyOutcome(s, { strategyId: 'secure_food', ok: true, ms: 2000, now: t + 1 });
recordStrategyOutcome(s, { strategyId: 'secure_food', ok: true, ms: 2000, now: t + 2 });
ck('样本=3 后 EWMA 生效', learningBonus(s, 'secure_food') > 0, `bonus=${learningBonus(s, 'secure_food')}`);
const d = describeLearning(s);
ck('描述包含成功率', d.strategies.secure_food.successRate === 0.67 || d.strategies.secure_food.successRate === 0.66, JSON.stringify(d));
ck('最近事件保留', s.strategies.secure_food.recent.length === 3);

console.log(`窄学习自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

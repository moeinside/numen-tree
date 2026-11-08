// 计划层离线自测（不碰游戏、不碰网络）
import { Planner, decideAfterStep, planView, suspendPlan, resumePlan, planAlive } from '../src/plan.mjs';
import { RECIPES } from '../src/recipes.mjs';
import { pickInterrupt } from '../src/interrupts.mjs';

const planner = new Planner({ recipes: RECIPES });
let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    fails += 1;
    console.log('FAIL:', msg);
  } else {
    console.log('ok  :', msg);
  }
};

// 1) 意图匹配
const cases = [
  ['把木头存了', 'stock_wood'],
  ['存木头', 'stock_wood'],
  ['回家过夜', 'go_home'],
  ['回家', 'go_home'],
  ['找吃的', 'feed'],
  ['饿了', 'feed'],
  ['stock_wood', 'stock_wood'],
];
for (const [intent, want] of cases) {
  const m = planner.match(intent);
  ok(m.recipe?.id === want, `match「${intent}」→ ${m.recipe?.id}（期望 ${want}）why=${m.why ?? ''}`);
}
const miss = planner.match('去月球挖钻石');
ok(miss.error === 'no_recipe', `match 未知意图 → ${miss.error}`);

// 2) stock_wood 全流程推进
let plan = planner.build(planner.match('把木头存了').recipe, { intent: '把木头存了', source: 'llm' });
ok(plan.cursor === 'chop', `计划起点 chop（实际 ${plan.cursor}）`);
const stepOf = (p) => p.steps.find((s) => s.as === p.cursor);
let step = stepOf(plan);
let d = decideAfterStep(plan, step, { ok: true });
ok(d.kind === 'advance' && d.label === 'home', `chop ok → home（${JSON.stringify(d)}）`);
step = stepOf(plan);
d = decideAfterStep(plan, step, { ok: false, kind: 'not_found' });
ok(d.kind === 'advance' && d.label === 'report_nohome', `home not_found → report_nohome（${JSON.stringify(d)}）`);
step = stepOf(plan);
ok(step.type === 'report', 'report_nohome 是非技能步');
const view = planView(plan);
ok(view.recipeId === 'stock_wood' && view.steps_total === 7, `planView steps_total=${view.steps_total}`);

// 3) 箱子分支：store 失败 not_found → chest → store
plan = planner.build(planner.match('存木头').recipe, { intent: '存木头' });
plan.cursor = 'store';
plan.visits.store = 1;
step = stepOf(plan);
d = decideAfterStep(plan, step, { ok: false, kind: 'not_found' });
ok(d.kind === 'advance' && d.label === 'chest', `store not_found → chest（${JSON.stringify(d)}）`);
step = stepOf(plan);
d = decideAfterStep(plan, step, { ok: true });
ok(d.kind === 'advance' && d.label === 'store', `chest ok → store（${JSON.stringify(d)}）`);
step = stepOf(plan);
d = decideAfterStep(plan, step, { ok: true });
ok(d.kind === 'plan_done', `store ok → 计划完成（${JSON.stringify(d)}）`);

// 4) 重试上限：eat 连续 not_found 最多 3 次
plan = planner.build(planner.match('找吃的').recipe, { intent: '找吃的', source: 'auto' });
let guard = 0;
let lastD = null;
while (guard++ < 20) {
  step = stepOf(plan);
  if (!step) break;
  // 让所有技能步都失败 not_found（配方里 eat→forage→seek→report 会把流程推到 report）
  lastD = decideAfterStep(plan, step, { ok: false, kind: 'not_found' });
  if (lastD.kind === 'report' || lastD.kind === 'fail' || lastD.kind === 'plan_done') break;
}
ok(!!lastD && ['report', 'fail', 'plan_done'].includes(lastD.kind), `feed 失败环收敛到 ${lastD?.kind}`);

// 5) slot_blocked → 挂起；恢复
plan = planner.build(planner.match('把木头存了').recipe, { intent: '把木头存了' });
step = stepOf(plan);
d = decideAfterStep(plan, step, { ok: false, kind: 'slot_blocked' });
ok(d.kind === 'suspend', `slot_blocked → suspend（${JSON.stringify(d)}）`);
ok(suspendPlan(plan, 'slot_blocked') && plan.status === 'suspended', '计划挂起');
ok(resumePlan(plan) && plan.status === 'active' && planAlive(plan), '计划恢复');

// 6) 中断表
const baseState = {
  hp: 20,
  hunger: 20,
  hostileCount: 0,
  hostileDistance: null,
  dark: false,
  ownerOnline: true,
  ownerDistance: 4,
  lastInterruptAt: {},
};
const cfg = { behavior: { combat: { fleeHpPercent: 40, maxTargets: 2 }, survival: { nightGuardHpPercent: 80 } } };
ok(pickInterrupt({ state: { ...baseState, hp: 8, hostileCount: 1, hostileDistance: 4 }, cfg })?.entry.id === 'near_death', '低血+有敌 → near_death');
ok(pickInterrupt({ state: { ...baseState, hostileCount: 3 }, cfg }) === null, '三个敌人但满血 → 不被围撤离（不触发）');
ok(pickInterrupt({ state: { ...baseState, hostileCount: 3, hp: 10 }, cfg })?.entry.id === 'outnumbered', '三个敌人+血低 → outnumbered');
ok(pickInterrupt({ state: { ...baseState, dark: true, hostileCount: 1, hp: 12 }, cfg })?.entry.id === 'night_danger', '夜里+有敌+血不满 → night_danger');
ok(pickInterrupt({ state: { ...baseState }, cfg }) === null, '平安无事 → 无中断');
const cdState = { ...baseState, hp: 8, hostileCount: 1, lastInterruptAt: { near_death: Date.now() } };
ok(pickInterrupt({ state: cdState, cfg }) === null, '冷却内 → 不重复中断');

console.log(fails === 0 ? '\n=== 全部通过 ===' : `\n=== ${fails} 项失败 ===`);
process.exit(fails === 0 ? 0 : 1);

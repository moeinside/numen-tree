/**
 * 场景 2：包里有吃的（food=3）→ feed 计划一步 eat 成功 → 计划 done。
 *
 * 期望：只在没吃的时开 feed（hunger=6）；eat 成功一次就完成；
 *       自动计划完成只通知不叫醒（plan_done.needsBrain=false），
 *       自动行为成功不进 body 的 goal_done（docs/12 §3.2 报告预算）。
 */
import { obs, ok, check } from './_common.mjs';

export default {
  id: 'eat_first',
  title: '饥饿 6 / 背包有 3 个吃的 → feed 一步吃成功 → 计划 done、不叫醒大脑',
  // 本场景只回归 M1 的 feed 闭环；关掉日程（白天自动开工）以免多出 gather_wood 计划。
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [
    obs({ hunger: 6, food: 3, food_kinds: 1 }),
    obs({ hunger: 20, food: 0, food_kinds: 0 }),
  ],
  results(ctx, skill) {
    if (skill === 'eat') return ok({ ate: 1, item: 'minecraft:bread', hunger_before: 6, hunger: 20 });
    return ok();
  },
  done(ctx) {
    return ctx.plan()?.status === 'done' && ctx.observeCount >= 2;
  },
  maxTicks: 120,
  check(ctx) {
    const plan = ctx.plan();
    const planDone = ctx.inboxOf('plan_done').filter((i) => i.detail?.recipeId === 'feed');
    const stages = ctx.inboxOf('plan_stage');

    return [
      check(
        '自动开 feed 计划（source=auto）',
        ctx.inboxOf('plan_started').some(
          (i) => i.detail?.plan?.recipeId === 'feed' && i.detail.plan.source === 'auto',
        ),
        '',
      ),
      check('计划状态 done', plan?.status === 'done', `status=${plan?.status}`),
      check(
        'plan_done 不叫醒（自动计划只通知）',
        planDone.length === 1 && planDone[0].needsBrain === false,
        `plan_done=${planDone.length} needsBrain=${planDone[0]?.needsBrain}`,
      ),
      check(
        '没有 goal_done 进收件箱（自动行为成功只留 trace）',
        ctx.inboxOf('goal_done').length === 0,
        `goal_done=${ctx.inboxOf('goal_done').length}`,
      ),
      check(
        'eat 只调一次，没走 forage/seek_food',
        ctx.countSkill('eat') === 1 && ctx.countSkill('forage') === 0 && ctx.countSkill('seek_food') === 0,
        `调用 ${ctx.skills().join(',')}`,
      ),
      check('没有开第二个计划', ctx.state.planHistory.length === 1, `planHistory=${ctx.state.planHistory.length}`),
      check(
        '观测到吃完后的状态（hunger=20 / food=0）',
        ctx.state.hunger === 20 && ctx.state.foodCount === 0,
        `hunger=${ctx.state.hunger} food=${ctx.state.foodCount}`,
      ),
      check(
        'plan_stage 全部不叫醒（阶段通知预算）',
        stages.length > 0 && stages.every((i) => i.needsBrain === false),
        `stages=${stages.length}`,
      ),
    ];
  },
};

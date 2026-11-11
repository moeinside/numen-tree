/**
 * 场景 1（新版）：饥饿/没食物 → secure_food 探测失败 → 食物冷却，不反复重开 feed。
 *
 * 旧版期望“feed 计划跑两轮后 starving+停手”；现在改成：
 *  - 先尝试 secure_food/来源探测；
 *  - 失败后进入 foodRetryAt 冷却，不马上重开同一个 feed 计划；
 *  - 树不停手，允许其它计划接手。
 */
import { obs, ok, fail, check } from './_common.mjs';

export default {
  id: 'hungry',
  title: '饥饿/没食物 → secure_food 探测失败 → 食物冷却，不反复开 feed',
  observations: [obs({ hunger: 6, food: 0, food_kinds: 0, animal_n: 0 })],
  results(ctx, skill) {
    if (skill === 'eat') return fail('not_found', 'no food in inventory');
    if (skill === 'forage') return fail('not_found', 'no edible animal within 32 blocks');
    if (skill === 'seek_food') return ok({ food_before: 0, food: 0, chest: false, explored_s: 6 });
    return ok();
  },
  done(ctx) {
    return (
      ctx.ticks >= 90 ||
      (ctx.state.planHistory || []).some((p) => p.recipeId !== 'feed') ||
      ctx.inboxOf('starving').length > 0
    );
  },
  maxTicks: 150,
  check(ctx) {
    const skills = ctx.skills();
    const plans = ctx.state.planHistory || [];
    const feedPlans = plans.filter((p) => p.recipeId === 'feed');
    return [
      check(
        '先尝试了来源探测/觅食',
        skills.includes('find_block') || skills.includes('eat') || skills.includes('forage'),
        `skills=${skills.join(',')}`,
      ),
      check(
        '没有反复重开 feed 计划',
        feedPlans.length <= 1,
        `feedPlans=${feedPlans.length}`,
      ),
      check(
        '失败后进入食物冷却（foodRetryAt）',
        Number(ctx.state.foodRetryAt || 0) > Date.now(),
        `foodRetryAt=${ctx.state.foodRetryAt}`,
      ),
      check(
        '饥饿失败不停手（饿死也比卡着强）',
        !(Number(ctx.state.survivalHaltedUntil || 0) > Date.now()),
        `survivalHaltedUntil=${ctx.state.survivalHaltedUntil}`,
      ),
      check(
        '树继续做别的事（不是空转等食物）',
        plans.length >= 1,
        `plans=${plans.map((p) => p.recipeId).join(',')}`,
      ),
    ];
  },
};

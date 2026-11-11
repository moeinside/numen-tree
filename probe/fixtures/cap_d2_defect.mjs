/**
 * D2 缺陷场：无食物/无动物，只允许食物分支有界失败，不反复重开。
 */
import { obs, ok, fail, check } from './_common.mjs';

export default {
  id: 'cap_d2_defect',
  title: 'D2 缺陷场：无食物动物 → 失败收口、食物冷却、不全局面卡死',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs({ hunger: 6, food: 0, food_kinds: 0, animal_n: 0 })],
  results(ctx, skill) {
    if (skill === 'eat') return fail('not_found', 'no food');
    if (skill === 'forage') return fail('not_found', 'no animals');
    if (skill === 'seek_food') return ok({ food_before: 0, food: 0, chest: false, explored_s: 6 });
    return ok();
  },
  done(ctx) {
    return (ctx.state.planHistory ?? []).some((p) => p.status === 'failed') || ctx.ticks >= 90;
  },
  maxTicks: 110,
  check(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const feedPlans = plans.filter((p) => p.recipeId === 'feed');
    return [
      check('尝试了食物来源/觅食', ctx.skills().some((s) => ['eat', 'forage', 'seek_food', 'find_block'].includes(s)),
        `skills=${ctx.skills().join(',')}`),
      check('食物计划有界（≤1）', feedPlans.length <= 1, `feedPlans=${feedPlans.length}`),
      check('进入食物冷却', Number(ctx.state.foodRetryAt || 0) > Date.now(), `foodRetryAt=${ctx.state.foodRetryAt}`),
      check('没有全局面卡死（预算内结束）', ctx.ticks < 110, `ticks=${ctx.ticks}`),
    ];
  },
};

/**
 * D2 理想场：饥饿 → 发现背包食物 → 进食 → 计划完成。
 */
import { obs, ok, check } from './_common.mjs';

export default {
  id: 'cap_d2_ideal',
  title: 'D2 理想场：饥饿 6 / 背包有食物 → 进食闭环',
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
  maxTicks: 80,
  check(ctx) {
    const p = ctx.plan();
    return [
      check('D2 食物计划完成', p?.status === 'done', `status=${p?.status} recipe=${p?.recipeId}`),
      check('有进食动作', ctx.countSkill('eat') >= 1, `eat=${ctx.countSkill('eat')}`),
      check('没有空转 forage/seek', ctx.countSkill('forage') === 0 && ctx.countSkill('seek_food') === 0,
        `skills=${ctx.skills().join(',')}`),
      check('进食后状态更新', ctx.state.hunger === 20, `hunger=${ctx.state.hunger}`),
    ];
  },
};

/**
 * 场景 9：白天自动开工（gather_wood）失败 → plan_failed **只通知不叫醒**。
 *
 * 回归报告预算（docs/12 §3.2）：auto 计划失败不该推进大脑收件箱；
 * 之前 #escalate 默认 needsBrain=true，会自动开工失败也吵醒大脑。
 */
import { obs, ok, fail, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'auto_work_fail',
  title: '白天自动开工失败 → plan_failed 只通知不叫醒（报告预算）',
  places: [
    {
      name: '家',
      kind: 'base',
      dimension: 'minecraft:overworld',
      pos: HOME,
      note: 'fixture 预置的基地',
      source: 'cli',
    },
  ],
  observations: [
    obs({
      x: HOME.x + 1,
      y: HOME.y,
      z: HOME.z + 1,
      dark: false,
      hunger: 20,
      // 有武器 + 有镐/斧 → 不会走 bootstrap_kit / craft_tools；本场景只验 gather_wood 失败的报告预算
      weapon: 'minecraft:wooden_sword',
      weapon_score: 1,
      inv: [
        ['minecraft:stone_pickaxe', 1],
        ['minecraft:stone_axe', 1],
      ],
    }),
  ],
  results(ctx, skill) {
    if (skill === 'mine_nearby') return fail('not_found', '附近没有这种树');
    if (skill === 'dig_nearby') return fail('not_found', '附近没有这种树');
    if (skill === 'collect_items') return ok({ collected: 0 });
    if (skill === 'equip') return ok({ held: 'minecraft:stone_axe' });
    if (skill === 'explore') return ok({ seconds: 20 });
    return ok();
  },
  done(ctx) {
    return ctx.inboxOf('plan_failed').length > 0;
  },
  maxTicks: 200,
  check(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const wood = plans.find((p) => p.recipeId === 'gather_wood');
    const failed = ctx.inboxOf('plan_failed');
    const waking = ctx.inbox.items.filter((i) => i.needsBrain);
    return [
      check('gather_wood 计划最终失败', wood?.status === 'failed', String(wood?.status)),
      check('inbox 有 plan_failed', failed.length >= 1, `plan_failed=${failed.length}`),
      check(
        '自动计划失败只通知（needsBrain=false）',
        failed.length > 0 && failed.every((i) => i.needsBrain === false),
        failed.map((i) => i.needsBrain).join(','),
      ),
      check(
        '整场没有叫醒大脑的上报',
        waking.length === 0,
        JSON.stringify(waking.map((i) => i.kind)),
      ),
      check(
        '没有误开第三个计划（工具齐时只允许 mine_stone）',
        plans.filter((p) => !['gather_wood', 'mine_stone'].includes(p.recipeId)).length === 0,
        plans.map((p) => p.recipeId).join(','),
      ),
    ];
  },
};

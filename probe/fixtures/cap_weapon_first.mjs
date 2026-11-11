/**
 * 武器优先夹具：少量木头→工作台→木剑→换手，不做镐。
 */
import { obs, ok, fail, check } from './_common.mjs';

export default {
  id: 'cap_weapon_first',
  title: '武器优先：2 原木→工作台→木剑→换手',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs({ inv: [['minecraft:oak_log', 2]] })],
  setup(ctx) {
    const r = ctx.lane.startPlan({ intent: '先做武器', source: 'llm' });
    ctx.evidence.plan = r.plan ?? null;
    ctx.evidence.ok = r.ok;
  },
  results(ctx, skill) {
    if (skill === 'craft') return ok({ made: 1 });
    if (skill === 'place_block') return ok({ placed: 1 });
    if (skill === 'mine_nearby') return ok({ mined: 2 });
    if (skill === 'collect_items') return ok({ collected: 2 });
    if (skill === 'equip') return ok({ held: 'minecraft:wooden_sword' });
    return fail('not_found', 'fixture fail');
  },
  done(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'weapon_first');
    return ['done', 'failed'].includes(p?.status) || ctx.ticks >= 80;
  },
  maxTicks: 100,
  check(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'weapon_first');
    const labels = (p?.stepResults ?? []).map((r) => r.as);
    return [
      check('武器优先计划启动', !!p && ctx.evidence.ok !== false, String(ctx.evidence.ok)),
      check('计划完成', p?.status === 'done', `status=${p?.status} reason=${p?.reason}`),
      check('有工作台/放台步骤', labels.includes('table') && labels.includes('place'), labels.join(',')),
      check('有木剑合成步骤', labels.includes('sword'), labels.join(',')),
      check('有换剑步骤', labels.includes('equip_sword') || ctx.countSkill('equip') >= 1, `labels=${labels.join(',')} equip=${ctx.countSkill('equip')}`),
      check('没有做镐步骤', !labels.includes('pick'), labels.join(',')),
    ];
  },
};

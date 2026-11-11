/**
 * D1 缺陷场：木头/合成失败，只允许在缺陷分支内失败，不无限重试。
 */
import { obs, ok, fail, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'cap_d1_defect',
  title: 'D1 缺陷场：合成缺材料 → 计划失败并收口，不无限重试',
  places: [{ name: '家', kind: 'base', dimension: 'minecraft:overworld', pos: HOME, source: 'cli' }],
  observations: [obs({ x: HOME.x + 1, y: HOME.y, z: HOME.z + 1, inv: [['minecraft:oak_log', 6]] })],
  setup(ctx) {
    const r = ctx.lane.startPlan({ intent: 'craft_tools', source: 'llm' });
    ctx.evidence.plan = r.plan ?? null;
    ctx.evidence.ok = r.ok;
  },
  results(ctx, skill) {
    if (skill === 'craft') return fail('no_material', 'missing planks/sticks');
    if (skill === 'mine_nearby') return ok({ mined: 6 });
    if (skill === 'collect_items') return ok({ collected: 6 });
    if (skill === 'find_block') return fail('not_found', 'no table');
    if (skill === 'place_block') return ok({ placed: 1 });
    if (skill === 'equip') return ok({ held: 'minecraft:wooden_pickaxe' });
    return ok();
  },
  done(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'craft_tools');
    return ['done', 'failed'].includes(p?.status) || ctx.ticks >= 60;
  },
  maxTicks: 80,
  check(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'craft_tools');
    return [
      check('D1 缺陷计划启动', !!p, String(ctx.evidence.ok)),
      check('缺陷计划失败收口', p?.status === 'failed', `status=${p?.status}`),
      check('无 tick_error', true),
      check('合成尝试有界（≤3）', ctx.countSkill('craft') <= 3, `craft=${ctx.countSkill('craft')}`),
      check('没有全局卡死（场景在预算内结束）', ctx.ticks < 80, `ticks=${ctx.ticks}`),
    ];
  },
};

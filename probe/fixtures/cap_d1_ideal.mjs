/**
 * D1 理想场：木头资源 → 工作台 → 木镐/木斧 → 一次实际使用。
 * 契约级回放；不碰真实世界。
 */
import { obs, ok, fail, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'cap_d1_ideal',
  title: 'D1 理想场：木→工作台→木工具→一次使用',
  places: [{ name: '家', kind: 'base', dimension: 'minecraft:overworld', pos: HOME, source: 'cli' }],
  observations: [obs({ x: HOME.x + 1, y: HOME.y, z: HOME.z + 1, inv: [['minecraft:oak_log', 6], ['minecraft:stick', 2]] })],
  setup(ctx) {
    const r = ctx.lane.startPlan({ intent: 'craft_tools', source: 'llm' });
    ctx.evidence.plan = r.plan ?? null;
    ctx.evidence.ok = r.ok;
  },
  results(ctx, skill) {
    if (skill === 'craft') return ok({ made: 1 });
    if (skill === 'place_block') return ok({ placed: 1 });
    if (skill === 'mine_nearby') return ok({ mined: 6 });
    if (skill === 'collect_items') return ok({ collected: 6 });
    if (skill === 'explore') return ok({ seconds: 8 });
    if (skill === 'find_block') return fail('not_found', 'no table');
    if (skill === 'equip') return ok({ held: 'minecraft:wooden_pickaxe' });
    if (skill === 'move' || skill === 'go_to') return ok({ moved: 1 });
    return ok();
  },
  done(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'craft_tools');
    return ['done', 'failed'].includes(p?.status) || ctx.ticks >= 100;
  },
  maxTicks: 120,
  check(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'craft_tools') ?? ctx.evidence.plan;
    const labels = (p?.stepResults ?? []).map((r) => r.as);
    return [
      check('D1 计划启动', !!p && ctx.evidence.ok !== false, `${ctx.evidence.ok}/${p?.id}`),
      check('D1 计划完成', p?.status === 'done', `${p?.status}/${p?.reason}`),
      check('有合成动作', ctx.countSkill('craft') >= 1, `craft=${ctx.countSkill('craft')}`),
      check('有放工作台/方块步骤', labels.includes('place') || ctx.countSkill('place_block') >= 1, `labels=${labels.join(',')} place=${ctx.countSkill('place_block')}`),
      check('有装备动作', ctx.countSkill('equip') >= 1, `equip=${ctx.countSkill('equip')}`),
      check('未触发 abandon', !ctx.state.blocked, JSON.stringify(ctx.state.blocked)),
    ];
  },
};

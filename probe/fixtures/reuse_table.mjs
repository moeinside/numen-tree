/**
 * 场景 14：附近已有工作台 → craft_tools 直接复用，不再做新台子（回归 2026-11-08 实机问题）。
 *
 * 实机：同伴反复做好几个工作台。修法：配方先 find_block 搜现成台子，找到就跳到合成步骤。
 */
import { obs, ok, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'reuse_table',
  title: '已有工作台 → 直接复用（不再 craft+place 新台）',
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
      weapon: 'minecraft:wooden_sword',
      weapon_score: 1,
      inv: [['minecraft:stick', 2]],
    }),
  ],
  results(ctx, skill) {
    // 附近有现成工作台 → find_block 成功
    if (skill === 'find_block') return ok({ found: 1, x: HOME.x + 2, y: HOME.y, z: HOME.z, count: 1 });
    if (skill === 'craft') return ok({ made: 1 });
    if (skill === 'equip') return ok({ held: 'minecraft:wooden_pickaxe' });
    if (skill === 'mine_nearby') return ok({ mined: 8 });
    if (skill === 'collect_items') return ok({ collected: 8 });
    if (skill === 'explore') return ok({ seconds: 20 });
    return ok();
  },
  done(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'craft_tools');
    return p?.status === 'done' || ctx.ticks >= 120;
  },
  maxTicks: 150,
  check(ctx) {
    const plan = (ctx.state.planHistory ?? []).find((p) => p.recipeId === 'craft_tools') || null;
    const labels = (plan?.stepResults ?? []).map((r) => r.as);
    const waking = ctx.inbox.items.filter((i) => i.needsBrain);
    return [
      check('自动开了 craft_tools 计划', plan?.source === 'auto', String(plan?.source)),
      check('先走了 find_table（搜索已有台子）', labels.includes('find_table'), labels.join(',')),
      check('没有 craft 新工作台（没有 table 步）', !labels.includes('table'), labels.join(',')),
      check('没有放置新台子（没有 place 步）', !labels.includes('place'), labels.join(',')),
      check('只做了镐+斧（craft=2）', ctx.countSkill('craft') === 2, `craft=${ctx.countSkill('craft')}`),
      check('最后换手成镐', ctx.countSkill('equip') >= 1, `equip=${ctx.countSkill('equip')}`),
      check('不叫醒大脑', waking.length === 0, JSON.stringify(waking.map((i) => i.kind))),
    ];
  },
};

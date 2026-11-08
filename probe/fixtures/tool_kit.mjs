/**
 * 场景 13：有武器但缺采集工具（镐/斧）→ 白天自动 craft_tools（做镐+斧并换上镐）。
 *
 * 对应实机问题（2026-11-08 02:1x）：同伴拿着剑就不撒手、白天一直不补采集工具。
 * bootstrap_kit 只在"没武器"时触发，所以有剑之后必须由 craft_tools 补镐/斧。
 */
import { obs, ok, fail, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'tool_kit',
  title: '有剑缺镐/斧 → 自动 craft_tools（做木镐+木斧+换手）',
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
      food: 0,
      weapon: 'minecraft:wooden_sword', // 有武器 → bootstrap_kit 跳过
      weapon_score: 1,
      inv: [['minecraft:stick', 2]], // ★ 没有镐/斧 → craft_tools 触发
    }),
  ],
  results(ctx, skill) {
    if (skill === 'find_block') return fail('not_found', '附近没有现成工作台'); // 逼它走 craft+place
    if (skill === 'craft') return ok({ made: 1 });
    if (skill === 'place_block') return ok({ placed: 1 });
    if (skill === 'equip') return ok({ held: 'minecraft:wooden_pickaxe' });
    if (skill === 'mine_nearby') return ok({ mined: 8 });
    if (skill === 'collect_items') return ok({ collected: 8 });
    if (skill === 'explore') return ok({ seconds: 20 });
    return ok();
  },
  done(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const p = plans.find((x) => x.recipeId === 'craft_tools');
    return p?.status === 'done' || ctx.ticks >= 120;
  },
  maxTicks: 150,
  check(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const plan = plans.find((p) => p.recipeId === 'craft_tools') || null;
    const labels = (plan?.stepResults ?? []).map((r) => r.as);
    const waking = ctx.inbox.items.filter((i) => i.needsBrain);
    return [
      check('自动开了 craft_tools 计划（source=auto）', !!plan && plan.source === 'auto',
        plan ? `${plan.id}/${plan.source}/${plan.status}` : '没有 craft_tools 计划'),
      check('计划走完（done）', plan?.status === 'done', String(plan?.status)),
      check('有做工作台+放台', labels.includes('table') && labels.includes('place'), labels.join(',')),
      check('做了镐和斧（craft 次数 ≥3）', ctx.countSkill('craft') >= 3, `craft=${ctx.countSkill('craft')}`),
      check('最后换上镐（equip 被调用）', ctx.countSkill('equip') >= 1, `equip=${ctx.countSkill('equip')}`),
      check('补工具不叫醒大脑', waking.length === 0, JSON.stringify(waking.map((i) => i.kind))),
    ];
  },
};

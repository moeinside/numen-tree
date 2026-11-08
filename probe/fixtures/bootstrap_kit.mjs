/**
 * 场景 12：装备兜底（bootstrap_kit）——白天 + 没武器 + 没 LLM 目标 → 自动采集→工作台→木剑+木镐。
 *
 * 对应想法池 11.2：死亡重生后背包清空（weapon=null），树应该自己先做最低装备，
 * 而不是空手在夜里挨打。这里只验"日程 → 配方 → 步骤序列"这条链路（技能结果打桩）。
 */
import { obs, ok, fail, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'bootstrap_kit',
  title: '装备兜底：没武器 → 自动 bootstrap_kit（采集→工作台→木剑→木镐）',
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
      weapon: null, // ★ 没武器 = 兜底触发条件
      weapon_score: 0,
      inv: [],
    }),
  ],
  results(ctx, skill) {
    if (skill === 'find_block') return fail('not_found', '附近没有现成工作台'); // 逼它走 craft+place 分支
    if (skill === 'mine_nearby') return ok({ mined: 8, item: 'minecraft:spruce_log' });
    if (skill === 'collect_items') return ok({ collected: 8 });
    if (skill === 'craft') return ok({ made: 1 });
    if (skill === 'place_block') return ok({ placed: 1 });
    if (skill === 'equip') return ok({ held: 'minecraft:wooden_pickaxe' });
    if (skill === 'explore') return ok({ seconds: 20 });
    return ok();
  },
  done(ctx) {
    return ctx.plan()?.status === 'done' || ctx.plan()?.status === 'failed' || ctx.ticks >= 120;
  },
  maxTicks: 150,
  check(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const plan = plans.find((p) => p.recipeId === 'bootstrap_kit') || null;
    const labels = (plan?.stepResults ?? []).map((r) => r.as);
    const waking = ctx.inbox.items.filter((i) => i.needsBrain);
    return [
      check('自动开了 bootstrap_kit 计划（source=auto）', !!plan && plan.source === 'auto',
        plan ? `${plan.id}/${plan.source}/${plan.status}` : '没有 bootstrap_kit 计划'),
      check('计划走完（done）', plan?.status === 'done', String(plan?.status)),
      check('依次走了 采集→工作台→放台→木剑（最后一步木镐不记 stepResults，用 craft 次数覆盖）',
        labels.includes('collect') && labels.includes('table') && labels.includes('place') && labels.includes('sword'),
        labels.join(',')),
      check('采集用 mine_nearby（会走近挖）', ctx.countSkill('mine_nearby') >= 1, `mine_nearby=${ctx.countSkill('mine_nearby')}`),
      check('合成调了 craft（工作台/木剑/木镐）', ctx.countSkill('craft') >= 3, `craft=${ctx.countSkill('craft')}`),
      check('装备兜底完成不叫醒大脑', waking.length === 0, JSON.stringify(waking.map((i) => i.kind))),
    ];
  },
};

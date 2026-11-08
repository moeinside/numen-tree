/**
 * 场景 7：白天 + 有"家" + 没镐 → 日程自动开 gather_wood（不会开 mine_stone）。
 *
 * 期望：schedule=day、牵引绳放宽；自动计划 source=auto；完成一条就进冷却，不立刻重开。
 */
import { obs, ok, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'day_work',
  title: '白天自动开工 → gather_wood 计划 → 完成进冷却（无镐跳过 mine_stone）',
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
      // 有武器 + 有镐/斧 → 跳过 bootstrap_kit / craft_tools，直接 gather_wood
      weapon: 'minecraft:wooden_sword',
      weapon_score: 1,
      inv: [
        ['minecraft:stone_pickaxe', 1],
        ['minecraft:stone_axe', 1],
        ['minecraft:stick', 5],
      ],
    }),
  ],
  results(ctx, skill) {
    if (skill === 'mine_nearby') return ok({ block: 'minecraft:oak_log', mined: 8 });
    if (skill === 'dig_nearby') return ok({ block: 'minecraft:oak_log', dug: 8 });
    if (skill === 'collect_items') return ok({ collected: 8 });
    if (skill === 'equip') return ok({ held: 'minecraft:stone_axe' });
    if (skill === 'explore') return ok({ seconds: 20 });
    return ok();
  },
  done(ctx) {
    const plans = ctx.state.planHistory ?? [];
    // 等 gather_wood 完成、并给仲裁一点时间开 mine_stone（否则断言同 tick 竞态）
    if (plans.some((p) => p.recipeId === 'mine_stone')) return true;
    const woodDone = plans.some((p) => p.recipeId === 'gather_wood' && p.status === 'done');
    return (woodDone && ctx.ticks >= 25) || ctx.ticks >= 120;
  },
  maxTicks: 120,
  check(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const wood = plans.find((p) => p.recipeId === 'gather_wood');
    const stone = plans.find((p) => p.recipeId === 'mine_stone');
    return [
      check('日程选到 day', ctx.state.schedule?.id === 'day', JSON.stringify(ctx.state.schedule)),
      check(
        '白天牵引绳放宽到 48',
        ctx.state.schedule?.leashMaxDistance === 48,
        String(ctx.state.schedule?.leashMaxDistance),
      ),
      check(
        'trace 记录了日程切换',
        ctx.traceOf('schedule').length >= 1,
        ctx.traceOf('schedule').map((e) => e.note).join(' | '),
      ),
      check(
        '自动开了 gather_wood 计划（source=auto）',
        !!wood && wood.source === 'auto',
        wood ? `${wood.id} source=${wood.source} status=${wood.status}` : '没有 gather_wood 计划',
      ),
      check('gather_wood 计划正常完成', wood?.status === 'done', String(wood?.status)),
      check(
        '挖了木头（mine_nearby 被调用）',
        ctx.countSkill('mine_nearby') >= 1,
        `mine_nearby=${ctx.countSkill('mine_nearby')}`,
      ),
      check(
        '有镐 + 工具齐 → mine_stone 可以自动开（不会误走 craft_tools）',
        !!stone && stone.source === 'auto',
        stone ? `${stone.id} ${stone.source} ${stone.status}` : '没有 mine_stone 计划',
      ),
      check(
        'work 冷却已记账（不会立刻重开）',
        Number(ctx.state.lastAutoAt?.['work:gather_wood'] ?? 0) > 0,
        JSON.stringify(ctx.state.lastAutoAt),
      ),
    ];
  },
};

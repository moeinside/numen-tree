/**
 * 场景 15：LLM 接管方向盘（steering）——自动计划让位 + 宽限期不抢跑。
 *
 * 背景（2026-11-08 树模式测试报告）：树在执行自动计划（如 gather_wood/bootstrap）时，
 * LLM 下命令只能排队；两个指令之间的空隙自动行为又会立刻抢回方向盘。
 *
 * 期望（本场景锁定）：
 *  - 自动计划跑到一半时，LLM 下 tree_task（startPlan source=llm）→ 自动计划被 ABANDONED（不是等它跑完）；
 *  - LLM 计划完成后，宽限期（drive.autoGraceSeconds）内不再自动开新的 auto 计划；
 *  - 队列里排队的自动目标（note=auto:）被清掉。
 */
import { obs, ok, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'steer_yield',
  title: 'LLM 接管：自动计划让位 + 宽限期不抢方向盘',
  places: [
    { name: '家', kind: 'base', dimension: 'minecraft:overworld', pos: HOME, note: 'fixture', source: 'cli' },
  ],
  cfg: { drive: { autoGraceSeconds: 60 } },
  observations: [
    obs({
      x: HOME.x + 1,
      y: HOME.y,
      z: HOME.z + 1,
      dark: false,
      hunger: 20,
      weapon: 'minecraft:wooden_sword',
      weapon_score: 1,
      inv: [
        ['minecraft:stone_pickaxe', 1],
        ['minecraft:stone_axe', 1],
      ],
    }),
  ],
  setup(ctx) {
    // 先让树开一个自动计划（gather_wood）
    ctx.lane.startPlan({ intent: 'gather_wood', source: 'auto' });
  },
  results(ctx, skill) {
    if (skill === 'mine_nearby') return ok({ mined: 8, item: 'minecraft:spruce_log' });
    if (skill === 'dig_nearby') return ok({ dug: 8 });
    if (skill === 'collect_items') return ok({ collected: 8 });
    if (skill === 'equip') return ok({ held: 'minecraft:stone_axe' });
    if (skill === 'explore') return ok({ seconds: 20 });
    if (skill === 'go_to') return ok({ arrived: true, dist: 0 });
    if (skill === 'dig_nearby') return ok({ dug: 8 });
    return ok();
  },
  onTick(ctx) {
    // 等自动计划真的跑过一步（在途动作已结束）后，LLM 下任务接管
    if (ctx.evidence.tookOver) return;
    const plans = ctx.state.planHistory ?? [];
    const auto = plans.find((p) => p.recipeId === 'gather_wood' && p.source === 'auto');
    if (auto && (auto.stepResults?.length ?? 0) >= 1) {
      ctx.evidence.tookOver = true;
      const r = ctx.lane.startPlan({ intent: 'stock_wood', source: 'llm' });
      ctx.evidence.takeover = r;
    }
  },
  done(ctx) {
    return ctx.ticks >= 50;
  },
  maxTicks: 80,
  check(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const auto = plans.find((p) => p.recipeId === 'gather_wood' && p.source === 'auto');
    const llm = plans.find((p) => p.source === 'llm');
    const autoPending = ctx.state.goals.filter(
      (g) => g.status === 'pending' && typeof g.note === 'string' && g.note.startsWith('auto:'),
    );
    const autoPlansAfter = plans.filter((p) => p.source === 'auto' && p !== auto);
    return [
      check('LLM 任务成功接管（startPlan 返回 ok）', ctx.evidence.takeover?.ok === true, JSON.stringify(ctx.evidence.takeover?.reason ?? '')),
      check('自动计划被中止（abandoned，而非跑完）', auto?.status === 'abandoned', String(auto?.status)),
      check('LLM 计划存在（stock_wood source=llm）', llm?.recipeId === 'stock_wood', String(llm?.recipeId)),
      check('排队的自动目标被清掉', autoPending.length === 0, `autoPending=${autoPending.length}`),
      check('宽限期内没有再开新的自动计划', autoPlansAfter.length === 0, autoPlansAfter.map((p) => p.recipeId).join(',')),
    ];
  },
};

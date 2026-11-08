/**
 * 场景 4：夜里 + 有敌 + 血不满 + 地点簿有"家" → 中断 night_danger 开 go_home。
 *
 * 期望：go_home 计划 auto 启动；go_to 的 target 解析成"家"的坐标（不是 owner）；
 *       到家后进 hold（idle）；环境变白天/无怪后 doneWhen 让计划正常结束（done）。
 */
import { obs, ok, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };

export default {
  id: 'night',
  title: '夜间有敌 → night_danger 中断开 go_home → 走到"家"→ hold → 天亮 done（日程关闭的兜底路径）',
  // 2026-11-08 加入日程表（M1.5）后，有"家"的夜间守家默认由日程接管；
  // 本场景保留"日程关闭 / 没记家"时的 M1 中断兜底路径（night_danger → go_home）。
  cfg: { behavior: { schedule: { enabled: false } } },
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
    // 1) 夜里、有敌、血 60% → 触发 night_danger
    obs({ hp: 12, hunger: 20, food: 0, dark: true, hostile_n: 1, hostile_d: 10 }),
    // 2) 已经走到家附近，天还黑着 → 进 hold
    obs({ hp: 12, hunger: 20, food: 0, dark: true, hostile_n: 1, hostile_d: 12, x: 100, y: 64, z: -42 }),
    // 3) 天亮 + 无怪 + 血回满 → doneWhen 成立
    obs({ hp: 20, hunger: 20, food: 0, dark: false, hostile_n: 0, x: 100, y: 64, z: -42 }),
  ],
  results(ctx, skill) {
    if (skill === 'go_to') return ok({ x: HOME.x, y: HOME.y, z: HOME.z, left: 0, plan_s: 5, steps: 2 });
    if (skill === 'idle') return ok({ seconds: 15 });
    return ok();
  },
  done(ctx) {
    return ctx.plan()?.status === 'done' && ctx.state.plan === null;
  },
  maxTicks: 200,
  check(ctx) {
    const plan = ctx.plan();
    const labels = plan?.stepResults?.map((r) => r.as) ?? [];
    const homeGoal = ctx.state.goals.find(
      (g) => g.skill === 'go_to' && typeof g.note === 'string' && g.note.startsWith('step:'),
    );
    const planDone = ctx.inboxOf('plan_done').filter((i) => i.detail?.recipeId === 'go_home');

    return [
      check(
        'trace 记录 interrupt:night_danger',
        ctx.traceOf('interrupt').some((e) => String(e.note).startsWith('night_danger')),
        ctx.traceOf('interrupt').map((e) => e.note).join(' | '),
      ),
      check(
        '中断开了 go_home 计划（source=auto）',
        plan?.recipeId === 'go_home' && plan?.source === 'auto',
        `recipeId=${plan?.recipeId} source=${plan?.source}`,
      ),
      check(
        'go_to 的 target 是地点簿"家"的坐标（不是 owner）',
        !!homeGoal &&
          homeGoal.params?.target?.x === HOME.x &&
          homeGoal.params?.target?.y === HOME.y &&
          homeGoal.params?.target?.z === HOME.z &&
          homeGoal.params?.range === 4,
        homeGoal ? JSON.stringify(homeGoal.params) : '没有 go_to 步骤目标',
      ),
      check('第一步是 home 步、并进过 hold', labels[0] === 'home' && labels.includes('hold'), `labels=${labels.join(',')}`),
      check(
        'plan 正常结束（doneWhen：天亮+无怪+血满）',
        plan?.status === 'done',
        `status=${plan?.status} dark=${ctx.state.dark} hostile=${ctx.state.hostileCount} hp=${ctx.state.hp}`,
      ),
      check(
        'plan_done 只通知不叫醒（自动计划）',
        planDone.length === 1 && planDone[0].needsBrain === false,
        `plan_done=${planDone.length} needsBrain=${planDone[0]?.needsBrain}`,
      ),
      check(
        '计划结束后状态为白天/无怪',
        ctx.state.dark === false && ctx.state.hostileCount === 0 && ctx.state.plan === null,
        `dark=${ctx.state.dark} hostile=${ctx.state.hostileCount} plan=${ctx.state.plan ? 'alive' : 'null'}`,
      ),
      check(
        '地点簿"家"仍可解析（没被写坏）',
        !!ctx.places.find('家'),
        '',
      ),
      check(
        '没有 plan_resume 之类的误恢复（计划是正常结束）',
        ctx.traceOf('plan_resume').length === 0,
        `plan_resume=${ctx.traceOf('plan_resume').length}`,
      ),
    ];
  },
};

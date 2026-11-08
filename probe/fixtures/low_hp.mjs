/**
 * 场景 3：低血 8/20 + 敌对 1 个（距离 4）→ 中断 near_death 派 retreat。
 *
 * 期望：中断表（不是配方）接管；goals 里出现 interrupt:near_death 的 retreat 目标；
 *       trace 有 interrupt；中断动作成功属于"安全动作"，只留痕、不进收件箱。
 */
import { obs, ok, check } from './_common.mjs';

export default {
  id: 'low_hp',
  title: '低血 8/20 + 敌对 1 距离 4 → near_death 中断派 retreat',
  // 本场景只回归 M1 的中断抢占；关掉日程（白天自动开工）以免中断后多出 gather_wood 计划。
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs({ hp: 8, hunger: 20, food: 0, hostile_n: 1, hostile_d: 4 })],
  results(ctx, skill) {
    if (skill === 'retreat') return ok({ from: 'minecraft:zombie', id: 7 });
    return ok();
  },
  done(ctx) {
    return ctx.state.goals.some((g) => g.note === 'interrupt:near_death' && g.status === 'done');
  },
  maxTicks: 80,
  check(ctx) {
    const retreatGoal = ctx.state.goals.find((g) => g.note === 'interrupt:near_death');
    const interrupts = ctx.traceOf('interrupt');

    return [
      check(
        'trace 记录 interrupt:near_death',
        interrupts.some((e) => String(e.note).startsWith('near_death')),
        interrupts.map((e) => e.note).join(' | '),
      ),
      check(
        'goals 里出现 interrupt:near_death 的 retreat 目标',
        !!retreatGoal && retreatGoal.skill === 'retreat' && retreatGoal.status === 'done',
        retreatGoal ? `skill=${retreatGoal.skill} status=${retreatGoal.status}` : '没有该目标',
      ),
      check('retreat 实际下发并成功', ctx.countSkill('retreat') === 1, `调用 ${ctx.skills().join(',')}`),
      check('没有误开计划（安全中断走单技能）', ctx.plan() === null, `planHistory=${ctx.state.planHistory.length}`),
      check(
        '中断动作成功不进收件箱（不叫醒大脑）',
        ctx.inboxOf('goal_done').length === 0 && ctx.inboxOf('skill_failed').length === 0,
        `goal_done=${ctx.inboxOf('goal_done').length} skill_failed=${ctx.inboxOf('skill_failed').length}`,
      ),
      check(
        '冷却已记账（lastInterruptAt.near_death）',
        (ctx.state.lastInterruptAt.near_death ?? 0) > 0,
        `lastInterruptAt=${JSON.stringify(ctx.state.lastInterruptAt)}`,
      ),
      check('没有触发停手（不是求助类中断）', !ctx.state.survivalHaltedUntil, `halted=${ctx.state.survivalHaltedUntil}`),
    ];
  },
};

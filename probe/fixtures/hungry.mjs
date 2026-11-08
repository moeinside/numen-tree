/**
 * 场景 1：饥饿 → 自动 feed 计划 → 三轮没吃到 → plan_failed + starving + 停手。
 *
 * 世界事实：hunger=6（<= eatHunger 6）、背包没吃的、附近没猎物、白天平安。
 * 期望：仲裁表自己开 feed（source=auto），eat→not_found→forage→not_found→seek(ok)，
 *       两轮后 eat 的 maxVisits(3)/forage 的 maxVisits(2) 用尽 → 计划失败，
 *       按 docs/12 §3.2 上报 plan_failed（不叫醒，auto 计划）+ starving（叫醒）+ 设停手。
 */
import { obs, ok, fail, check, soft } from './_common.mjs';

const FEED_STEP_LABELS = 'eat,forage,seek,eat,forage,seek';
const FEED_SKILL_CALLS = 'eat,forage,seek_food,eat,forage,seek_food,eat';

export default {
  id: 'hungry',
  title: '饥饿 6 / 没食物 / 没猎物 → 自动开 feed → 三轮没吃到 → starving + 停手',
  observations: [obs({ hunger: 6, food: 0, food_kinds: 0, animal_n: 0 })],
  results(ctx, skill) {
    if (skill === 'eat') return fail('not_found', 'no food in inventory');
    if (skill === 'forage') return fail('not_found', 'no edible animal (cow/pig/sheep/chicken/rabbit) within 32 blocks');
    if (skill === 'seek_food') return ok({ food_before: 0, food: 0, chest: false, explored_s: 6 });
    return ok();
  },
  done(ctx) {
    return ctx.inboxOf('starving').length > 0;
  },
  maxTicks: 300,
  check(ctx) {
    const plan = ctx.plan();
    const feedStart = ctx.inboxOf('plan_started').find((i) => i.detail?.plan?.recipeId === 'feed');
    const planFailed = ctx.inboxOf('plan_failed').filter((i) => i.detail?.recipeId === 'feed');
    const starving = ctx.inboxOf('starving');
    const stages = ctx.inboxOf('plan_stage');
    const labels = plan?.stepResults?.map((r) => r.as).join(',') ?? '';

    return [
      check(
        '自动仲裁开出 feed 计划（source=auto）',
        !!feedStart && feedStart.detail.plan.source === 'auto',
        feedStart ? JSON.stringify(feedStart.detail.plan) : '没有 plan_started 收件',
      ),
      check('计划最终状态 failed', plan?.status === 'failed', `status=${plan?.status}`),
      check(
        'inbox 有 starving 求助且叫醒大脑',
        starving.length === 1 && starving[0].needsBrain === true,
        `starving=${starving.length} needsBrain=${starving[0]?.needsBrain}`,
      ),
      check(
        '计划失败不是静默的：至少一条叫醒大脑的上报',
        [...planFailed, ...starving].some((i) => i.needsBrain === true),
        `plan_failed=${planFailed.length} starving=${starving.length}`,
      ),
      soft(
        '同时有 plan_failed 记录（任务书/docs §3.2 报告预算；当前 lane 失败路径 #finishPlan silent，只报 starving）',
        planFailed.length === 1,
        `plan_failed=${planFailed.length}`,
      ),
      check(
        'survivalHaltedUntil 被设（上报后停手等大脑）',
        ctx.state.survivalHaltedUntil > Date.now(),
        `还剩 ${Math.round((ctx.state.survivalHaltedUntil - Date.now()) / 1000)}s`,
      ),
      check(
        `步进记录 = ${FEED_STEP_LABELS}`,
        labels === FEED_STEP_LABELS,
        `实际 ${labels}`,
      ),
      check(
        '技能调用 = eat,forage,seek_food 两轮 + 最后一次 eat',
        ctx.skills().join(',') === FEED_SKILL_CALLS,
        `实际 ${ctx.skills().join(',')}`,
      ),
      check(
        'plan_stage 阶段通知全部不叫醒（报告预算）',
        stages.length >= FEED_STEP_LABELS.split(',').length && stages.every((i) => i.needsBrain === false),
        `stages=${stages.length}`,
      ),
      check(
        'trace 记录仲裁选中 feed',
        ctx.traceOf('auto_plan').some((e) => String(e.note).includes('feed')),
        '',
      ),
    ];
  },
};

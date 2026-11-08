/**
 * 场景 5：连续 no_path（go_to 返回 no_path）→ stuckSince 被设 → 45s 后 stuck 中断。
 *
 * 做法（不真等 45 秒）：
 *   1) 先起一个 stock_wood 计划，挖木头成功后 go_to(家) 返回 no_path
 *      → 走真实的 `st.stuckSince ??= Date.now()`，并让计划按配方走到 report_nohome 失败；
 *   2) fixture.onTick 发现 stuckSince 已被真实代码设置后，把它回拨 50 秒（模拟"已经卡了 45 秒"）；
 *   3) 下一 tick 应命中 interrupts.mjs 的 stuck（halt 类）：上报 stuck + 设 survivalHaltedUntil。
 */
import { obs, ok, fail, check, soft } from './_common.mjs';

const NO_PATH = "can't stand where I am";

export default {
  id: 'stuck',
  title: 'go_to 连续 no_path → stuckSince → 45s 后 stuck 中断 + 上报 + 停手',
  // 本场景只回归 M1 的卡住中断；关掉日程（白天自动开工）以免失败后立刻开新计划，
  // 让 fixture 的"回拨时间"钩子能在"没有计划"的窗口里生效。
  cfg: { behavior: { schedule: { enabled: false } } },
  places: [
    {
      name: '家',
      kind: 'base',
      dimension: 'minecraft:overworld',
      pos: { x: 100, y: 64, z: -40 },
      note: 'fixture 预置的基地',
      source: 'cli',
    },
  ],
  observations: [obs(), obs(), obs(), obs()],
  setup(ctx) {
    // 预置一个 LLM 计划：chop(ok) → home(go_to 失败 no_path) → report_nohome
    ctx.lane.startPlan({ intent: 'stock_wood', source: 'llm' });
  },
  results(ctx, skill) {
    if (skill === 'dig_nearby') return ok({ dug: 8, left: 0, drops: 8 });
    if (skill === 'go_to') return fail('no_path', NO_PATH);
    return ok();
  },
  onTick(ctx) {
    const plan = ctx.state.plan;
    // 记录真实代码设置的 stuckSince（先于"回拨"证据）
    if (!ctx.evidence.stuckSinceReal && ctx.state.stuckSince) {
      ctx.evidence.stuckSinceReal = ctx.state.stuckSince;
    }
    // 计划走完（report_nohome 失败）后，把"卡了多久"回拨到 50 秒前
    if (!ctx.evidence.accelerated && !plan && ctx.state.stuckSince) {
      ctx.evidence.acceleratedAt = ctx.state.stuckSince;
      ctx.state.stuckSince = Date.now() - 50_000;
      ctx.evidence.accelerated = true;
    }
  },
  done(ctx) {
    return ctx.inboxOf('stuck').length > 0;
  },
  maxTicks: 200,
  check(ctx) {
    const plan = ctx.plan();
    const homeStep = plan?.stepResults?.find((r) => r.as === 'home' && r.kind === 'no_path');
    const goToCall = ctx.luaCalls.find((c) => c.skill === 'go_to');
    const stuckInbox = ctx.inboxOf('stuck');
    const interrupts = ctx.traceOf('interrupt');

    return [
      check(
        '真实代码因 no_path 设置了 stuckSince',
        ctx.evidence.stuckSinceReal > 0,
        `stuckSinceReal=${ctx.evidence.stuckSinceReal}`,
      ),
      check(
        'go_to 回执是 no_path（带回原文）',
        goToCall?.result?.kind === 'no_path' && String(goToCall?.result?.msg).includes('stand'),
        goToCall ? JSON.stringify(goToCall.result) : '没有 go_to 调用',
      ),
      check(
        '计划记录 home 步 no_path 并按 onFail 转移',
        !!homeStep,
        plan ? JSON.stringify(plan.stepResults) : '没有计划历史',
      ),
      check('计划最终 failed', plan?.status === 'failed', `status=${plan?.status}`),
      check(
        '计划失败有上报给大脑（no_home 或 plan_failed）',
        [...ctx.inboxOf('no_home'), ...ctx.inboxOf('plan_failed')].some((i) => i.needsBrain === true),
        `no_home=${ctx.inboxOf('no_home').length} plan_failed=${ctx.inboxOf('plan_failed').length}`,
      ),
      soft(
        'report_nohome 的 escalate=no_home 被保留（当前 plan.mjs cloneSteps 丢 escalate → 退化成 plan_failed）',
        ctx.inboxOf('no_home').length === 1,
        `no_home=${ctx.inboxOf('no_home').length} plan_failed=${ctx.inboxOf('plan_failed').length}`,
      ),
      check(
        'trace 记录 interrupt:stuck',
        interrupts.some((e) => String(e.note).startsWith('stuck')),
        interrupts.map((e) => e.note).join(' | '),
      ),
      check(
        'inbox 有 stuck 求助且叫醒大脑',
        stuckInbox.length === 1 && stuckInbox[0].needsBrain === true,
        `stuck=${stuckInbox.length} needsBrain=${stuckInbox[0]?.needsBrain}`,
      ),
      check(
        'survivalHaltedUntil 被设（卡住后停手等大脑）',
        ctx.state.survivalHaltedUntil > Date.now(),
        `还剩 ${Math.round((ctx.state.survivalHaltedUntil - Date.now()) / 1000)}s`,
      ),
      check(
        'stuckSince 仍是"45 秒前"（回拨后未被清掉）',
        ctx.state.stuckSince != null && Date.now() - ctx.state.stuckSince >= 45_000,
        `已卡 ${Math.round((Date.now() - (ctx.state.stuckSince ?? Date.now())) / 1000)}s`,
      ),
      check('没有开第二个计划', ctx.state.planHistory.length === 1, `planHistory=${ctx.state.planHistory.length}`),
    ];
  },
};

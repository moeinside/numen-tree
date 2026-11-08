/**
 * 场景：本能让路（reflex / built-in brain 占用 Lua 槽）。
 * 期望（docs/19 §15）：
 *  - 补丁 /status count=0 表示"内置脑在动" → 树不 unlock、不把 slotBlocked 计成僵尸锁；
 *  - 树进入 instinct_busy 并让路；
 *  - 不产生 slot_blocked 求助、不叫醒大脑。
 */
import { obs, check } from './_common.mjs';

const BLOCKED_MSG = 'a program is already running for this companion, or its built-in brain is acting';

export default {
  id: 'instinct_yield',
  title: '本能让路：内置脑占用槽 → 不清锁、不抢、等待',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs(), obs()],
  lockfix(ctx) {
    return {
      calls: [],
      async unlock(args) {
        this.calls.push(args);
        return { ok: true, cleared: 1, patch: '1.1.0' };
      },
      async status() {
        // count=0：没有我们的程序在跑 → 是内置脑/本能，不是僵尸锁
        return { ok: true, patch: '1.1.0', foundClass: true, count: 0, running: [] };
      },
    };
  },
  observeError(ctx, skill) {
    if (skill !== 'observe') return null;
    return { kind: 'error', message: BLOCKED_MSG };
  },
  done(ctx) {
    return ctx.ticks >= 30;
  },
  maxTicks: 60,
  check(ctx) {
    const calls = ctx.lockfix?.calls ?? [];
    return [
      check('没有调用 unlock（不抢本能）', calls.length === 0, `calls=${calls.length}`),
      check('trace 记录 instinct_busy', ctx.traceOf('instinct_busy').length >= 1, String(ctx.traceOf('instinct_busy').length)),
      check('slotBlocked 没被当成僵尸锁计数', (ctx.state.slotBlocked ?? 0) === 0, String(ctx.state.slotBlocked)),
      check('没有 slot_blocked 求助上报', ctx.inboxOf('slot_blocked').length === 0, String(ctx.inboxOf('slot_blocked').length)),
      check('没有叫醒大脑的上报', ctx.inbox.items.filter((i) => i.needsBrain).length === 0, ''),
      check('没有 tick_error', ctx.traceOf('tick_error').length === 0, ''),
    ];
  },
};

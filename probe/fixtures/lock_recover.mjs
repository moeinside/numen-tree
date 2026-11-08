/**
 * 场景 11：僵尸锁外部清理（补丁 v3 的 127.0.0.1:8768）。
 *
 * 期望：Lua 槽连续被拒 2 次 → 树自动调补丁清锁（不重建同伴、不丢背包、不叫醒大脑）；
 *       清完立刻恢复观测，不进入"第 3 次上报 slot_blocked"的兜底路径。
 *
 * 打桩：fixture.lockfix 注入假客户端；observeError 让前两次慢观测返回 mod 的原始错误文案。
 */
import { obs, check } from './_common.mjs';

const BLOCKED_MSG = 'a program is already running for this companion, or its built-in brain is acting';

export default {
  id: 'lock_recover',
  title: '僵尸锁：连报 2 次 blocked → 外部补丁清锁（不重建、不叫醒）',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs(), obs(), obs()],
  lockfix(ctx) {
    return {
      calls: [],
      async unlock(args) {
        this.calls.push(args);
        return { ok: true, cleared: 1, patch: '1.1.0' };
      },
      async status() {
        // 僵尸锁场景：补丁能看到"有程序在跑"（count>0），树才会去清
        return { ok: true, patch: '1.1.0', foundClass: true, count: 1, running: [{ program: 'ext-test' }] };
      },
    };
  },
  observeError(ctx, skill) {
    if (skill !== 'observe') return null; // 只让慢观测报锁（快观测不计数）
    ctx.evidence.slowObs = (ctx.evidence.slowObs || 0) + 1;
    if (ctx.evidence.slowObs <= 2) {
      return { kind: 'error', message: BLOCKED_MSG };
    }
    return null;
  },
  done(ctx) {
    // 慢观测有 1s 最小间隔（lane #maybeObserve 防刷屏下限）；回放 tickMs=8，
    // 要留够真实时间让第 2 次 blocked 观测发生（约 1s ≈ 125 ticks）。
    return ctx.inboxOf('lock_unlock').length > 0 || ctx.ticks >= 180;
  },
  maxTicks: 240,
  check(ctx) {
    const calls = ctx.lockfix?.calls ?? [];
    const unlocked = ctx.inboxOf('lock_unlock');
    const blockedNotice = ctx.inboxOf('slot_blocked');
    const waking = ctx.inbox.items.filter((i) => i.needsBrain);
    return [
      check('自动调了补丁清锁（1 次）', calls.length === 1, `calls=${calls.length}`),
      check('清锁用的是本同伴 UUID', calls[0]?.uuid === ctx.state.id, JSON.stringify(calls[0])),
      check('trace 记录 lock_unlock', ctx.traceOf('lock_unlock').length >= 1, JSON.stringify(ctx.traceOf('lock_unlock'))),
      check('inbox 有 lock_unlock 通知', unlocked.length >= 1, `lock_unlock=${unlocked.length}`),
      check('清锁通知不叫醒大脑（needsBrain=false）', unlocked.every((i) => i.needsBrain === false), unlocked.map((i) => i.needsBrain).join(',')),
      check('没有走到"第 3 次 blocked"的求助上报', blockedNotice.length === 0, `slot_blocked=${blockedNotice.length}`),
      check('slotBlocked 计数已清零', ctx.state.slotBlocked === 0, String(ctx.state.slotBlocked)),
      check('整场没有叫醒大脑的上报', waking.length === 0, JSON.stringify(waking.map((i) => i.kind))),
      check('没有重建/其它异常（没有 tick_error）', ctx.traceOf('tick_error').length === 0, ''),
    ];
  },
};

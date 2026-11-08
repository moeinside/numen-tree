/**
 * 场景 10：task_finished 事件映射（回归 2026-11-08 夜里的误报）。
 *
 * 实测 mod 的任务收尾事件 status='done'（成功到达），旧代码只认 'completed' → 全部误报 task_failed；
 * 而且 reflex 自己的 move.go 任务也被当成"树的求助"叫醒大脑。
 *
 * 期望：
 *  - 非树派发的任务（detachedTask 不匹配）只留 trace，不进收件箱、不叫醒；
 *  - 树自己派发的任务（detachedTask.taskId 匹配）status='done' → task_done、needsBrain=false，并清 detachedTask；
 *  - 整场没有 task_failed。
 */
import { obs, check } from './_common.mjs';

export default {
  id: 'task_events',
  title: 'task_finished 映射：done=成功、reflex 任务只留痕、不叫醒大脑',
  // 本场景只测事件映射，关掉日程避免自动开工干扰收件箱。
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs(), obs(), obs()],
  setup(ctx) {
    // 假装树派过一个后台任务 t9（目前没有技能会 detach，先验证映射与清理）
    ctx.state.detachedTask = { taskId: 't9', skill: 'go_to', at: new Date().toISOString() };
  },
  events: [
    // 1) mod reflex 自己的 move.go 任务到达：非树派发 → 只留痕
    {
      kind: 'task_finished',
      id: 't1',
      task: 'numen.move.go',
      status: 'done',
      message: 'arrived within 1 blocks of -100,64,59',
    },
    // 2) 树派发的后台任务成功：status='done' 是成功，不是失败
    {
      kind: 'task_finished',
      id: 't9',
      task: 'numen.move.go',
      status: 'done',
      message: 'arrived within 1 blocks of -95,66,54',
    },
  ],
  done(ctx) {
    return ctx.inboxOf('task_done').length > 0 || ctx.ticks >= 5;
  },
  maxTicks: 60,
  check(ctx) {
    const done = ctx.inboxOf('task_done');
    const failed = ctx.inboxOf('task_failed');
    const waking = ctx.inbox.items.filter((i) => i.needsBrain);
    return [
      check('没有误报 task_failed（status=done 是成功）', failed.length === 0, `task_failed=${failed.length}`),
      check('树派发的任务收尾有 task_done', done.length === 1, `task_done=${done.length}`),
      check('task_done 带任务号 t9', done[0]?.taskId === 't9', String(done[0]?.taskId)),
      check('task_done 只通知不叫醒（needsBrain=false）', done[0]?.needsBrain === false, String(done[0]?.needsBrain)),
      check('detachedTask 已清空', !ctx.state.detachedTask, JSON.stringify(ctx.state.detachedTask)),
      check('整场没有叫醒大脑的上报', waking.length === 0, JSON.stringify(waking.map((i) => i.kind))),
    ];
  },
};

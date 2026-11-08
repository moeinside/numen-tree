/**
 * 场景：reflex 事件 → 执行档位立即降为 field-guarded（行为证据，不看位置）。
 */
import { obs, check } from './_common.mjs';

export default {
  id: 'exec_mode',
  title: 'reflex 事件 → 执行档位降级（safe-batch → field-guarded）',
  cfg: { behavior: { schedule: { enabled: false } } },
  observations: [obs()],
  events: [{ kind: 'reflex', message: 'ran from a fight I could not take' }],
  eventsWhen(ctx) {
    return ctx.ticks >= 5;
  },
  done(ctx) {
    return ctx.ticks >= 40;
  },
  maxTicks: 80,
  check(ctx) {
    return [
      check('execMode 降为 field-guarded', ctx.state.execMode === 'field-guarded', String(ctx.state.execMode)),
      check('execReason 是 reflex', ctx.state.execReason === 'reflex', String(ctx.state.execReason)),
      check('trace 记录 exec_mode', ctx.traceOf('exec_mode').length >= 1, String(ctx.traceOf('exec_mode').length)),
      check('trace 记录 instinct_busy', ctx.traceOf('instinct_busy').length >= 1, String(ctx.traceOf('instinct_busy').length)),
      check('没有 tick_error', ctx.traceOf('tick_error').length === 0, ''),
    ];
  },
};

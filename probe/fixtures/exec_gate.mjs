/**
 * 场景：执行闸门（field-guarded 禁长技能）。
 * reflex → field-guarded；随后下一个长技能目标（craft）应被拒绝为 deferred_field_guarded，
 * 不产生 craft 的 Lua 调用，trace 有 exec_gate。
 */
import { obs, check } from './_common.mjs';
import { makeGoal } from '../../src/state.mjs';

export default {
  id: 'exec_gate',
  title: '执行闸门：field-guarded 拒绝长技能',
  cfg: { behavior: { schedule: { enabled: false }, instinctHoldSeconds: 0 } },
  observations: [obs(), obs(), obs()],
  events: [{ kind: 'reflex', message: 'ran from a fight I could not take' }],
  eventsWhen(ctx) {
    return ctx.ticks >= 2;
  },
  onTick(ctx) {
    if (ctx.evidence.gatedGoal) return;
    if (ctx.state.execMode === 'field-guarded' && ctx.ticks >= 8) {
      const g = makeGoal({
        skill: 'craft',
        params: { item: 'minecraft:stick', chain: true },
        priority: 40,
        note: 'mcp',
      });
      ctx.evidence.gatedGoal = g;
      ctx.lane.state.pushGoal(g);
    }
  },
  done(ctx) {
    return ctx.ticks >= 30;
  },
  maxTicks: 60,
  check(ctx) {
    const g = ctx.evidence.gatedGoal;
    return [
      check('execMode 已降为 field-guarded', ctx.state.execMode === 'field-guarded', String(ctx.state.execMode)),
      check('长技能目标被拒绝（deferred_field_guarded）', g?.lastResult?.kind === 'deferred_field_guarded', JSON.stringify(g?.lastResult)),
      check('trace 记录 exec_gate', ctx.traceOf('exec_gate').length >= 1, String(ctx.traceOf('exec_gate').length)),
      check('没有执行 craft 的 Lua 调用', !ctx.luaCalls.some((c) => c.skill === 'craft'), String(ctx.luaCalls.length)),
      check('没有 tick_error', ctx.traceOf('tick_error').length === 0, ''),
    ];
  },
};

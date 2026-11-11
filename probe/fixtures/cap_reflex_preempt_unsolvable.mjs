/**
 * Fixture_Reflex_Preempt 不可解臂：
 * 无武器 + 敌对持续 + 无木料；只允许有界失败，不允许无限重开。
 */
import { obs, fail, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };
const threat = () => obs({ x: HOME.x, y: HOME.y, z: HOME.z, hostile_n: 3, hostile_d: 2, inv: [] });

export default {
  id: 'cap_reflex_preempt_unsolvable',
  title: '反射抢占不可解臂：持续威胁 + 无木料 → 有界失败',
  cfg: { behavior: { schedule: { enabled: false } } },
  places: [{ name: '家', kind: 'base', dimension: 'minecraft:overworld', pos: HOME, source: 'cli' }],
  observations: [threat(), threat(), threat(), threat()],
  setup(ctx) {
    const r = ctx.lane.startPlan({ intent: '先做武器', source: 'llm' });
    ctx.evidence.plan = r.plan ?? null;
    ctx.evidence.ok = r.ok;
  },
  results(ctx, skill) {
    if (skill === 'mine_nearby') return fail('not_found', 'no wood in fixture');
    return fail('not_found', 'fixture fail');
  },
  done(ctx) {
    return ctx.ticks >= 60;
  },
  maxTicks: 80,
  check(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'weapon_first');
    return [
      check('不可解臂计划已创建或未启动', ctx.evidence.ok === false || !!p, String(ctx.evidence.ok)),
      check('没有完成木剑', ctx.countSkill('equip') === 0, `equip=${ctx.countSkill('equip')}`),
      check('有界结束（未无限跑）', ctx.ticks < 80, `ticks=${ctx.ticks}`),
      check('无 tick_error', (ctx.lane.state.tickErrors ?? 0) === 0, String(ctx.lane.state.tickErrors)),
      check('计划未假装完成', p?.status !== 'done', `status=${p?.status}`),
    ];
  },
};

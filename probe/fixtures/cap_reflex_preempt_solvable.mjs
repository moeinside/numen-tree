/**
 * Fixture_Reflex_Preempt 可解臂：
 * 无武器 + 敌对贴脸 → 计划先让路；安全窗口出现后完成 weapon_first。
 */
import { obs, ok, fail, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };
const threat = () => obs({ x: HOME.x, y: HOME.y, z: HOME.z, hostile_n: 2, hostile_d: 2, inv: [['minecraft:oak_log', 2]] });
const safe = () => obs({ x: HOME.x, y: HOME.y, z: HOME.z, hostile_n: 0, hostile_d: null, inv: [['minecraft:oak_log', 2]] });

export default {
  id: 'cap_reflex_preempt_solvable',
  title: '反射抢占可解臂：先让路，安全窗口后做出木剑',
  cfg: { behavior: { schedule: { enabled: false } } },
  places: [{ name: '家', kind: 'base', dimension: 'minecraft:overworld', pos: HOME, source: 'cli' }],
  observations: [safe()],
  setup(ctx) {
    const r = ctx.lane.startPlan({ intent: '先做武器', source: 'llm' });
    ctx.evidence.plan = r.plan ?? null;
    ctx.evidence.ok = r.ok;
  },
  results(ctx, skill) {
    if (skill === 'mine_nearby') return ok({ mined: 2 });
    if (skill === 'collect_items') return ok({ collected: 2 });
    if (skill === 'craft') return ok({ made: 1 });
    if (skill === 'place_block') return ok({ placed: 1 });
    if (skill === 'equip') return ok({ held: 'minecraft:wooden_sword' });
    return fail('not_found', 'fixture fail');
  },
  done(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'weapon_first');
    return ['done', 'failed'].includes(p?.status) || ctx.ticks >= 120;
  },
  maxTicks: 150,
  check(ctx) {
    const p = (ctx.state.planHistory ?? []).find((x) => x.recipeId === 'weapon_first');
    return [
      check('可解臂计划启动', !!p, String(ctx.evidence.ok)),
      check('可解臂完成', p?.status === 'done', `status=${p?.status} reason=${p?.reason}`),
      check('完成木剑合成', ctx.countSkill('craft') >= 1, `craft=${ctx.countSkill('craft')}`),
      check('完成换剑', ctx.countSkill('equip') >= 1, `equip=${ctx.countSkill('equip')}`),
      check('最终安全模式', ctx.state.execMode === 'safe-batch', `exec=${ctx.state.execMode}/${ctx.state.execReason}`),
      check('没有 abandon', !ctx.state.blocked, JSON.stringify(ctx.state.blocked)),
    ];
  },
};

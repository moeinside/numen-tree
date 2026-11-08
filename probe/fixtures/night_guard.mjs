/**
 * 场景 8：夜里 + 有"家" + 有武器 + 敌对 9 格 → 日程接管守家。
 *
 * 期望：schedule=night、牵引绳收紧到 16、night_danger 不再开 go_home 计划；
 *       敌对进守家半径（10）→ 自动 guard（fight_safe）；
 *       威胁解除 → 自动 patrol（绕家四角走一个路点）。
 */
import { obs, ok, check } from './_common.mjs';

const HOME = { x: 100, y: 64, z: -40 };
const PATROL_RADIUS = 6;

export default {
  id: 'night_guard',
  title: '夜间守家：日程接管 → 敌对进圈自动打 → 威胁解除自动巡逻',
  places: [
    {
      name: '家',
      kind: 'base',
      dimension: 'minecraft:overworld',
      pos: HOME,
      note: 'fixture 预置的基地',
      source: 'cli',
    },
  ],
  observations: [
    // 1) 夜里、有武器、敌对 9 格（在守家半径 10 内）
    obs({
      x: HOME.x,
      y: HOME.y,
      z: HOME.z,
      dark: true,
      weapon: 'minecraft:stone_sword',
      weapon_score: 2,
      hostile_n: 1,
      hostile_d: 9,
    }),
    // 2) 威胁解除
    obs({
      x: HOME.x,
      y: HOME.y,
      z: HOME.z,
      dark: true,
      weapon: 'minecraft:stone_sword',
      weapon_score: 2,
      hostile_n: 0,
      hostile_d: null,
    }),
  ],
  results(ctx, skill) {
    if (skill === 'fight_safe') return ok({ killed: 1, gave_up: false });
    if (skill === 'go_to') return ok({ arrived: true, dist: 0, chunks: 0 });
    return ok();
  },
  done(ctx) {
    return ctx.state.goals.some((g) => g.note === 'auto:patrol' && g.status === 'done');
  },
  maxTicks: 150,
  check(ctx) {
    const plans = ctx.state.planHistory ?? [];
    const guard = ctx.state.goals.find((g) => g.note === 'auto:guard');
    const patrol = ctx.state.goals.find((g) => g.note === 'auto:patrol');
    const nightDanger = ctx.traceOf('interrupt').filter((e) => String(e.note).startsWith('night_danger'));
    return [
      check('日程选到 night', ctx.state.schedule?.id === 'night', JSON.stringify(ctx.state.schedule)),
      check('夜间守家标记生效', ctx.state.schedule?.nightGuard === true, JSON.stringify(ctx.state.schedule)),
      check(
        '夜间牵引绳收紧到 16',
        ctx.state.schedule?.leashMaxDistance === 16,
        String(ctx.state.schedule?.leashMaxDistance),
      ),
      check(
        'trace 记录了日程切换',
        ctx.traceOf('schedule').length >= 1,
        ctx.traceOf('schedule').map((e) => e.note).join(' | '),
      ),
      check(
        'night_danger 中断不再抢计划槽',
        nightDanger.length === 0,
        nightDanger.map((e) => e.note).join(' | '),
      ),
      check(
        '没有 go_home 计划（守家由日程接管）',
        !plans.some((p) => p.recipeId === 'go_home'),
        plans.map((p) => p.recipeId).join(','),
      ),
      check(
        '敌对进圈 → 自动守卫（fight_safe）',
        !!guard && guard.skill === 'fight_safe' && guard.status === 'done',
        guard ? `${guard.skill} ${guard.status}` : '没有 auto:guard 目标',
      ),
      check(
        '守卫目标参数来自日程（maxTargets=2）',
        guard?.params?.maxTargets === 2,
        JSON.stringify(guard?.params ?? null),
      ),
      check(
        '威胁解除 → 自动巡逻（go_to 家的一个角）',
        !!patrol && patrol.skill === 'go_to',
        patrol ? `${patrol.skill} ${patrol.status}` : '没有 auto:patrol 目标',
      ),
      check(
        '巡逻路点在家半径 6 的角上',
        patrol?.params?.target?.x === HOME.x + PATROL_RADIUS &&
          patrol?.params?.target?.z === HOME.z &&
          patrol?.params?.target?.y === HOME.y,
        JSON.stringify(patrol?.params?.target ?? null),
      ),
    ];
  },
};

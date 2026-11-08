/**
 * 场景 6：计划在跑 → 事件流给 death → 计划 ABANDONED + 地点簿记死亡点 + inbox death。
 *
 * 期望：死亡会打断在途程序，所以计划立即作废（不是 suspended）；
 *       用最后一次观测坐标往地点簿写一条 kind=death；上报 death（叫醒大脑）。
 */
import fs from 'node:fs';
import { obs, ok, check } from './_common.mjs';

export default {
  id: 'death',
  title: '计划在跑时 death 事件 → 计划 ABANDONED + 地点簿记死亡点 + 上报 death',
  observations: [obs({ x: 10, y: 64, z: 10 }), obs({ x: 10, y: 64, z: 10 }), obs({ x: 10, y: 64, z: 10 })],
  setup(ctx) {
    ctx.lane.startPlan({ intent: 'stock_wood', source: 'llm' });
  },
  results(ctx, skill) {
    if (skill === 'dig_nearby') return ok({ dug: 8, left: 0, drops: 8 });
    if (skill === 'go_to') return ok({ x: 10, y: 64, z: 10, left: 0, plan_s: 1, steps: 1 });
    return ok();
  },
  events: [{ kind: 'death', message: 'tyrander was slain by zombie' }],
  eventsWhen(ctx) {
    return ctx.allowDeath === true;
  },
  onTick(ctx) {
    // 等计划真的跑过至少一步、且已有观测坐标后，冻结动作循环再放 death 事件，
    // 保证"计划在跑时死亡"这个前提（否则可能死在计划刚建好/还没派步的瞬间）。
    if (!ctx.allowDeath) {
      const plan = ctx.state.plan;
      if (plan && (plan.stepResults?.length ?? 0) >= 1 && ctx.state.pos) {
        ctx.allowDeath = true;
        ctx.state.paused = true;
      }
    }
  },
  done(ctx) {
    return ctx.inboxOf('death').length > 0;
  },
  maxTicks: 200,
  check(ctx) {
    const plan = ctx.plan();
    const deathPlaces = ctx.places.list({ kind: 'death' });
    const deathInbox = ctx.inboxOf('death');
    const fileData = (() => {
      try {
        return JSON.parse(fs.readFileSync(ctx.places.file, 'utf8'));
      } catch {
        return null;
      }
    })();
    const deathOnDisk = (fileData?.places ?? []).filter((p) => p.kind === 'death');

    return [
      check('事件通道确实投递了 death', ctx.eventsClient?.sent === true, `sent=${ctx.eventsClient?.sent}`),
      check(
        '计划被杀（ABANDONED，不是 suspended）',
        plan?.status === 'abandoned' && plan?.lastError === 'death',
        `status=${plan?.status} lastError=${plan?.lastError}`,
      ),
      check(
        '死亡时计划确实在跑（已有步进记录）',
        (plan?.stepResults?.length ?? 0) >= 1,
        `stepResults=${plan?.stepResults?.length ?? 0}`,
      ),
      check('state.plan 已清空', ctx.state.plan === null, `plan=${ctx.state.plan ? 'alive' : 'null'}`),
      check('state.deathAt 被记录', !!ctx.state.deathAt, `deathAt=${ctx.state.deathAt}`),
      check(
        '地点簿多一条 kind=death，坐标=最后观测点',
        deathPlaces.length === 1 &&
          deathPlaces[0].pos?.x === 10 &&
          deathPlaces[0].pos?.y === 64 &&
          deathPlaces[0].pos?.z === 10 &&
          deathPlaces[0].dimension === 'minecraft:overworld',
        JSON.stringify(deathPlaces),
      ),
      check(
        '死亡点已原子写盘到临时 places.json',
        deathOnDisk.length === 1,
        `磁盘上 death=${deathOnDisk.length}`,
      ),
      check(
        'inbox 有 death 求助且叫醒大脑',
        deathInbox.length === 1 && deathInbox[0].needsBrain === true,
        `death=${deathInbox.length} needsBrain=${deathInbox[0]?.needsBrain}`,
      ),
      check(
        '死亡是唯一叫醒大脑的收尾（不额外刷 goal_done）',
        ctx.inboxOf('goal_done').length === 0,
        `goal_done=${ctx.inboxOf('goal_done').length}`,
      ),
    ];
  },
};

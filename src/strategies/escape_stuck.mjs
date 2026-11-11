/**
 * escape_stuck —— 自主脱困：不传送、不作弊，像人一样尝试走/跳/挖出来。
 *
 * 顺序：try_step ×N → 四个方向 move_segment → 挖头顶/脚下 → 再 try_step。
 * 只用于“移动失败/位置卡住”的需求；成功标准是动作本身 ok（离开原位）。
 */
import { observeFact } from '../perception.mjs';

export async function escapeStuck(params, ctx, callTactic) {
  const st = ctx?.state;
  if (!st?.pos) return { ok: false, kind: 'no_state', message: 'escape_stuck 需要位置' };
  // 低血不做冒险脱困（跳/挖/坠落可能致命）；先保命/等恢复
  if (Number(st.hp ?? 20) <= 4) {
    return { ok: false, kind: 'too_weak', message: `HP ${st.hp} 太低，不做冒险脱困` };
  }
  const start = { ...st.pos };
  const attempts = [];

  // 水域脱困：move.to 成功 ≠ 已上岸；必须用触手确认不再 in_water
  const stillWet = async () => {
    if (!ctx?.tentacle || !st.id) return !!st.inWater;
    try {
      const p = await ctx.tentacle.perception({ uuid: st.id, radius: 8 });
      if (p?.ok && p.terrain) return !!p.terrain.in_water;
    } catch {
      /* fall through */
    }
    return !!st.inWater;
  };

  if (st.inWater) {
    const targets = [];
    // 先尝试上浮
    for (const dy of [3, 6, 9]) {
      targets.push({ x: start.x, y: start.y + dy, z: start.z, reason: 'surface' });
    }
    // 再尝试四向/斜向的岸边（水位通常只差 0~1 格）
    for (const [dx, dz] of [
      [4, 0], [-4, 0], [0, 4], [0, -4],
      [8, 0], [-8, 0], [0, 8], [0, -8],
      [6, 6], [-6, 6], [6, -6], [-6, -6],
      [12, 0], [-12, 0], [0, 12], [0, -12],
    ]) {
      targets.push({ x: start.x + dx, y: start.y + 1, z: start.z + dz, reason: 'shore' });
    }
    for (const target of targets) {
      const r = await callTactic('move_segment', { target, arrive: 1 });
      if (r?.ok) {
        const wet = await stillWet();
        if (ctx?.facts) {
          observeFact(ctx.facts, {
            key: 'in_water',
            value: wet,
            source: 'tentacle',
            gameTick: Number(st.gameTime ?? 0),
          });
        }
        if (!wet) return { ok: true, reason: target.reason, target, start };
      }
      attempts.push(r?.ok ? 'still_wet' : (r?.kind ?? 'move_failed'));
    }
    return {
      ok: false,
      kind: 'water_stuck',
      message: '在水里没找到岸：上浮/四向靠岸都失败，需要玩家指一个岸边',
      attempts: [...new Set(attempts)].slice(0, 8),
      start,
    };
  }

  const tryStep = async (rounds = 4) => {
    for (let i = 0; i < rounds; i += 1) {
      const r = await callTactic('try_step', {});
      if (r?.ok) return { ok: true, reason: 'try_step', round: i + 1 };
      attempts.push(r?.kind ?? 'try_step_failed');
    }
    return null;
  };

  // 1) 先原地跳/走
  const step = await tryStep(4);
  if (step) return { ...step, start };

  // 2) 四个方向走一段（近到远）
  const dirs = [
    [4, 0], [-4, 0], [0, 4], [0, -4],
    [8, 0], [-8, 0], [0, 8], [0, -8],
    [3, 3], [-3, 3], [3, -3], [-3, -3],
  ];
  for (const [dx, dz] of dirs) {
    const target = { x: start.x + dx, y: start.y, z: start.z + dz };
    const r = await callTactic('move_segment', { target, arrive: 1 });
    if (r?.ok) return { ok: true, reason: 'move_segment', target, start };
    attempts.push(r?.kind ?? 'move_failed');
  }

  // 3) 地形感知：优先去可站立方向；没有就挖侧向隧道/台阶
  let terrain = null;
  try {
    if (ctx?.tentacle && st.id) {
      const p = await ctx.tentacle.perception({ uuid: st.id, radius: 8 });
      if (p?.ok) terrain = p.terrain || null;
    }
  } catch {
    /* tentacle absent: fall through to blind dig */
  }
  if (terrain?.dirs?.length) {
    const dirs = terrain.dirs.slice().sort((a, b) => Number(b.standable) - Number(a.standable));
    for (const d of dirs) {
      const target = { x: start.x + Number(d.dx), y: start.y, z: start.z + Number(d.dz) };
      if (d.standable) {
        const r = await callTactic('move_segment', { target, arrive: 1 });
        if (r?.ok) return { ok: true, reason: 'terrain_standable', target, start };
        attempts.push(r?.kind ?? 'move_failed');
        continue;
      }
      // 不可站立：挖开 feet/head 两格，再走进去（有界，仅本地一格）
      const feetCell = { x: Math.floor(target.x), y: Math.floor(start.y), z: Math.floor(target.z) };
      const headCell = { x: feetCell.x, y: feetCell.y + 1, z: feetCell.z };
      await callTactic('dig_one', { cell: feetCell });
      await callTactic('dig_one', { cell: headCell });
      const r = await callTactic('move_segment', { target, arrive: 1 });
      if (r?.ok) return { ok: true, reason: 'terrain_dig_side', target, start };
      attempts.push(r?.kind ?? 'move_failed');
    }
  }

  // 4) 盲挖头顶/脚下（可能被埋/卡在洞里）
  for (const dy of [2, 1, 0]) {
    const cell = { x: Math.floor(start.x), y: Math.floor(start.y) + dy, z: Math.floor(start.z) };
    const r = await callTactic('dig_one', { cell });
    if (r?.ok) {
      const step2 = await tryStep(2);
      if (step2) return { ...step2, reason: 'dig_out' };
    }
    attempts.push(r?.kind ?? 'dig_failed');
  }

  // 4) 最后再试一次 step
  const step3 = await tryStep(4);
  if (step3) return { ...step3, reason: 'try_step_after_dig', start };

  return {
    ok: false,
    kind: 'stuck_failed',
    message: '走、跳、挖都没脱困（可能被水/深坑/基岩困住）',
    attempts: [...new Set(attempts)].slice(0, 8),
    start,
  };
}

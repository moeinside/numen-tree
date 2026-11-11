/**
 * 安全点/回家战略（从 strategy.mjs 拆出）。
 *
 * 只依赖 ctx.state / ctx.homePlace / ctx.tentacle 和 callTactic；
 * 不直接读游戏、不调 numen。
 */
import { distance3, sameLevel } from '../space.mjs';

export async function safetyHold(params, ctx, callTactic) {
  const st = ctx?.state;
  const home = ctx?.homePlace;
  if (!home) return { ok: false, kind: 'no_home', message: '没有家/安全点记录' };
  const radius = Math.max(4, Number(params?.radius ?? 12));
  const dist = st?.pos != null ? distance3(st.pos, home) : null;
  if (dist != null && dist <= radius && sameLevel(st.pos, home, 2)) return { ok: true, reason: 'at_safe_point' };
  // 在水里先浮出水面，再回家；否则 travel_to 会一直溺水失败
  if (st?.inWater) {
    for (const dy of [4, 8, 12]) {
      const r = await callTactic('move_segment', {
        target: { x: st.pos.x, y: st.pos.y + dy, z: st.pos.z },
        arrive: 1,
      });
      if (r?.ok) break;
    }
  }
  const stand = await callTactic('check_standable', { cell: home });
  const standable = stand?.ok && (stand?.vars?.s?.standable === true || stand?.vars?.s?.standable === 'true');
  if (!standable) {
    return { ok: false, kind: 'target_not_standable', message: '家附近目标格不可站立' };
  }
  const mv = await callTactic('travel_to', {
    target: { x: home.x, y: home.y, z: home.z },
    arrive: 3,
  });
  if (mv?.ok) return { ok: true, reason: 'safe_point_reached' };
  // 移动回执超时/被抢时，位置可能已经变了；用触手复核一次，别误判失败
  let now = st?.pos;
  try {
    if (ctx?.tentacle && st?.id) {
      const p = await ctx.tentacle.perception({ uuid: st.id, radius: 8 });
      if (p?.ok) now = { x: p.self.x, y: p.self.y, z: p.self.z };
    }
  } catch {
    /* 触手不在就退回旧位置 */
  }
  if (now != null) {
    const d2 = distance3(now, home);
    if (d2 != null && d2 <= radius + 2 && sameLevel(now, home, 2)) return { ok: true, reason: 'near_after_timeout' };
  }
  return { ok: false, kind: 'travel_failed', message: mv?.message ?? '回安全点路线失败' };
}

export async function returnHome(params, ctx, callTactic) {
  const st = ctx?.state;
  const home = ctx?.homePlace;
  if (!home) return { ok: false, kind: 'no_home', message: '没有家/锚点记录' };
  const dist = st?.pos != null ? distance3(st.pos, home) : null;
  if (dist != null && dist <= 8 && sameLevel(st.pos, home, 2)) return { ok: true, reason: 'already_home' };
  const stand = await callTactic('check_standable', { cell: home });
  const standable = stand?.ok && (stand?.vars?.s?.standable === true || stand?.vars?.s?.standable === 'true');
  if (!standable) {
    return { ok: false, kind: 'target_not_standable', message: '家目标格不可站立' };
  }
  const mv = await callTactic('travel_to', {
    target: { x: home.x, y: home.y, z: home.z },
    arrive: 3,
  });
  if (mv?.ok) return { ok: true, reason: 'returned_home' };
  return { ok: false, kind: 'travel_failed', message: mv?.message ?? '回家路线失败' };
}

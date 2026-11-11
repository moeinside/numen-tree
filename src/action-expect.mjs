/**
 * P0-0a：四类动作的 expected predicate。
 * 纯函数：动作 ok 之后调用，用世界观测判定是否真的达成。
 */
export const ACTION_EXPECTATIONS = Object.freeze({
  move: { sideEffect: 'replayable', expected: '不在水里且在地面/有位移' },
  escape: { sideEffect: 'replayable', expected: '不在水里且在地面' },
  collect: { sideEffect: 'replayable', expected: '掉落/背包增量>0' },
  open_container: { sideEffect: 'replayable', expected: '容器可交互/窗口打开' },
  place: { sideEffect: 'rebuildable', expected: '目标方块发生变化' },
});

export function checkActionExpectation(action, { before = {}, after = {}, facts = {} } = {}) {
  const kind = String(action ?? '');
  const spec = ACTION_EXPECTATIONS[kind];
  if (!spec) return { ok: false, kind: 'no_expectation', action: kind };
  if (kind === 'move' || kind === 'escape') {
    const inWater = facts.in_water ?? after.in_water;
    const onGround = facts.on_ground ?? after.on_ground;
    const moved = Number(after.moved ?? 0);
    const dry = inWater === false;
    const grounded = onGround !== false;
    const p = before.pos;
    const q = after.pos;
    const displaced =
      p && q ? Math.hypot(Number(q.x) - Number(p.x), Number(q.z) - Number(p.z)) >= 0.5 : true;
    const ok = dry && grounded && (displaced || moved >= 0.5 || kind === 'escape');
    return {
      ok,
      kind: ok ? 'ok' : 'postcheck_failed',
      action: kind,
      expected: spec.expected,
      detail: { inWater, onGround, displaced, moved },
    };
  }
  if (kind === 'collect') {
    const delta = Number(after.itemDelta ?? 0);
    return {
      ok: delta > 0,
      kind: delta > 0 ? 'ok' : 'postcheck_failed',
      action: kind,
      expected: spec.expected,
      detail: { itemDelta: delta },
    };
  }
  if (kind === 'open_container') {
    const open = after.containerOpen === true;
    return {
      ok: open,
      kind: open ? 'ok' : 'postcheck_failed',
      action: kind,
      expected: spec.expected,
      detail: { containerOpen: open },
    };
  }
  if (kind === 'place') {
    const changed = after.blockChanged === true;
    return {
      ok: changed,
      kind: changed ? 'ok' : 'postcheck_failed',
      action: kind,
      expected: spec.expected,
      detail: { blockChanged: changed },
    };
  }
  return { ok: false, kind: 'unknown_action', action: kind };
}

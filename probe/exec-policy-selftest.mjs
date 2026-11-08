/**
 * 执行策略层自测：node probe/exec-policy-selftest.mjs
 * 覆盖：默认安全 / 硬风险降档 / 打断冷却 / 安静窗口回安全 / preflight 新鲜观测与阈值 / postflight。
 */
import {
  EXEC_DEFAULTS,
  createExecState,
  describeExec,
  evaluateMode,
  noteInterrupt,
  noteObservation,
  noteRisk,
  postflight,
  preflight,
} from '../src/exec-policy.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const T0 = 1_000_000;
const baseState = (over = {}) => ({
  hp: 20,
  maxHp: 20,
  hunger: 20,
  pos: { x: 0, y: 64, z: 0 },
  hostileCount: 0,
  hostileDistance: null,
  ownerDangerAt: 0,
  lastReflexAt: 0,
  ...over,
});

console.log('默认与描述：');
{
  const exec = createExecState(T0);
  check('初始为 safe-batch', exec.mode === 'safe-batch');
  check('describe 带 mode/reason', describeExec(exec).mode === 'safe-batch' && exec.reason === 'init');
}

console.log('硬风险降档：');
{
  const exec = createExecState(T0);
  evaluateMode(exec, baseState({ hostileCount: 1, hostileDistance: 10 }), T0);
  check('敌对 10 格 → field-guarded', exec.mode === 'field-guarded', exec.reason);
  check('降档立即记录 reason', exec.reason === 'hostile_close', exec.reason);
}
{
  const exec = createExecState(T0);
  noteRisk(exec, 'reflex', T0);
  check('reflex → field-guarded', exec.mode === 'field-guarded');
  check('冷却 60s', exec.cooldownUntil === T0 + 60_000, String(exec.cooldownUntil - T0));
}
{
  const exec = createExecState(T0);
  evaluateMode(exec, baseState({ hp: 9 }), T0);
  check('hp%≤50 → field-guarded', exec.mode === 'field-guarded', exec.reason);
}
{
  const exec = createExecState(T0);
  // 位置无关：在"基地"（坐标一样）也不会给 safe 资格；这里只验证宿主/位置不参与判定
  evaluateMode(exec, baseState({ pos: { x: 0, y: 64, z: 0 }, hostileCount: 1, hostileDistance: 12 }), T0);
  check('不靠"基地范围"判安全（敌对仍降档）', exec.mode === 'field-guarded');
}

console.log('打断冷却与回安全：');
{
  const exec = createExecState(T0);
  noteInterrupt(exec, 'timeout', T0);
  check('timeout 打断 → 降档', exec.mode === 'field-guarded');
  // 30s 后仍冷却（60s）
  evaluateMode(exec, baseState(), T0 + 31_000);
  check('31s 时仍在 field-guarded（冷却 60s）', exec.mode === 'field-guarded', exec.reason);
  // 61s 后且安静窗口满足 → 回 safe-batch；但 quiet 需 30s，从 lastRisk 起算
  evaluateMode(exec, baseState(), T0 + 61_000);
  check('61s 后回 safe-batch', exec.mode === 'safe-batch', exec.reason);
}
{
  const exec = createExecState(T0);
  noteRisk(exec, 'reflex', T0);
  evaluateMode(exec, baseState(), T0 + 35_000); // 冷却未到
  check('冷却未到不回安全', exec.mode === 'field-guarded');
  evaluateMode(exec, baseState(), T0 + 61_000);
  check('冷却到且安静 → 回安全', exec.mode === 'safe-batch', exec.reason);
}
{
  const exec = createExecState(T0);
  noteInterrupt(exec, 'preempted', T0);
  check('preempted → 降档', exec.mode === 'field-guarded');
  noteInterrupt(exec, 'ok', T0 + 1000);
  check('非中断结果不影响档位', exec.mode === 'field-guarded');
}

console.log('preflight：');
{
  const exec = createExecState(T0);
  noteObservation(exec, T0);
  const r = preflight(exec, baseState(), { taskRisk: 'low', now: T0 + 500 });
  check('新鲜观测 + 安全 → 允许', r.ok === true, JSON.stringify(r.reasons));
}
{
  const exec = createExecState(T0); // lastObservedAt=0
  const r = preflight(exec, baseState(), { taskRisk: 'low', now: T0 });
  check('没观测 → observation_stale', r.ok === false && r.reasons.includes('observation_stale'));
}
{
  const exec = createExecState(T0);
  noteObservation(exec, T0 - 10_000);
  const r = preflight(exec, baseState(), { taskRisk: 'low', now: T0 });
  check('旧观测 → observation_stale', !r.ok && r.reasons.includes('observation_stale'));
}
{
  const exec = createExecState(T0);
  noteObservation(exec, T0);
  const r = preflight(exec, baseState({ hostileCount: 1, hostileDistance: 20 }), { taskRisk: 'low', now: T0 });
  check('24 格内有敌对 → 拒绝', !r.ok && r.reasons.includes('hostile_near'), JSON.stringify(r.reasons));
}
{
  const exec = createExecState(T0);
  noteObservation(exec, T0);
  const r = preflight(exec, baseState({ hp: 10, hunger: 5 }), { taskRisk: 'low', now: T0 });
  check('hp/饥饿不足 → 拒绝', !r.ok && r.reasons.includes('hp_low') && r.reasons.includes('hunger_low'));
}
{
  const exec = createExecState(T0);
  noteObservation(exec, T0);
  const r = preflight(exec, baseState(), { taskRisk: 'high', now: T0 });
  check('高风险动作 → 拒绝', !r.ok && r.reasons.includes('action_risk_high'));
}
{
  const exec = createExecState(T0);
  noteInterrupt(exec, 'timeout', T0);
  noteObservation(exec, T0 + 1000);
  const r = preflight(exec, baseState(), { taskRisk: 'low', now: T0 + 1000 });
  check('刚被打断 → 拒绝（recent_risk/mode）', !r.ok, JSON.stringify(r.reasons));
}

console.log('postflight：');
{
  const exec = createExecState(T0);
  noteObservation(exec, T0);
  const r = postflight(exec, baseState({ hp: 18 }), { hp: 20, pos: { x: 0, y: 64, z: 0 } }, { now: T0 });
  check('hp 掉 2 → 标记风险', r.ok === false && r.reasons.includes('hp_dropped'));
  check('postflight 直接降档', exec.mode === 'field-guarded');
}
{
  const exec = createExecState(T0);
  const r = postflight(exec, baseState(), { hp: 20, pos: { x: 0, y: 64, z: 0 } }, { now: T0 });
  check('正常 → ok', r.ok === true);
}
{
  const exec = createExecState(T0);
  const r = postflight(
    exec,
    { ...baseState(), pos: { x: 100, y: 64, z: 100 } },
    { hp: 20, pos: { x: 0, y: 64, z: 0 } },
    { now: T0 },
  );
  check('位置异常跳变 → 标记风险', !r.ok && r.reasons.includes('pos_jump'));
}

console.log('');
console.log(`执行策略自测：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);

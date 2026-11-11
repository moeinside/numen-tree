#!/usr/bin/env node
import {
  createFactStore,
  observeFact,
  getFact,
  ensureFact,
  markUnknown,
  isWhitelisted,
} from '../../src/perception.mjs';
import {
  beginTx,
  settleTx,
  interruptTx,
  postcheckTx,
  repostcheckTx,
  txOutcome,
  canAutoReenter,
  TX_STATUS,
} from '../../src/action-tx.mjs';

let p = 0;
let f = 0;
const ck = (name, ok, detail = '') => {
  if (ok) {
    p += 1;
    console.log(`  ✓ ${name}`);
  } else {
    f += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// FactStore
ck('白名单外拒绝', isWhitelisted('foo') === false);
const store = createFactStore();
observeFact(store, { key: 'in_water', value: true, source: 'tentacle', gameTick: 100 });
const fresh = getFact(store, 'in_water', { gameTick: 150 });
ck('新鲜 known', fresh.status === 'known' && fresh.value === true);
const stale = getFact(store, 'in_water', { gameTick: 500 });
ck('过期 stale', stale.status === 'stale');
ck('stale ensure 失败', ensureFact(store, 'in_water', { gameTick: 500 }).ok === false);

const conflict = createFactStore();
observeFact(conflict, { key: 'in_water', value: true, source: 'tentacle', gameTick: 100 });
// 模拟权威源冲突：已有事实来源不是 tentacle（旧值/外部源），新 tentacle 值不同 → 降 unknown
conflict.facts.in_water.source = 'numen_body';
observeFact(conflict, { key: 'in_water', value: false, source: 'tentacle', gameTick: 110 });
ck('权威源冲突降 unknown', getFact(conflict, 'in_water', { gameTick: 120 }).status === 'unknown');
ck('冲突有记录', conflict.conflicts.length === 1);

const nonAuth = createFactStore();
observeFact(nonAuth, { key: 'in_water', value: false, source: 'numen_body', gameTick: 100 });
ck('非权威不覆盖为 known', getFact(nonAuth, 'in_water', { gameTick: 110 }).status === 'unknown');

const missing = createFactStore();
ck('缺失 unknown', getFact(missing, 'on_ground', { gameTick: 1 }).status === 'unknown');
markUnknown(missing, 'on_ground', { gameTick: 2 });
ck('markUnknown', getFact(missing, 'on_ground', { gameTick: 3 }).status === 'unknown');

// ActionTx
const tx = beginTx({ action: 'move', expected: ['in_water=false'], sideEffect: 'move' });
settleTx(tx, { ok: true });
postcheckTx(tx, { passed: true, evidence: { seq: 1 } });
ck('事务 commit', tx.status === TX_STATUS.COMMITTED && txOutcome(tx).ok === true);

const tx2 = beginTx({ action: 'move', sideEffect: 'move' });
settleTx(tx2, { ok: true });
postcheckTx(tx2, { passed: false });
ck('postcheck 假 → failed', tx2.status === TX_STATUS.FAILED && txOutcome(tx2).ok === false);

const tx3 = beginTx({ action: 'move', sideEffect: 'move' });
settleTx(tx3, { ok: true });
postcheckTx(tx3, { uncertain: true });
ck('不确定 → unknown', tx3.status === TX_STATUS.UNKNOWN);
ck('unknown 不自动重入', canAutoReenter(tx3) === false);

const tx4 = beginTx({ action: 'place', sideEffect: 'place' });
settleTx(tx4, { ok: true });
interruptTx(tx4, 'reflex');
ck('反射打断不带 success', tx4.status === TX_STATUS.UNKNOWN && tx4.actionOk === null);
ck('unknown 最多 2 次重观测', (() => {
  const t = beginTx({ action: 'move' });
  settleTx(t, { ok: true });
  postcheckTx(t, { uncertain: true });
  repostcheckTx(t, { uncertain: true });
  return t.reason === 'info_missing';
})());
ck('unknown 第二次明确失败 → failed', (() => {
  const t = beginTx({ action: 'move' });
  settleTx(t, { ok: true });
  postcheckTx(t, { uncertain: true });
  repostcheckTx(t, { passed: false });
  return t.status === TX_STATUS.FAILED;
})());

console.log(`P0 感知/事务自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

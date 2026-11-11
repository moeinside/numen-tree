import { markFact, factFresh, resolveFact, snapshotView, DEFAULT_FACT_TTL_MS } from '../src/perception-evidence.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}`); }
}

const s = {};
markFact(s, 'hostileCount', { observedAt: 1000, source: 'numen', radius: 16 });
check('字段源写入', s.factMeta.hostileCount.source === 'numen');
check('新鲜字段通过', factFresh(s, 'hostileCount', { now: 2000, ttlMs: 5000 }).fresh === true);
check('过期字段拒绝', factFresh(s, 'hostileCount', { now: 7000, ttlMs: 5000 }).fresh === false);
check('缺失字段兼容', factFresh(s, 'unknown', { now: 7000 }).fresh === true);
check('快照可序列化', snapshotView(s).hostileCount.radius === 16);
check('默认 TTL 存在', DEFAULT_FACT_TTL_MS === 5000);

{
  const c = {};
  markFact(c, 'hostileCount', { observedAt: 1000, source: 'observe', value: 0 });
  markFact(c, 'hostileCount', { observedAt: 1100, source: 'tentacle', value: 3 });
  const r = resolveFact(c, 'hostileCount', { now: 1200, authority: ['observe', 'tentacle'] });
  check('权威源优先', r.fresh && r.value === 0 && r.source === 'observe');
}
{
  const c = {};
  markFact(c, 'hostileCount', { observedAt: 1000, source: 'observe', value: 0 });
  markFact(c, 'hostileCount', { observedAt: 1100, source: 'observe', value: 3 });
  const r = resolveFact(c, 'hostileCount', { now: 1200, authority: ['observe', 'tentacle'] });
  check('同权威新鲜冲突 → 禁止抢占', !r.fresh && r.conflict === true);
}
{
  const c = {};
  markFact(c, 'hostileCount', { observedAt: 1000, source: 'observe', value: 3 });
  const r = resolveFact(c, 'hostileCount', { now: 7000, authority: ['observe'] });
  check('TTL 过期 → 不 fresh', !r.fresh && r.conflict === false);
}

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;

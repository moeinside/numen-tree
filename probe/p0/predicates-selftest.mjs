#!/usr/bin/env node
import { evaluatePredicate, evaluateMilestone } from '../../src/predicates.mjs';

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

const ev = { source: 'world_snapshot', snapshotSeq: 12 };
const state = {
  inventory: [
    { item: 'minecraft:raw_iron', count: 3 },
    { item: 'minecraft:stone_pickaxe', count: 1 },
  ],
};
const sites = [{ kind: 'furnace', pos: { x: 0, y: 64, z: 0 }, valid: true }];

const a = evaluatePredicate({ kind: 'has_item', item: 'minecraft:raw_iron', evidence: ev }, { state });
ck('has_item 通过', a.ok === true, JSON.stringify(a));
const b = evaluatePredicate(
  { kind: 'item_count', item: 'minecraft:raw_iron', count: 3, evidence: ev },
  { state },
);
ck('item_count 通过', b.ok === true && b.value === 3);
const c = evaluatePredicate(
  { kind: 'item_count', item: 'minecraft:raw_iron', count: 4, evidence: ev },
  { state },
);
ck('数量不足判负', c.ok === false && c.reason === 'item_shortage');
const d = evaluatePredicate({ kind: 'has_item', item: 'minecraft:raw_iron', evidence: ev }, { state });
ck('site_valid 通过', evaluatePredicate({ kind: 'site_valid', siteKind: 'furnace', evidence: ev }, { sites }).ok === true);
ck('site 缺失判负', evaluatePredicate({ kind: 'site_valid', siteKind: 'chest', evidence: ev }, { sites }).ok === false);
ck('执行器自评拒绝', evaluatePredicate({ kind: 'has_item', item: 'x', evidence: { source: 'executor', snapshotSeq: 1 } }, { state }).reason === 'evidence_not_external');
ck('缺时间戳拒绝', evaluatePredicate({ kind: 'has_item', item: 'x', evidence: { source: 'observer' } }, { state }).reason === 'evidence_missing_stamp');
ck('milestone 全通过', evaluateMilestone({ predicates: [
  { id: 'iron', kind: 'item_count', item: 'minecraft:raw_iron', count: 3, evidence: ev },
  { id: 'furnace', kind: 'site_valid', siteKind: 'furnace', evidence: ev },
] }, { state, sites }).ok === true);

console.log(`B 谓词自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

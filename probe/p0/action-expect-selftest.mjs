#!/usr/bin/env node
import { checkActionExpectation, ACTION_EXPECTATIONS } from '../../src/action-expect.mjs';

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

ck('move 成功', checkActionExpectation('move', { facts: { in_water: false, on_ground: true }, after: { pos: { x: 1, y: 64, z: 0 } }, before: { pos: { x: 0, y: 64, z: 0 } } }).ok === true);
ck('move 仍在水中判负', checkActionExpectation('move', { facts: { in_water: true, on_ground: false } }).ok === false);
ck('collect 增量', checkActionExpectation('collect', { after: { itemDelta: 2 } }).ok === true);
ck('collect 无增量判负', checkActionExpectation('collect', { after: { itemDelta: 0 } }).ok === false);
ck('open 成功', checkActionExpectation('open_container', { after: { containerOpen: true } }).ok === true);
ck('place 成功', checkActionExpectation('place', { after: { blockChanged: true } }).ok === true);
ck('未知动作拒绝', checkActionExpectation('nope', {}).kind === 'no_expectation');
ck('place 副作用分类', ACTION_EXPECTATIONS.place.sideEffect === 'rebuildable');

console.log(`动作 expected predicate 自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

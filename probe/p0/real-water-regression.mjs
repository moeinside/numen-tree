#!/usr/bin/env node
/**
 * 真实失败回归：水里 move_segment 全部 ok，但触手复核仍 in_water=true。
 * 期望：escape_stuck 必须返回 water_stuck，不能返回 success。
 */
import { escapeStuck } from '../../src/strategies/escape_stuck.mjs';
import { createFactStore, getFact, observeFact } from '../../src/perception.mjs';

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

const state = {
  pos: { x: 59, y: 61, z: 234 },
  hp: 20,
  inWater: true,
  gameTime: 1000,
  id: 'real-water-fixture',
};
const facts = createFactStore();
observeFact(facts, { key: 'in_water', value: true, source: 'tentacle', gameTick: 1000 });
const ctx = {
  state,
  facts,
  tentacle: {
    async perception() {
      return { ok: true, terrain: { in_water: true, on_ground: false } };
    },
  },
};
const callTactic = async () => ({ ok: true, kind: 'ok' }); // 动作永远自报 ok，但实际没上岸

const r = await escapeStuck({}, ctx, callTactic);
ck('动作全 ok 也判 water_stuck', r.ok === false && r.kind === 'water_stuck', JSON.stringify(r).slice(0, 200));
ck('带 attempts 证据', Array.isArray(r.attempts) && r.attempts.length > 0, JSON.stringify(r.attempts));
ck('Fact 仍是 in_water=true', getFact(facts, 'in_water', { gameTick: 1001 }).value === true);
ck('绝不自报 success', r.ok !== true);

console.log(`真实水失败回归：${p}/${p + f} 通过`);
if (f) process.exit(1);

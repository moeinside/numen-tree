#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GOAL_STORE_VERSION,
  createGoalStore,
  saveGoalStore,
  loadGoalStore,
  milestoneProgress,
} from '../../src/goalstore.mjs';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-goalstore-'));
const file = path.join(dir, 'goal.json');
const base = createGoalStore({
  worldId: 'w1',
  companionId: 'c1',
  worldEpoch: 7,
  activeProfile: { id: 'iron_age', title: '铁器时代' },
  milestones: [
    { id: 'M1', status: 'done', title: '石镐', evidence: { source: 'observer', snapshotSeq: 1 } },
    { id: 'M2', status: 'active', title: '熔炉', acceptance: 'furnace_placed' },
  ],
  checkpoint: { pos: { x: 0, y: 64, z: 0 }, dimension: 'overworld', gameTime: 1200, inventorySummary: { cobblestone: 8 } },
});

saveGoalStore(file, base);
ck('原子写后文件存在', fs.existsSync(file));
ck('没有遗留 tmp 文件', fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length === 0);

const got = loadGoalStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 7 });
ck('roundtrip 成功', got.ok === true, JSON.stringify(got));
ck('schemaVersion 正确', got.store?.schemaVersion === GOAL_STORE_VERSION);
ck('checkpoint 存在', got.store?.checkpoint?.gameTime === 1200);
ck('不存 plan cursor', !('cursor' in (got.store?.checkpoint || {})) && !('planCursor' in (got.store || {})));
const prog = milestoneProgress(got.store);
ck('milestone done 正确', prog.done.includes('M1') && prog.active?.id === 'M2');

// 回档：epoch 不一致 → checkpoint 不可信
const old = loadGoalStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 3 });
ck('epoch 不一致有警告', old.ok === true && old.warnings.includes('world_epoch_mismatch'));
ck('epoch 不一致 checkpoint 标记 stale', old.staleCheckpoint === true);

// 换世界/同伴
ck('world mismatch 拒绝', loadGoalStore(file, { worldId: 'w2', companionId: 'c1' }).reason === 'world_mismatch');
ck('companion mismatch 拒绝', loadGoalStore(file, { worldId: 'w1', companionId: 'c2' }).reason === 'companion_mismatch');

// 篡改 payload
const env = JSON.parse(fs.readFileSync(file, 'utf8'));
env.payload.milestones[1].status = 'done';
fs.writeFileSync(file, JSON.stringify(env), 'utf8');
ck('hash mismatch 拒绝', loadGoalStore(file).reason === 'hash_mismatch');

// 坏 JSON
fs.writeFileSync(file, '{bad json', 'utf8');
ck('坏 JSON 拒绝', loadGoalStore(file).reason === 'parse_failed');

// 缺失
ck('缺失文件返回 missing', loadGoalStore(path.join(dir, 'nope.json')).reason === 'missing');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`P0 GoalStore 自测：${p}/${p + f} 通过`);
if (f) process.exit(1);

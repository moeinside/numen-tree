#!/usr/bin/env node
/**
 * P0 kill 点/损坏存档/幂等矩阵（离线、纯文件）。
 *
 * 模拟：
 *  - 写入前崩溃：旧文件仍在，load 成功；
 *  - 写入中崩溃：只留 tmp，无正式文件；不能把 tmp 当存档；
 *  - 写入被截断/篡改：load 必须拒绝；
 *  - 重启后 active milestone：先谓词验收，done 不重放；
 *  - 同一 milestone 重复加载不产生重复副作用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGoalStore,
  saveGoalStore,
  loadGoalStore,
  milestoneProgress,
} from '../../src/goalstore.mjs';
import { resumeDecision } from '../../src/goalresume.mjs';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-kill-'));
const file = path.join(dir, 'goal.json');

function mk(active = 'gather_wood') {
  const store = createGoalStore({
    worldId: 'w1',
    companionId: 'c1',
    worldEpoch: 1,
    activeProfile: { id: active, title: active },
    milestones: [
      { id: 'gather_wood', title: 'gather_wood', status: 'active', attempts: 1 },
    ],
    checkpoint: { pos: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:overworld', gameTime: 1000 },
  });
  return store;
}

// 1) 正常写入
saveGoalStore(file, mk());
const good = loadGoalStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 1 });
ck('正常写入可加载', good.ok === true && good.staleCheckpoint === false);

// 2) 只剩 tmp（模拟 rename 前崩溃）
const tmp = path.join(dir, '.goal.json.999.tmp');
fs.writeFileSync(tmp, '{"schemaVersion":1,"hash":"x","payload":{}}', 'utf8');
ck('tmp 不会被当作正式存档', (() => { const r = loadGoalStore(tmp); return r.ok === false && (r.reason === 'hash_mismatch' || r.reason === 'schema_mismatch'); })());
fs.unlinkSync(tmp);

// 3) 写入被截断
const raw = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');
ck('截断文件判负', loadGoalStore(file).reason === 'parse_failed');

// 4) 恢复一份好的，再篡改
saveGoalStore(file, mk());
const env = JSON.parse(fs.readFileSync(file, 'utf8'));
env.payload.activeProfile = null;
fs.writeFileSync(file, JSON.stringify(env), 'utf8');
ck('篡改后 hash 判负', loadGoalStore(file).reason === 'hash_mismatch');

// 5) 重启后 active milestone：未完成 → resume
saveGoalStore(file, mk('gather_wood'));
const loaded = loadGoalStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 1 });
ck('重启加载 active milestone', milestoneProgress(loaded.store).active?.id === 'gather_wood');
ck('未完成 → resume', resumeDecision('gather_wood', { inventory: [] }).action === 'resume');

// 6) 已完成 → done，不重放
ck('已完成 → done（不重放）', resumeDecision('gather_wood', {
  inventory: [{ item: 'minecraft:oak_log', count: 8 }],
}).action === 'done');

// 7) 幂等：同一 store 反复保存/加载，milestone 不重复
const s = mk('gather_wood');
saveGoalStore(file, s);
saveGoalStore(file, s);
const again = loadGoalStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 1 });
ck('重复保存不产生重复 milestone', (again.store?.milestones || []).length === 1);

// 8) epoch 回档：checkpoint 不可信
const stale = loadGoalStore(file, { worldId: 'w1', companionId: 'c1', worldEpoch: 0 });
ck('epoch 回档标记 stale', stale.staleCheckpoint === true);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`P0 kill 矩阵：${p}/${p + f} 通过`);
if (f) process.exit(1);

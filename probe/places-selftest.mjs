// 地点簿自测（只写临时文件，不碰真实 places.json）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlaceBook, inferKind } from '../src/places.mjs';

const file = path.join(os.tmpdir(), `numen-places-selftest-${Date.now()}.json`);
const b = new PlaceBook({ file }).load();

const base = b.record({ name: '家', pos: { x: -95, y: 64, z: 60 }, dimension: 'minecraft:overworld', source: 'llm' });
const mine = b.record({ name: '矿洞入口', pos: { x: -120, y: 40, z: 80 }, dimension: 'minecraft:overworld', note: '有铁', source: 'llm' });
const death = b.record({ name: '死亡点 1', kind: 'death', pos: { x: -168, y: 63, z: 53 }, dimension: 'minecraft:overworld', source: 'tree' });
b.record({ name: '基地二', kind: 'base', pos: { x: 5, y: 70, z: 5 }, dimension: 'minecraft:overworld', source: 'llm' });

const cases = [
  ['家', 'base'],
  ['基地', 'base'],
  ['最近的基地', 'base'],
  ['上次死的地方', 'death'],
  ['矿洞', 'poi'],
  ['主人', null],
  ['不存在的abc', null],
];
const out = [];
for (const [q] of cases) {
  const m = b.find(q, { dimension: 'minecraft:overworld', near: { x: -90, y: 64, z: 55 } });
  out.push(`${q} => ${m ? `${m.place.name}(${m.place.kind}) why=${m.why} dist=${m.distance ?? '-'}` : 'null'}`);
}

const alt = b.find('基地', { dimension: 'minecraft:overworld', near: { x: -90, y: 64, z: 55 } });
console.log('记录数:', b.size);
console.log(out.join('\n'));
console.log('alternatives:', (alt?.alternatives || []).map((p) => p.name).join(',') || '无');
console.log('inferKind(家/坟/那个地方):', inferKind('家'), inferKind('坟'), inferKind('那个地方'));
const gone = b.forget('矿洞');
console.log('forget(矿洞):', gone ? gone.name : null, '剩余:', b.size);

// 重新加载，确认落盘
const b2 = new PlaceBook({ file }).load();
console.log('reload size:', b2.size, 'file exists:', fs.existsSync(file));
fs.unlinkSync(file);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadNumenEndpoint } from '../../src/config.mjs';
import { NumenClient } from '../../src/numen.mjs';

const ep = loadNumenEndpoint(loadConfig());
const n = new NumenClient(ep);
await n.connect();
const { companions } = await n.listCompanions();
const name = companions?.[0]?.name;
if (!name) {
  console.log('没有同伴');
  process.exit(0);
}
const cands = [
  'numen', 'numen.player', 'numen.block', 'numen.item', 'numen.server', 'numen.chat',
  'numen.world', 'numen.action', 'numen.entity', 'numen.time', 'numen.gear',
  'numen.task', 'numen.status', 'numen.scan', 'numen.work', 'numen.move',
  'numen.inv', 'numen.build', 'numen.fight', 'numen.gui', 'numen.shape',
  'numen.api', 'numen.module', 'numen.skill', 'numen.event', 'numen.party',
];
for (const c of cands) {
  const r = await n.lua(name, `return tostring(numen.api.help("${c}"))`, 10000);
  const t = String(r.value ?? r.message ?? '');
  const invalid = /not_found|no function, group or module|bad_argument/.test(t);
  console.log(c, r.kind, invalid ? 'INVALID' : `OK len=${t.length}`);
}
// 官方索引（help("numen") 返回全部组/函数说明）
const idx = await n.lua(name, 'return tostring(numen.api.help("numen"))', 20000);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(HERE, '..', '..', 'docs', '18-data', 'raw-help', 'numen-index.txt');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, String(idx.value ?? idx.message ?? ''), 'utf8');
console.log('index →', out);

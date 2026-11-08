import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/Lihao/.dsh/profiles/desktop/');
const yaml = require('js-yaml');

const path = 'C:/Users/Lihao/.dsh/profiles/desktop/cordis.patch.yml';
const doc = yaml.load(fs.readFileSync(path, 'utf8'));

if (!Array.isArray(doc)) throw new Error('root 不是数组');

console.log(`root 条目数：${doc.length}`);
for (const [i, item] of doc.entries()) {
  const kind = item.insert ? `insert(${item.insert.length})` : item.id;
  console.log(`  [${i}] ${kind}`);
}

const presetEntry = doc.find(
  (d) => d.insert?.some((x) => x.id === 'preset-numen-tree'),
);
if (!presetEntry) throw new Error('找不到 preset-numen-tree');
const preset = presetEntry.insert.find((x) => x.id === 'preset-numen-tree');
const cfg = preset.config;
console.log(`\n预设 id=${cfg.id} name=${cfg.name} order=${cfg.order}`);
console.log(`插件：${cfg.plugins.map((p) => p.id).join(', ')}`);

const persona = cfg.plugins.find((p) => p.id === 'persona');
console.log(`persona 长度：${persona.config.prefix.length} 字符`);
const mcp = cfg.plugins.find((p) => p.id === 'mcp-tree');
console.log(`mcp url：${mcp.config.url}`);
console.log('\nYAML 解析通过 ✅');

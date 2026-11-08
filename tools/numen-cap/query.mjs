#!/usr/bin/env node
/**
 * numen 能力查询（省 token：只输出你要的行）。
 *
 *   node tools/numen-cap/query.mjs --groups            # 有哪些组 + 每组函数数
 *   node tools/numen-cap/query.mjs scan                # 匹配名字含 scan 的行（精简列）
 *   node tools/numen-cap/query.mjs numen.scan.blocks   # 单个函数（含摘要/判定）
 *   node tools/numen-cap/query.mjs --full scan.blocks  # 带原始 helpText
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FILE = path.join(ROOT, 'docs', '18-data', 'capabilities.jsonl');
const MCP = path.join(ROOT, 'docs', '18-data', 'mcp-tools.json');

const args = process.argv.slice(2);
const full = args.includes('--full');
const groupsOnly = args.includes('--groups');
const q = args.find((a) => !a.startsWith('--'))?.toLowerCase() ?? '';

if (!fs.existsSync(FILE)) {
  if (fs.existsSync(MCP)) {
    const tools = JSON.parse(fs.readFileSync(MCP, 'utf8'));
    for (const t of tools) console.log(`mcp  ${t.name}`);
    process.exit(0);
  }
  console.error('还没有能力数据：先跑 node tools/numen-cap/build.mjs --all');
  process.exit(1);
}

const rows = fs
  .readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (groupsOnly) {
  const by = new Map();
  for (const r of rows) by.set(r.group, (by.get(r.group) ?? 0) + 1);
  for (const [g, n] of by) console.log(`${g}\t${n}`);
  process.exit(0);
}

const hit = rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
for (const r of hit.slice(0, 60)) {
  console.log(
    [
      r.name,
      `atomic=${r.atomic}`,
      `role=${r.treeRole}`,
      `prio=${r.priority}`,
      `tested=${r.tested}`,
      `cost=${r.cost}`,
      r.brief ? `| ${r.brief}` : '',
    ].join(' '),
  );
  if (full && r.helpText) console.log(r.helpText.trim() + '\n---');
}
if (hit.length > 60) console.log(`…还有 ${hit.length - 60} 行，缩小关键词`);

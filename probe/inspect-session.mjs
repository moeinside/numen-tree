// 只读：解压 DSH 会话文件（多帧 zstd），统计 preset 与工具调用
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const file = process.argv[2];
if (!file) {
  console.error('用法: node probe/inspect-session.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const buf = fs.readFileSync(file);

function decompressAll(input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const dec = zlib.createZstdDecompress();
    dec.on('data', (c) => chunks.push(c));
    dec.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    dec.on('error', reject);
    Readable.from([input]).pipe(dec);
  });
}

const text = await decompressAll(buf);
const lines = text.split('\n').filter(Boolean);
console.log(`解压后 ${lines.length} 行, ${(text.length / 1024).toFixed(0)} KB`);

const count = (re) => lines.filter((l) => re.test(l)).length;

let preset;
for (const l of lines) {
  const m = l.match(/"agentPreset"\s*:\s*"([^"]+)"/);
  if (m) { preset = m[1]; break; }
}
console.log('agentPreset:', preset ?? '(未找到)');
console.log('mcp__numen__lua 调用行:', count(/mcp__numen__lua/));
console.log('mcp__numen__ 任意工具:', count(/mcp__numen__/));
console.log('mcp__tree__ 任意工具:', count(/mcp__tree__/));

const userMsgs = lines.filter((l) => /"role"\s*:\s*"user"/.test(l)).length;
console.log('user 消息行数:', userMsgs);
const last = lines.slice(-2).map((l) => l.slice(0, 300)).join('\n');
console.log('\n--- 最后一行片段 ---\n' + last);

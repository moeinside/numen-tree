// 只读：把 DSH 会话文件翻译成人能认的清单
// 用法: node probe/session-index.mjs <sessionsDir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node probe/session-index.mjs <sessionsDir>');
  process.exit(2);
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function readRecords(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  let i = 0;
  while (true) {
    const k = buf.indexOf(MAGIC, i);
    if (k < 0) break;
    offs.push(k);
    i = k + 4;
  }
  let text = '';
  for (let n = 0; n < offs.length; n++) {
    const s = offs[n];
    const e = n + 1 < offs.length ? offs[n + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8') + '\n';
    } catch {
      /* 坏帧跳过 */
    }
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function collect(file) {
  const recs = readRecords(file);
  const session = recs.find((r) => r.type === 'session');
  const titles = recs.filter((r) => r.type === 'session/title');
  const title = titles.length ? titles[titles.length - 1].data.title : '(无标题)';

  const userMsgs = recs.filter(
    (r) => r.type === 'user/message' && r.data?.source?.kind === 'user',
  );
  const firstUser = userMsgs.length
    ? (userMsgs[0].data.content || [])
        .map((c) => c.text || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 80)
    : '(无)';

  const toolCalls = recs.filter((r) => r.type === 'tool/call');
  const counts = {};
  for (const t of toolCalls) {
    const n = t.data?.name || '?';
    counts[n] = (counts[n] || 0) + 1;
  }
  const numenCalls = Object.entries(counts)
    .filter(([n]) => n.startsWith('mcp__numen__'))
    .reduce((a, [, v]) => a + v, 0);
  const luaCalls = counts['mcp__numen__lua'] || 0;
  const treeCalls = Object.entries(counts)
    .filter(([n]) => n.startsWith('mcp__tree__'))
    .reduce((a, [, v]) => a + v, 0);

  const lastTime = recs.length ? recs[recs.length - 1].time : null;
  return {
    id: session?.id || path.basename(path.dirname(file)),
    preset: session?.agentPreset || '?',
    title,
    firstUser,
    numenCalls,
    luaCalls,
    treeCalls,
    lastTime,
    turns: recs.filter((r) => r.type === 'turn/start').length,
  };
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl.zstd')) files.push(p);
  }
})(dir);

const rows = files.map((f) => ({ file: f, ...collect(f) }));
rows.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));

const fmt = (t) => (t ? new Date(t).toLocaleString('sv') : '?');
console.log('titles / preset / numen(lua) / tree / 最后活动\n');
for (const r of rows) {
  const flag = r.numenCalls ? (r.luaCalls ? '🔴' : '🟡') : '⚪';
  console.log(
    `${flag} ${r.title}\n   id=${r.id.slice(8, 16)} preset=${r.preset} numen=${r.numenCalls}(lua ${r.luaCalls}) tree=${r.treeCalls} turns=${r.turns} 最后=${fmt(r.lastTime)}\n   首条用户消息: ${r.firstUser}\n`,
  );
}

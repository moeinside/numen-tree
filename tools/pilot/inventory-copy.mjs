#!/usr/bin/env node
/**
 * inventory-copy — 按需夹具工具：重建同伴前快照背包，重建后用 GM 复制回去。
 *
 *   node tools/pilot/inventory-copy.mjs snapshot --companion bigwhale
 *   node tools/pilot/inventory-copy.mjs restore --file runs/inventory-snapshots/xxx.json --dry-run
 *   node tools/pilot/inventory-copy.mjs restore --file ... --apply
 *
 * 只复制物品 id + 数量；不复制 NBT/附魔/耐久。标 assisted；不进 Track A。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNumenClient } from './numen-client.mjs';
import { createGMProvider } from './gm-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAP_DIR = path.join(ROOT, 'runs', 'inventory-snapshots');
const TOKEN_FILE = 'E:/game/HMCL/.minecraft/versions/1.21.1-NeoForge/config/numen-devtools.token';

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? argv[++i];
  }
  return out;
}

function itemLine() {
  return `local items = numen.inv.items() or {}
local out = {}
for _, it in ipairs(items) do
  local id = tostring(it.item or it.id or "")
  local n = tonumber(it.count or 1) or 1
  if id ~= "" and n > 0 then table.insert(out, id .. ":" .. tostring(n)) end
end
return table.concat(out, ",")`;
}

async function snapshot(companion) {
  const client = await createNumenClient({ timeoutMs: 60_000 });
  const r = await client.callTool('lua', { companion, code: itemLine() });
  if (!r.ok) throw new Error(r.text || 'lua failed');
  const line = String(r.text ?? '').split(/\r?\n/).find((x) => x.startsWith('returned:')) ?? '';
  const body = line.replace(/^returned:\s*/, '').trim();
  const items = body
    ? body.split(',').map((part) => {
        const i = part.lastIndexOf(':');
        return { item: part.slice(0, i), count: Number(part.slice(i + 1)) || 1 };
      }).filter((x) => /^minecraft:[a-z0-9_]+$/.test(x.item))
    : [];
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const at = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SNAP_DIR, `${companion}-${at}.json`);
  fs.writeFileSync(file, JSON.stringify({ companion, at: new Date().toISOString(), items }, null, 2));
  console.log(JSON.stringify({ ok: true, file, companion, items: items.length, total: items.reduce((s, x) => s + x.count, 0) }, null, 2));
  return file;
}

function loadSnapshot(file) {
  const p = path.resolve(ROOT, file);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(data.items)) throw new Error('snapshot items missing');
  return data;
}

async function restore(companion, file, apply) {
  const data = loadSnapshot(file);
  const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : null;
  if (!token) throw new Error('GM token missing');
  const gm = createGMProvider({ token, journalPath: path.join(ROOT, 'logs', 'inventory-copy-gm.jsonl') });
  const commands = [];
  for (const it of data.items) {
    if (!/^minecraft:[a-z0-9_]+$/.test(it.item)) continue;
    let left = Math.max(0, Number(it.count) || 0);
    while (left > 0) {
      const n = Math.min(64, left);
      commands.push(`execute as @e[name=${companion},limit=1] run give @s ${it.item} ${n}`);
      left -= n;
    }
  }
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, companion, file, commands: commands.length, items: data.items }, null, 2));
    return;
  }
  let ok = 0;
  for (const command of commands) {
    let r = await gm.command({
      runId: 'inventory-copy',
      command,
      reason: 'fixture_inventory_copy',
      selfChallenge: ['按需求复制旧背包', '只复制 id/count', '标 assisted', '不进 Track A'],
      before: { phase: 'inventory_restore' },
      after: { command },
    });
    if (!r.ok && r.error?.code === 'rate_limited') {
      await new Promise((res) => setTimeout(res, 61_000));
      r = await gm.command({
        runId: 'inventory-copy',
        command,
        reason: 'fixture_inventory_copy',
        selfChallenge: ['按需求复制旧背包', '重试限流', '标 assisted'],
      });
    }
    if (r.ok) ok += 1;
    else console.error(JSON.stringify({ command, error: r.error }));
  }
  console.log(JSON.stringify({ ok: ok === commands.length, companion, file, applied: ok, total: commands.length, assisted: true }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const args = argsOf(rest);
try {
  if (cmd === 'snapshot') {
    if (!args.companion) throw new Error('--companion required');
    await snapshot(args.companion);
  } else if (cmd === 'restore') {
    if (!args.companion) throw new Error('--companion required');
    if (!args.file) throw new Error('--file required');
    await restore(args.companion, args.file, !!args.apply);
  } else {
    console.error('usage: snapshot --companion NAME | restore --companion NAME --file SNAP [--apply]');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
}

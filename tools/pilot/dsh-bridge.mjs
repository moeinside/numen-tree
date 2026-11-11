/**
 * DSH 子体 pilot 的 MCP bridge（5 分钟参考跑）
 * 每次调用都追加到 runs/dsh-pilot-5min/actions.jsonl，便于独立审计。
 *
 *   node tools/pilot/dsh-bridge.mjs status
 *   node tools/pilot/dsh-bridge.mjs events
 *   node tools/pilot/dsh-bridge.mjs list
 *   node tools/pilot/dsh-bridge.mjs lua --file=logs/xxx.lua
 *   node tools/pilot/dsh-bridge.mjs say --text="..."
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNumenClient } from './numen-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_DIR = process.env.PILOT_RUN_DIR
  ? path.resolve(process.env.PILOT_RUN_DIR)
  : path.join(ROOT, 'runs', 'dsh-pilot-5min');
const LOG = path.join(RUN_DIR, 'actions.jsonl');
const COMPANION = process.env.NUMEN_COMPANION || 'bigwhale';
fs.mkdirSync(RUN_DIR, { recursive: true });

const OBSERVE = `local ok,s=pcall(numen.status.self)
if not ok then return "ERR:"..tostring(s) end
local p=s.pos or {}
return string.format("hp=%s food=%s pos=%s,%s,%s",
  tostring(s.hp), tostring(s.food or s.hunger),
  tostring(p.x), tostring(p.y), tostring(p.z))`;

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? argv[++i];
  }
  return out;
}

function log(entry) {
  fs.appendFileSync(
    LOG,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const args = parse(process.argv.slice(3));
  const client = await createNumenClient({ timeoutMs: 60_000 });
  let r;
  if (cmd === 'list') {
    r = await client.listCompanions();
  } else if (cmd === 'events') {
    r = await client.getEvents(COMPANION);
  } else if (cmd === 'status') {
    r = await client.callTool('lua', { companion: COMPANION, code: OBSERVE });
  } else if (cmd === 'lua') {
    const code = args.file
      ? fs.readFileSync(path.resolve(args.file), 'utf8')
      : String(args.code ?? '');
    if (!code) throw new Error('lua needs --file or --code');
    r = await client.callTool('lua', { companion: COMPANION, code });
  } else if (cmd === 'say') {
    r = await client.callTool('say', {
      companion: COMPANION,
      text: String(args.text ?? ''),
    });
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
  log({
    cmd,
    companion: COMPANION,
    args,
    ok: !r.isError,
    text: r.text,
  });
  const max = Number(process.env.PILOT_MAX_OUTPUT || 1200);
  const text = String(r.text ?? '');
  console.log(
    text.length > max
      ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`
      : text,
  );
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exitCode = 1;
  });

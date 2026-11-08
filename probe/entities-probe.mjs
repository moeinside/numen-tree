import { loadConfig, loadNumenEndpoint } from '../src/config.mjs';
import { NumenClient } from '../src/numen.mjs';

const n = new NumenClient(loadNumenEndpoint(loadConfig()));
await n.connect();
const { companions } = await n.listCompanions();
const name = companions?.[0]?.name;
if (!name) { console.log('no companion'); process.exit(0); }
const code = `
local es = numen.scan.entities("all", { radius = 24 }) or {}
local parts = {}
for i, e in ipairs(es) do
  if i > 12 then break end
  parts[#parts+1] = string.format("%s id=%s type=%s cat=%s d=%.1f", tostring(e.type), tostring(e.id), tostring(e.type), tostring(e.category), e.distance or -1)
end
return string.format("n=%d | %s", #es, table.concat(parts, " ; "))
`;
for (let i = 0; i < 5; i++) {
  const r = await n.lua(name, code, 15000);
  const t = String(r.value ?? r.message ?? '');
  if (/already running/i.test(t)) { await new Promise((x) => setTimeout(x, 1000)); continue; }
  console.log(`kind=${r.kind} text=${t}`);
  break;
}

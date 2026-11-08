import { loadConfig, loadNumenEndpoint } from '../src/config.mjs';
import { NumenClient } from '../src/numen.mjs';

const n = new NumenClient(loadNumenEndpoint(loadConfig()));
await n.connect();
const { companions } = await n.listCompanions();
const name = companions?.[0]?.name;
if (!name) { console.log('no companion'); process.exit(0); }
const code = `
local es = numen.scan.entities("hostile", { radius = 64 }) or {}
local parts = {}
for i, e in ipairs(es) do
  local p = e.pos or {}
  parts[#parts+1] = string.format("%s id=%s d=%.1f pos=%d,%d,%d hp=%.1f", tostring(e.type), tostring(e.id), e.distance or -1, p.x or 0, p.y or 0, p.z or 0, e.hp or -1)
  if i >= 6 then break end
end
return string.format("n=%d | %s", #es, table.concat(parts, " ; "))
`;
for (let i = 0; i < 4; i++) {
  const r = await n.lua(name, code, 15000);
  const t = String(r.value ?? r.message ?? '');
  if (/already running/i.test(t)) { await new Promise((x) => setTimeout(x, 1200)); continue; }
  console.log(`kind=${r.kind} text=${t}`);
  break;
}

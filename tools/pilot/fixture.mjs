/**
 * Fixture 阶段作弊（仅 creative.give）
 * 必须在 RUNNING 之前；失败不绕过。
 */
const KITS = {
  give_wood_kit: [
    { id: 'minecraft:oak_log', n: 8 },
    { id: 'minecraft:crafting_table', n: 1 },
    { id: 'minecraft:wooden_pickaxe', n: 1 },
    { id: 'minecraft:wooden_axe', n: 1 },
    { id: 'minecraft:wooden_sword', n: 1 },
  ],
  give_food: [
    { id: 'minecraft:bread', n: 4 },
    { id: 'minecraft:cooked_beef', n: 2 },
  ],
  give_torch: [{ id: 'minecraft:torch', n: 8 }],
};

function buildLua(items) {
  const rows = items
    .map((it) => `{id="${it.id}", n=${Number(it.n) || 1}}`)
    .join(',');
  return `local items={${rows}}
local msgs={}
local all=true
for _,it in ipairs(items) do
  local ok,res=pcall(numen.creative.give,it.id,{count=it.n})
  if ok then
    table.insert(msgs,it.id..":ok:"..tostring(res.took or "?"))
  else
    all=false
    table.insert(msgs,it.id..":fail:"..tostring(res))
  end
end
return (all and "OK:" or "FAIL:")..table.concat(msgs,",")`;
}

export async function applyFixture({
  kind,
  client,
  companion,
  allowCreative = false,
}) {
  if (!kind) return { ok: true, noop: true };
  const items = KITS[kind];
  if (!items) return { ok: false, error: `unknown fixture: ${kind}` };
  if (!allowCreative) {
    return {
      ok: false,
      error: 'fixture requires --allow-creative (creative.give is Creative mode only)',
    };
  }
  const code = buildLua(items);
  const r = await client.callTool('lua', { companion, code });
  const ok = !r.isError && /^OK:/.test(r.text);
  return {
    ok,
    kind,
    code,
    tool: r,
    error: ok ? null : r.text || 'fixture failed',
  };
}

export function fixtureKinds() {
  return Object.keys(KITS);
}

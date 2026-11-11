import { LUA_PRELUDE } from './prelude.mjs';

/**
 * panic_shelter —— 紧急侧避险的简化实现：脚下竖挖 2 格、进入、用土封顶。
 * 只在下挖成功后执行；不覆盖反射，不保证出口，属于有界终态。
 * params: block（默认 minecraft:dirt）
 */
export default {
  id: 'panic_shelter',
  title: '紧急避险：下挖 2 格并用土封顶',
  params: { block: 'string = minecraft:dirt' },
  build(ctx, params = {}) {
    const block = String(params.block || 'minecraft:dirt').replace(/[^a-z0-9_]/g, '');
    const code = `${LUA_PRELUDE}
local s = numen.status.self()
local p = s.pos
local name = '${block}':gsub('^minecraft:', '')
local y1 = p.y - 1
local y2 = p.y - 2
local ok1, r1 = pcall(numen.work.dig, { x = p.x, y = y1, z = p.z }, { count = 1 })
if not ok1 then return FAIL(r1) end
local ok2, r2 = pcall(numen.work.dig, { x = p.x, y = y2, z = p.z }, { count = 1 })
if not ok2 then return FAIL(r2) end
local okm, rm = pcall(numen.move.to, { x = p.x, y = y2, z = p.z }, { arrive = 'near', range = 1 })
if not okm then return FAIL(rm) end
local okp, rp = pcall(numen.build.place, { { name = name, pos = { x = p.x, y = p.y, z = p.z } } })
if not okp then return FAIL(rp) end
return J({ { "sealed", "true" }, { "depth", N(2) }, { "block", S(name) }, { "at", S(tostring(p.x)..","..tostring(y2)..","..tostring(p.z)) } })
`;
    return { code, timeoutMs: 30_000 };
  },
};

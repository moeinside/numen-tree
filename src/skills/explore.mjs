import { LUA_PRELUDE } from './prelude.mjs';

/**
 * explore —— 朝一个随机方向走一段，用来"找不到资源就出去找"。
 * params: seconds (默认 30), hop (每跳格数，默认 16)
 */
export default {
  id: 'explore',
  title: '朝一个方向探索',
  params: { seconds: 'number = 30', hop: 'number = 16' },
  build(ctx, params = {}) {
    // 单次探索最多 150 秒：再长客户端就要等超时，宁可小步多跑几次
    const seconds = Math.min(150, Math.max(5, Number(params.seconds ?? 30)));
    const hop = Math.min(32, Math.max(8, Number(params.hop ?? 16)));
    const code = `${LUA_PRELUDE}
local dirs = { "north", "south", "east", "west" }
local dir = dirs[math.random(#dirs)]
local ok, r = pcall(function()
  return numen.move.explore(dir, {
    seconds = ${seconds},
    hop = ${hop},
    until_ = function() return nil end,
  })
end)
if not ok then return FAIL(r) end
return J({ { "dir", S(dir) }, { "seconds", N(${seconds}) } })
`;
    return { code, timeoutMs: (seconds + 30) * 1000 };
  },
};

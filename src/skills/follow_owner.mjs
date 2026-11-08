import { LUA_PRELUDE } from './prelude.mjs';

/**
 * follow_owner —— 跟随主人一段时间。
 * params: seconds (默认 30，最大 1200), distance (默认 3)
 */
export default {
  id: 'follow_owner',
  title: '跟随主人一段时间',
  params: { seconds: 'number = 30', distance: 'number = 3' },
  build(ctx, params = {}) {
    // 单次跟随最多 150 秒（长跟随要由大脑/树分段下）
    const seconds = Math.min(150, Math.max(1, Number(params.seconds ?? 30)));
    const distance = Math.max(1, Number(params.distance ?? 3));
    const code = `${LUA_PRELUDE}
local ok, r = pcall(function()
  local o = numen.status.owner()
  if not o.online then
    error({ kind = "owner_offline", message = "owner is offline" })
  end
  return numen.move.follow(nil, { distance = ${distance}, seconds = ${seconds} })
end)
if not ok then return FAIL(r) end
return J({ { "seconds", N(${seconds}) } })
`;
    return { code, timeoutMs: (seconds + 30) * 1000 };
  },
};

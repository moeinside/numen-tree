import { LUA_PRELUDE } from './prelude.mjs';

/**
 * idle —— 原地等一段时间（占住调用但不做动作，用于让位/节流）。
 * params: seconds (默认 10)
 */
export default {
  id: 'idle',
  title: '原地等待',
  params: { seconds: 'number = 10' },
  build(ctx, params = {}) {
    const seconds = Math.min(180, Math.max(0.5, Number(params.seconds ?? 10)));
    const code = `${LUA_PRELUDE}
numen.time.wait(${seconds})
return J({ { "seconds", N(${seconds}) } })
`;
    return { code, timeoutMs: (seconds + 20) * 1000 };
  },
};

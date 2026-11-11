/** 步数/时间/token caps */
export function createCaps({ steps = 200, minutes = 20, maxTokens = 200_000 } = {}) {
  return {
    steps,
    minutes,
    maxTokens,
    startedAt: Date.now(),
    check({ stepsUsed = 0, tokens = 0 } = {}) {
      if (stepsUsed >= steps) return { ok: false, reason: 'max_steps' };
      if (Date.now() - this.startedAt >= minutes * 60_000) {
        return { ok: false, reason: 'max_minutes' };
      }
      if (tokens >= maxTokens) return { ok: false, reason: 'max_tokens' };
      return { ok: true };
    },
  };
}

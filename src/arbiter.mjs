/**
 * 动态决策：效用仲裁（docs/24）。
 *
 * 设计：
 *  - 硬优先级（P0/P1/P2，>=80）永远压过普通效用；
 *  - 普通战略用 score（0~100）竞争；
 *  - 只在决策点调用；带迟滞（margin）、最短运行时间、冷却、防饿死。
 *
 * 候选接口：
 * {
 *   id, level, kind,
 *   hard?: boolean, hardPriority?: number,     // hard=true 或 hardPriority>=80
 *   eligible(ctx): boolean,
 *   score(ctx): { total, parts? },             // 0~100
 *   minRunSeconds?: number,
 *   cooldownSeconds?: number,
 * }
 */
export const HARD_FLOOR = 80;

export function createArbiterState(now = Date.now()) {
  return {
    currentId: null,
    currentSince: now,
    waitingSince: {},
    cooldowns: {},
    lastEvals: [],
    lastChoice: null,
  };
}

function isHard(c) {
  return c?.hard === true || Number(c?.hardPriority ?? 0) >= HARD_FLOOR;
}

function cooldownLeft(state, id, now, c) {
  const until = state.cooldowns[id] || 0;
  const sec = Number(c?.cooldownSeconds ?? 0) * 1000;
  return Math.max(0, Math.max(until, 0) - now, sec > 0 ? 0 : 0);
}

/**
 * 评估所有候选，返回带分数/是否可用的列表（按 total 降序）。
 */
export function evaluateCandidates(candidates, ctx, state, { now = Date.now(), starvationMax = 10 } = {}) {
  const evals = [];
  for (const c of candidates || []) {
    let eligible = false;
    try {
      eligible = c.eligible ? !!c.eligible(ctx) : true;
    } catch {
      eligible = false;
    }
    if (!eligible) {
      evals.push({ id: c.id, hard: isHard(c), eligible: false, total: 0, parts: {} });
      continue;
    }
    let raw = { total: 0, parts: {} };
    try {
      raw = c.score ? c.score(ctx) : { total: 0 };
    } catch {
      raw = { total: 0, parts: { error: true } };
    }
    if (!Number.isFinite(Number(raw?.total))) raw.total = 0;
    // 防饿死：等得越久加分（仅非当前候选）
    if (state?.currentId !== c.id) {
      state.waitingSince ??= {};
      state.waitingSince[c.id] ??= now;
      const waitedSec = Math.max(0, (now - state.waitingSince[c.id]) / 1000);
      const age = Math.min(starvationMax, Math.floor(waitedSec / 30));
      raw = { ...raw, total: Math.min(100, Number(raw.total) + age) };
      raw.parts = { ...(raw.parts || {}), starvation: age };
    }
    evals.push({
      id: c.id,
      hard: isHard(c),
      hardPriority: Number(c.hardPriority ?? 0),
      eligible: true,
      total: Number(raw.total),
      parts: raw.parts || {},
      candidate: c,
    });
  }
  return evals.sort((a, b) => {
    if (a.hard !== b.hard) return a.hard ? -1 : 1;
    if (a.hard) return (b.hardPriority ?? 0) - (a.hardPriority ?? 0);
    return b.total - a.total;
  });
}

/**
 * 选一个当前该做的候选。
 * @returns {{choice:any|null, reason:string, switched:boolean, evals:Array}}
 */
export function chooseCandidate(candidates, ctx, state, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const margin = Number(opts.margin ?? 8);
  const evals = evaluateCandidates(candidates, ctx, state, { now, starvationMax: opts.starvationMax ?? 10 });
  const eligible = evals.filter((e) => e.eligible);
  if (!eligible.length) {
    if (state.currentId) state.currentId = null;
    return { choice: null, reason: 'no_eligible', switched: state.currentId !== null, evals };
  }
  const current = state.currentId ? eligible.find((e) => e.id === state.currentId) : null;
  const hard = eligible.find((e) => e.hard);

  // 硬优先级：只要有可用的硬候选，就压过普通战略
  if (hard) {
    if (current?.id === hard.id) return { choice: hard.candidate ?? hard, reason: 'keep_hard', switched: false, evals };
    const cooldownUntil = state.cooldowns?.[hard.id] || 0;
    if (now < cooldownUntil) {
      // 硬候选冷却中：退而求其次
    } else {
      state.currentId = hard.id;
      state.currentSince = now;
      state.waitingSince[hard.id] = now;
      const choice = hard.candidate ?? hard;
      state.lastChoice = { id: hard.id, reason: 'hard', at: now, total: hard.total };
      return { choice, reason: 'hard', switched: current?.id !== hard.id, evals };
    }
  }

  // 普通效用：当前仍可用 → 迟滞比较
  const top = eligible.find((e) => !e.hard);
  if (!top) return { choice: current?.candidate ?? null, reason: 'keep_current', switched: false, evals };

  if (current && !current.hard) {
    const cDef = current.candidate || {};
    const minRun = Number(cDef.minRunSeconds ?? 0) * 1000;
    const ranFor = now - Number(state.currentSince || now);
    if (top.id === current.id) return { choice: current.candidate ?? current, reason: 'keep_current', switched: false, evals };
    if (ranFor < minRun) {
      return { choice: current.candidate ?? current, reason: 'min_run', switched: false, evals };
    }
    const switchCost = Number(cDef.switchCost ?? 0);
    if (top.total <= current.total + margin + switchCost) {
      return { choice: current.candidate ?? current, reason: 'hysteresis', switched: false, evals };
    }
    if (now < (state.cooldowns?.[top.id] || 0)) {
      return { choice: current.candidate ?? current, reason: 'cooldown', switched: false, evals };
    }
  }

  state.currentId = top.id;
  state.currentSince = now;
  state.waitingSince[top.id] = now;
  const choice = top.candidate ?? top;
  state.lastChoice = { id: top.id, reason: 'utility', at: now, total: top.total };
  return { choice, reason: 'utility', switched: true, evals };
}

/** 放弃/完成当前候选后设置冷却。 */
export function abandonCandidate(state, id, now = Date.now(), cooldownSeconds = 30) {
  if (!id) return state;
  state.cooldowns ??= {};
  state.cooldowns[id] = now + Number(cooldownSeconds) * 1000;
  if (state.currentId === id) {
    state.currentId = null;
    state.currentSince = now;
  }
  return state;
}

export function describeChoice(state) {
  return state.lastChoice || null;
}

/**
 * 战术包运行器（最小版）：
 *  - 按战术包数据解释 atom/call/if/retry/until/set；
 *  - 强制预算（maxAtoms/maxSeconds）与"同失败熔断"（防死循环）；
 *  - 支持注入式抢占（测试用）与硬抢占后的 settle；
 *  - 不直接碰 numen：执行一个原子由调用方注入 executeAtom(atomId, params)（真实=numen.lua，测试=Fake）。
 * 抗打断/防混乱的不变量见 docs/19 §8。
 */
import { getTactic, resolveValue, evalCondition } from './tactics.mjs';

export class TacticError extends Error {
  constructor(kind, message) {
    super(message || kind);
    this.name = 'TacticError';
    this.kind = kind;
  }
}

const DEFAULTS = { maxAtoms: 30, maxSeconds: 60, maxSameFail: 3 };

const HARD_ABORT_KINDS = ['preempted', 'budget', 'breaker', 'call_depth', 'bad_op'];

export async function runTactic(tacticId, params = {}, opts = {}) {
  const tactic = getTactic(tacticId);
  if (!tactic) throw new Error(`未知战术包：${tacticId}`);
  const executeAtom = opts.executeAtom;
  if (typeof executeAtom !== 'function') throw new Error('runTactic 需要 executeAtom 回调');
  const now = opts.now ?? (() => Date.now());
  const budget = { ...DEFAULTS, ...(tactic.budget ?? {}), ...(opts.budget ?? {}) };
  const ctx = { tactic: tactic.id, params: params ?? {}, vars: {}, last: null, atoms: 0, failCounts: new Map() };
  const started = now();
  const interruptBeforeAtom = Number(opts.interruptBeforeAtom ?? 0);
  const depth = Number(opts.depth ?? 0);

  const checkBudget = () => {
    if (ctx.atoms >= budget.maxAtoms) throw new TacticError('budget', `maxAtoms ${budget.maxAtoms}`);
    if (now() - started > budget.maxSeconds * 1000) throw new TacticError('budget', `maxSeconds ${budget.maxSeconds}`);
  };

  const runAtom = async (step) => {
    checkBudget();
    if (interruptBeforeAtom && ctx.atoms + 1 === interruptBeforeAtom) {
      throw new TacticError('preempted', '注入的抢占（测试）');
    }
    const resolved = resolveValue(step.params ?? {}, ctx);
    const r = await executeAtom(step.atom, resolved, { tactic: tactic.id, timeoutMs: step.timeoutMs });
    ctx.atoms += 1;
    ctx.last = r;
    if (step.as) ctx.vars[step.as] = r;
    if (!r || r.ok !== true) {
      const kind = r?.kind || 'failed';
      const n = (ctx.failCounts.get(kind) ?? 0) + 1;
      ctx.failCounts.set(kind, n);
      if (n >= budget.maxSameFail) throw new TacticError('breaker', `同一失败 ${kind} 连续 ${n} 次`);
      throw new TacticError(kind, r?.msg || r?.message || '原子失败');
    }
  };

  const runSteps = async (list) => {
    for (const step of list) {
      switch (step.op) {
        case 'atom':
          await runAtom(step);
          break;
        case 'set': {
          const vals = resolveValue(step.vars ?? {}, ctx);
          Object.assign(ctx.vars, vals);
          break;
        }
        case 'if': {
          const ok = evalCondition(step.cond, ctx);
          const branch = ok ? step.then : step.else;
          if (branch) await runSteps(branch);
          break;
        }
        case 'retry': {
          const max = Math.max(1, Number(step.maxTries ?? 1));
          let lastErr = null;
          for (let t = 0; t < max; t++) {
            try {
              await runSteps(step.steps ?? []);
              lastErr = null;
              break;
            } catch (e) {
              if (e instanceof TacticError && HARD_ABORT_KINDS.includes(e.kind)) throw e;
              lastErr = e;
            }
          }
          if (lastErr) throw lastErr;
          break;
        }
        case 'until': {
          const maxRounds = Math.max(1, Number(step.maxRounds ?? 1));
          for (let r = 0; r < maxRounds; r++) {
            await runSteps(step.steps ?? []);
            if (evalCondition(step.cond, ctx)) {
              ctx.vars.__untilOk = true;
              return;
            }
          }
          throw new TacticError('loop_exhausted', `until ${maxRounds} 轮未满足`);
        }
        case 'call': {
          if (depth >= 2) throw new TacticError('call_depth', '战术包嵌套过深');
          const resolved = resolveValue(step.params ?? {}, ctx);
          const res = await runTactic(step.tactic, resolved, { ...opts, depth: depth + 1 });
          if (step.as) ctx.vars[step.as] = res;
          if (!res.ok) throw new TacticError(res.kind || 'failed', res.message);
          break;
        }
        default:
          throw new TacticError('bad_op', `未知 op ${step.op}`);
      }
    }
  };

  try {
    await runSteps(tactic.steps ?? []);
    if (!evalCondition(tactic.success, ctx)) throw new TacticError('not_success', '成功条件不满足');
    return {
      ok: true,
      tacticId: tactic.id,
      kind: 'ok',
      atoms: ctx.atoms,
      ms: now() - started,
      vars: ctx.vars,
      last: ctx.last,
    };
  } catch (e) {
    const kind = e instanceof TacticError ? e.kind : 'error';
    return {
      ok: false,
      tacticId: tactic.id,
      kind,
      message: String(e?.message ?? e),
      preempted: kind === 'preempted',
      atoms: ctx.atoms,
      ms: now() - started,
      vars: ctx.vars,
      last: ctx.last,
    };
  }
}

/** 急刹后统一 settle（docs/19 §8 A2）。 */
export async function runSettle(executeAtom, opts = {}) {
  return runTactic('settle', {}, { ...opts, executeAtom });
}

/** 是否需要 settle（硬中断类结果）。'detached' = 原子被外部急刹切断（numen 回执），必须 settle。 */
export function needsSettle(kind) {
  return ['preempted', 'timeout', 'slot_blocked', 'dead', 'detached'].includes(String(kind));
}

/** 防抖动：同一战术包在窗口内被抢占太多次 → 应放弃并上报。 */
export function shouldAbandon({ preemptCount = 0, firstPreemptAt = 0, now = Date.now(), windowMs = 30_000, limit = 3 } = {}) {
  if (preemptCount < limit) return false;
  if (!firstPreemptAt) return true;
  return now - firstPreemptAt <= windowMs;
}

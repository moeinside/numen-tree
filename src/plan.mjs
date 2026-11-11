/**
 * 计划层（纯函数 + 数据，不碰游戏、不碰网络）。
 *
 * 职责：意图 → 配方匹配 → 生成计划 → 按"下一步/失败分支"推进。
 * 边界：只查表 + 固定规则；不认识具体技能，只认步骤里的 skill id。
 *
 * 计划形态见 docs/12-全功能树设计-M1.md §2.1；配方见 recipes.mjs。
 */

export const PlanStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DONE: 'done',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
};

/** 失败 kind → 默认处置（配方没写 onFail 时用） */
export const DEFAULT_RECOVERY = {
  not_found: 'fail',
  no_path: 'retry_once',
  out_of_reach: 'retry_once',
  denied: 'fail',
  owner_offline: 'fail',
  bad_argument: 'fail',
  slot_blocked: 'suspend',
  timeout: 'suspend',
  interrupted: 'suspend',
  failed: 'retry_once',
  unknown: 'retry_once',
};

/** 术语归一：去空白、全角转半角、小写。 */
export function normalizeIntent(input) {
  return String(input ?? '')
    .replace(/[\u3000\s]+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

let planSeq = 0;

function cloneSteps(recipe) {
  // 用展开保底：配方步骤上的自定义字段（escalate、as、note…）一个都不能丢；
  // 只把 params/onFail 复制成新对象，避免多条计划共享同一个引用。
  return (recipe.steps || []).map((s) => ({
    ...s,
    params: { ...(s.params || {}) },
    next: s.next === undefined ? null : s.next,
    onFail: { ...(s.onFail || {}) },
    maxVisits: Number(s.maxVisits ?? 2),
    budgetMs: s.budgetMs ?? null,
  }));
}

export function makePlan({ recipe, intent, source = 'llm', deadlineSeconds = null, steps }) {
  return {
    id: `pl${++planSeq}`,
    recipeId: recipe.id,
    title: recipe.title || recipe.id,
    intent: String(intent ?? ''),
    source,
    status: PlanStatus.ACTIVE,
    steps: steps || cloneSteps(recipe),
    doneWhen: recipe.doneWhen || null,
    maxRounds: recipe.maxRounds ?? null,
    cursor: null, // 进入计划后由 nextStepLabel 设置（第一条）
    visits: {},
    rounds: 0,
    suspendedBy: null,
    suspendedAt: null,
    stepResults: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    deadlineAt: deadlineSeconds ? Date.now() + Number(deadlineSeconds) * 1000 : null,
    lastError: null,
  };
}

export class Planner {
  constructor({ recipes = [], trace = null } = {}) {
    this.recipes = recipes;
    this.trace = trace;
  }

  listRecipes() {
    return this.recipes.map((r) => ({ id: r.id, title: r.title || r.id, match: r.match || [] }));
  }

  /**
   * 意图模糊匹配配方。返回 { recipe, why } 或 { error, tried }。
   * 顺序：配方 id 精确 → 别名精确 → 别名互相包含。
   */
  match(intent) {
    const q = normalizeIntent(intent);
    if (!q) return { error: 'empty_intent' };
    for (const r of this.recipes) {
      if (normalizeIntent(r.id) === q) return { recipe: r, why: `配方 id 精确匹配 ${r.id}` };
    }
    for (const r of this.recipes) {
      for (const alias of r.match || []) {
        if (normalizeIntent(alias) === q) return { recipe: r, why: `别名精确匹配「${alias}」` };
      }
    }
    let best = null;
    for (const r of this.recipes) {
      for (const alias of r.match || []) {
        const a = normalizeIntent(alias);
        if (a && (q.includes(a) || a.includes(q))) {
          const score = Math.min(q.length, a.length);
          if (!best || score > best.score) best = { recipe: r, score, alias };
        }
      }
    }
    if (best) return { recipe: best.recipe, why: `别名包含匹配「${best.alias}」` };
    return { error: 'no_recipe', tried: String(intent ?? '') };
  }

  build(recipe, { intent, source = 'llm', deadlineSeconds = null, overrides = {} }) {
    const steps = cloneSteps(recipe);
    for (const s of steps) {
      if (overrides[s.as]) s.params = { ...s.params, ...overrides[s.as] };
    }
    const plan = makePlan({ recipe, intent, source, deadlineSeconds, steps });
    plan.cursor = steps.length ? steps[0].as : null;
    plan.startedAt = new Date().toISOString();
    plan.visits[plan.cursor] = 1;
    return plan;
  }
}

/** 当前步骤对象；cursor 为空/不存在 → null（计划该结束了）。 */
export function currentStep(plan) {
  if (!plan || !plan.cursor) return null;
  return plan.steps.find((s) => s.as === plan.cursor) || null;
}

export function stepIndex(plan) {
  if (!plan) return { index: 0, total: 0 };
  const total = plan.steps.filter((s) => s.skill || s.type).length;
  const executed = plan.stepResults.length;
  return { index: Math.min(executed, total), total };
}

/** 计划进入某个标签；超过 maxVisits 返回 false（表示该失败）。 */
export function enterLabel(plan, label) {
  if (!label || label === 'done') {
    plan.cursor = null;
    return { ok: true, label: null };
  }
  const step = plan.steps.find((s) => s.as === label);
  if (!step) return { ok: false, reason: 'unknown_label', label };
  const n = (plan.visits[label] || 0) + 1;
  const max = Number(step.maxVisits ?? 2);
  if (n > max) return { ok: false, reason: 'max_visits', label, max };
  plan.visits[label] = n;
  plan.cursor = label;
  return { ok: true, label };
}

/**
 * 一步结束后的决策。纯函数。
 *
 * @returns {{kind:'advance',label:string}|{kind:'plan_done',reason:string}|
 *           {kind:'retry',label:string}|{kind:'suspend',by:string}|
 *           {kind:'report',escalate:string,reason:string}|{kind:'fail',reason:string}}
 */
export function decideAfterStep(plan, step, result) {
  if (!plan || !step) return { kind: 'fail', reason: 'no_step' };
  const ok = !!result?.ok;
  const failKind = result?.kind || 'failed';

  if (ok) {
    // 成功的下一步：next 为空 / 'done' = 计划完成
    if (!step.next || step.next === 'done') return { kind: 'plan_done', reason: 'steps_exhausted' };
    const e = enterLabel(plan, step.next);
    if (!e.ok) return { kind: 'fail', reason: e.reason };
    if (!e.label) return { kind: 'plan_done', reason: 'steps_exhausted' };
    plan.stepResults.push({ as: step.as, ok: true, at: new Date().toISOString() });
    return { kind: 'advance', label: e.label };
  }

  // 失败：先看配方自己的分支
  const mapped = step.onFail?.[failKind];
  if (mapped === 'report' || mapped === 'halt') {
    plan.stepResults.push({ as: step.as, ok: false, kind: failKind, at: new Date().toISOString() });
    return { kind: 'report', escalate: plan.recipeId === 'feed' ? 'starving' : 'plan_failed', reason: failKind };
  }
  if (mapped && mapped !== 'retry') {
    const e = enterLabel(plan, mapped);
    if (!e.ok) return { kind: 'fail', reason: e.reason };
    plan.stepResults.push({ as: step.as, ok: false, kind: failKind, at: new Date().toISOString() });
    if (!e.label) return { kind: 'plan_done', reason: 'steps_exhausted' };
    return { kind: 'advance', label: e.label };
  }

  const recovery = mapped === 'retry' ? 'retry' : DEFAULT_RECOVERY[failKind] || 'retry_once';
  if (recovery === 'suspend') {
    return { kind: 'suspend', by: failKind };
  }
  if (recovery === 'retry' || recovery === 'retry_once') {
    const e = enterLabel(plan, step.as); // 同一标签再进一次，受 maxVisits 限制
    if (e.ok) {
      plan.stepResults.push({ as: step.as, ok: false, kind: failKind, at: new Date().toISOString() });
      return { kind: 'retry', label: step.as };
    }
    return { kind: 'fail', reason: `retry_exhausted:${failKind}` };
  }
  return { kind: 'fail', reason: failKind };
}

export function suspendPlan(plan, by) {
  if (!plan || plan.status !== PlanStatus.ACTIVE) return false;
  plan.status = PlanStatus.SUSPENDED;
  plan.suspendedBy = String(by || 'unknown');
  plan.suspendedAt = new Date().toISOString();
  return true;
}

export function resumePlan(plan) {
  if (!plan || plan.status !== PlanStatus.SUSPENDED) return false;
  plan.status = PlanStatus.ACTIVE;
  plan.suspendedBy = null;
  plan.suspendedAt = null;
  return true;
}

export function finishPlan(plan, status, reason) {
  if (!plan) return null;
  plan.status = status;
  plan.endedAt = new Date().toISOString();
  plan.lastError = reason ?? plan.lastError ?? null;
  return plan;
}

/** 计划是不是"还在跑"（active/suspended 都算，占着同伴）。 */
export function planAlive(plan) {
  return !!plan && (plan.status === PlanStatus.ACTIVE || plan.status === PlanStatus.SUSPENDED);
}

/** 给树状态/日志用的精简视图。 */
export function planView(plan) {
  if (!plan) return null;
  const { index, total } = stepIndex(plan);
  return {
    id: plan.id,
    recipeId: plan.recipeId,
    title: plan.title,
    intent: plan.intent,
    source: plan.source,
    status: plan.status,
    cursor: plan.cursor,
    steps_done: index,
    steps_total: total,
    suspendedBy: plan.suspendedBy,
    gateReason: plan.gateReason ?? null,
    gateMode: plan.gateMode ?? null,
    visits: plan.visits,
    startedAt: plan.startedAt,
    deadlineAt: plan.deadlineAt,
    lastError: plan.lastError,
  };
}

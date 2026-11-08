/**
 * treeview 模型构建（树无关 core 的 numen-tree adapter 部分）。
 *
 * 只读：直接 import 树的定义模块（recipes/interrupts/schedule/crafttree/skills），
 * 不写任何树状态、不启动树进程。核心数据结构是一张图：
 *   nodes: {id,type,label,title,desc,params,meta,recipeId,stepIndex,skill,priority,...}
 *   edges: {from,to,type,label}
 * 前端只依赖这份 JSON（换别的游戏/树 = 换 adapter，不改 core）。
 */

export const ADAPTER = 'numen-tree';

const NODE_TYPES = ['recipe', 'step', 'skill', 'interrupt', 'schedule', 'craft', 'port', 'core'];

function safeJson(v, max = 240) {
  try {
    const s = JSON.stringify(v ?? null);
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  } catch {
    return String(v);
  }
}

function stepDesc(step) {
  const bits = [];
  bits.push(`技能: ${step.skill}`);
  if (step.params && Object.keys(step.params).length) bits.push(`参数: ${safeJson(step.params)}`);
  if (step.next) bits.push(`next: ${safeJson(step.next)}`);
  if (step.onFail && Object.keys(step.onFail).length) bits.push(`onFail: ${safeJson(step.onFail)}`);
  if (step.requires) bits.push(`requires: ${safeJson(step.requires)}`);
  if (step.maxVisits) bits.push(`maxVisits: ${step.maxVisits}`);
  if (step.escalate) bits.push(`escalate: ${safeJson(step.escalate)}`);
  if (step.match) bits.push(`match: ${safeJson(step.match)}`);
  return bits.join(' · ');
}

/** 动态 import（每次带时间戳，保证"改了树 → treeview 重新读到的就是新定义"）。 */
async function loadTreeDefs() {
  const t = Date.now();
  const recipesMod = await import(`../../src/recipes.mjs?tv=${t}`);
  const interruptsMod = await import(`../../src/interrupts.mjs?tv=${t}`);
  const scheduleMod = await import(`../../src/schedule.mjs?tv=${t}`);
  const craftMod = await import(`../../src/crafttree.mjs?tv=${t}`);
  const skillsMod = await import(`../../src/skills/index.mjs?tv=${t}`);
  await skillsMod.loadSkills({ bust: true });
  return {
    recipes: recipesMod.RECIPES,
    interrupts: interruptsMod.INTERRUPTS,
    schedules: scheduleMod.SCHEDULES,
    offSegment: scheduleMod.OFF_SEGMENT,
    craftTree: craftMod.CRAFT_TREE,
    skills: skillsMod.listSkills(),
    modelVersionOnline: Number(recipesMod.RECIPES?.length ?? 0),
  };
}

/** 目标引用（next/onFail 的值）可能是字符串、数组、{kind:'as'}、或 {step:{...}}。 */
function collectTargets(ref, out = []) {
  if (!ref) return out;
  if (typeof ref === 'string') {
    out.push(ref);
    return out;
  }
  if (Array.isArray(ref)) {
    for (const x of ref) collectTargets(x, out);
    return out;
  }
  if (typeof ref === 'object') {
    if (ref.as) out.push(ref.as);
    for (const [k, v] of Object.entries(ref)) {
      if (k === 'as') continue;
      // onFail: { no_path: 'target', ... } 的值才是目标
      collectTargets(v, out);
    }
  }
  return out;
}

export async function buildModel() {
  const defs = await loadTreeDefs();
  const nodes = [];
  const edges = [];
  const push = (n) => {
    nodes.push(n);
    return n;
  };
  const edge = (from, to, type, label) => {
    if (from && to) edges.push({ from, to, type, label: label ?? type });
  };

  // ── 技能节点 ────────────────────────────────────────────────
  const skillIds = new Set();
  for (const s of defs.skills) {
    const id = `k:${s.id}`;
    skillIds.add(s.id);
    push({
      id,
      type: 'skill',
      label: s.id,
      title: s.title ?? s.id,
      desc: [s.title, `参数: ${safeJson(s.params ?? {})}`, s.meta?.gives ? `gives: ${safeJson(s.meta.gives)}` : '']
        .filter(Boolean)
        .join(' · '),
      params: s.params ?? {},
      meta: s.meta ?? {},
    });
  }

  // ── 配方 / 步骤节点 ─────────────────────────────────────────
  const recipeIndexById = new Map();
  const stepNodesByRecipe = new Map(); // recipeId -> Map(as -> nodeId)
  defs.recipes.forEach((r, ri) => {
    recipeIndexById.set(r.id, ri);
    const rid = `r:${r.id}`;
    push({
      id: rid,
      type: 'recipe',
      label: r.id,
      title: r.title ?? r.id,
      desc: [`source: ${r.source ?? 'llm'}`, r.match ? `match: ${safeJson(r.match)}` : ''].filter(Boolean).join(' · '),
      recipeId: r.id,
      source: r.source ?? 'llm',
      order: ri,
      steps: (r.steps ?? []).length,
    });
    const stepMap = new Map();
    stepNodesByRecipe.set(r.id, stepMap);
    (r.steps ?? []).forEach((step, si) => {
      const as = step.as ?? `step${si}`;
      const sid = `r:${r.id}:step:${as}`;
      stepMap.set(as, sid);
      push({
        id: sid,
        type: 'step',
        label: as,
        title: `${r.id} / ${as}`,
        desc: stepDesc(step),
        recipeId: r.id,
        stepIndex: si,
        stepsTotal: (r.steps ?? []).length,
        skill: step.skill,
        params: step.params ?? {},
        next: step.next ?? null,
        onFail: step.onFail ?? null,
        requires: step.requires ?? null,
        escalate: step.escalate ?? null,
        maxVisits: step.maxVisits ?? null,
      });
      edge(rid, sid, 'step', `#${si + 1}`);
      if (step.skill && skillIds.has(step.skill)) edge(sid, `k:${step.skill}`, 'uses');
    });
    // 步骤间边：next + onFail + match 里的跳转目标
    (r.steps ?? []).forEach((step, si) => {
      const as = step.as ?? `step${si}`;
      const sid = `r:${r.id}:step:${as}`;
      const targets = new Set();
      for (const t of collectTargets(step.next)) targets.add(`next:${t}`);
      for (const t of collectTargets(step.onFail)) targets.add(`onFail:${t}`);
      for (const t of collectTargets(step.match)) targets.add(`match:${t}`);
      for (const tagged of targets) {
        const [kind, toAs] = tagged.split(':');
        const toSid = stepMap.get(toAs);
        if (toSid) edge(sid, toSid, kind);
      }
    });
    // 配方末步：recipe.meta.report? 不需要额外边
  });

  // ── 中断节点 ────────────────────────────────────────────────
  defs.interrupts.forEach((it, i) => {
    const iid = `i:${it.id}`;
    push({
      id: iid,
      type: 'interrupt',
      label: it.id,
      title: it.id,
      desc: [
        `priority: ${it.priority ?? '?'}`,
        it.resume ? `resume: ${it.resume}` : '',
        it.halt ? 'halt: true' : '',
        it.goal ? `goal: ${it.goal.skill}` : '',
        it.plan ? `plan: ${it.plan}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      priority: it.priority ?? 0,
      order: i,
      resume: it.resume ?? null,
      halt: !!it.halt,
    });
    if (it.goal?.skill && skillIds.has(it.goal.skill)) edge(iid, `k:${it.goal.skill}`, 'interrupt');
    if (it.plan) edge(iid, `r:${it.plan}`, 'interrupt_plan');
  });

  // ── 日程节点 ────────────────────────────────────────────────
  defs.schedules.forEach((s, i) => {
    const sid = `sc:${s.id}`;
    push({
      id: sid,
      type: 'schedule',
      label: s.id,
      title: s.title ?? s.id,
      desc: [
        s.leash ? `leash: ${safeJson(s.leash)}` : 'leash: null',
        s.allow ? `allow: ${safeJson(s.allow)}` : '',
        s.work?.length ? `work: ${safeJson(s.work)}` : '',
        s.guard?.enabled ? 'guard: on' : '',
        s.patrol?.enabled ? 'patrol: on' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      order: i,
      leash: s.leash ?? null,
      allow: s.allow ?? null,
      work: s.work ?? [],
      guard: s.guard ?? null,
      patrol: s.patrol ?? null,
    });
    for (const w of s.work ?? []) {
      if (w.recipe) edge(sid, `r:${w.recipe}`, 'schedule_work', w.key ?? 'work');
    }
    if (s.guard?.enabled && s.guard.skill && skillIds.has(s.guard.skill)) edge(sid, `k:${s.guard.skill}`, 'schedule_skill', 'guard');
    if (s.patrol?.enabled) edge(sid, `k:go_to`, 'schedule_skill', 'patrol');
  });

  // ── 合成树节点（独立子图）────────────────────────────────────
  const craftIds = new Map();
  for (const [item, rec] of Object.entries(defs.craftTree ?? {})) {
    const cid = `c:${item}`;
    craftIds.set(item, cid);
    push({
      id: cid,
      type: 'craft',
      label: item.replace(/^minecraft:/, ''),
      title: item.replace(/^minecraft:/, ''),
      desc: [`yields: ${rec.yields ?? 1}`, rec.table ? 'table: 需要工作台' : '', rec.needs ? `needs: ${safeJson(rec.needs)}` : '']
        .filter(Boolean)
        .join(' · '),
      item,
      yields: rec.yields ?? 1,
      table: !!rec.table,
    });
  }
  for (const [item, rec] of Object.entries(defs.craftTree ?? {})) {
    for (const need of rec.needs ?? []) {
      if (need.item && craftIds.has(need.item)) {
        edge(`c:${item}`, craftIds.get(need.item), 'craft', 'needs');
      } else if (need.kind === 'stick' && craftIds.has('minecraft:stick')) {
        edge(`c:${item}`, craftIds.get('minecraft:stick'), 'craft', 'needs');
      } else if (need.kind === 'any_planks') {
        for (const [pi, pid] of craftIds) {
          if (pi.endsWith('_planks')) edge(`c:${item}`, pid, 'craft', 'needs');
        }
      }
    }
  }

  // ── 边界端口 + 核心链路（让"两头端点"在图上可见）─────────────
  // 这些是架构常量（不属于取数模块），在 numen-tree adapter 里补：
  //   入口：tree MCP 8767（LLM）、control API 8766（外部控制）
  //   出口/入口：numen MCP 8765（执行 lua/技能；同时接收观测/事件）
  const CORE_NODES = [
    {
      id: 'port:tree_mcp',
      type: 'port',
      label: 'tree MCP 8767',
      title: 'LLM 输入口（tree MCP）',
      desc: '大脑 → 树：tree_task/tree_goal 下目标、tree_control 控制；树 → 大脑：tree_inbox/tree_wait 上报（双向口）',
    },
    {
      id: 'port:control',
      type: 'port',
      label: 'control 8766',
      title: '控制 API（HTTP）',
      desc: 'CLI / 外部脚本 → 树：/status、/goal、/task、/control、/lock（只读+控制）',
    },
    {
      id: 'port:numen',
      type: 'port',
      label: 'numen MCP 8765',
      title: '游戏输出/观测口（numen MCP）',
      desc: '树 → 游戏：lua/skill 动作（执行器）；游戏 → 树：观测/事件（观察者）。同一个 MCP 的两向出入口',
    },
    { id: 'core:lane', type: 'core', label: 'lane 主循环', title: 'lane 主循环', desc: '每 tick：中断检查 → 目标执行 → 计划推进 → 仲裁/牵引/待命' },
    { id: 'core:planner', type: 'core', label: 'planner', title: '计划器（配方→步骤）', desc: 'tree_task 意图匹配配方，按步骤分片下发' },
    { id: 'core:arbiter', type: 'core', label: 'arbiter', title: '仲裁器（日程→自动行为）', desc: '空闲时按日程表决定 feed/guard/patrol/dayWork' },
    { id: 'core:executor', type: 'core', label: 'executor', title: '执行器（技能→lua）', desc: '把技能卡编译成 Lua 程序，交给 numen 执行；处理 partial/remaining' },
    { id: 'core:observer', type: 'core', label: 'observer', title: '观察者（状态/事件）', desc: 'numen 观测 + 事件 → Blackboard/状态，供仲裁与中断使用' },
  ];
  for (const n of CORE_NODES) push(n);

  edge('port:tree_mcp', 'core:planner', 'port_in', 'tree_task');
  edge('port:tree_mcp', 'core:lane', 'port_in', 'tree_goal/control');
  edge('core:lane', 'port:tree_mcp', 'port_out', '上报/收件箱');
  edge('port:control', 'core:lane', 'port_in', 'status/goal/control');
  edge('core:lane', 'core:planner', 'core', '计划推进');
  edge('core:lane', 'core:arbiter', 'core', '空闲仲裁');
  edge('core:lane', 'core:executor', 'core', '派发动作');
  edge('core:lane', 'core:observer', 'core', '取状态');
  edge('core:observer', 'core:lane', 'core', '观测→状态');
  edge('core:planner', 'core:executor', 'core', '步骤→技能');
  for (const r of defs.recipes) edge('core:planner', `r:${r.id}`, 'plans', r.id);
  for (const it of defs.interrupts) edge('core:lane', `i:${it.id}`, 'interrupt_check', '每 tick 检查');
  for (const s of defs.schedules) edge('core:arbiter', `sc:${s.id}`, 'schedule');
  for (const sk of defs.skills) edge('core:executor', `k:${sk.id}`, 'exec');
  edge('core:executor', 'port:numen', 'port_out', 'lua/技能动作');
  edge('port:numen', 'core:observer', 'port_in', '观测/事件');

  return {
    adapter: ADAPTER,
    generatedAt: new Date().toISOString(),
    counts: {
      recipes: defs.recipes.length,
      steps: nodes.filter((n) => n.type === 'step').length,
      skills: defs.skills.length,
      interrupts: defs.interrupts.length,
      schedules: defs.schedules.length,
      craft: Object.keys(defs.craftTree ?? {}).length,
      nodes: nodes.length,
      edges: edges.length,
    },
    nodeTypes: NODE_TYPES,
    recipes: defs.recipes.map((r) => ({ id: r.id, title: r.title, source: r.source, match: r.match ?? [] })),
    nodes,
    edges,
  };
}

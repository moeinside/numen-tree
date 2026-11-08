/**
 * 战术包（数据 + op 语义）。见 docs/19。
 *
 * 战术包 = 原子动作序列 + 最小控制 op（atom/call/if/retry/until/set）：
 *  - 数据可离线测试、可读；
 *  - 不写任意 JS/Lua 表达式；条件也是 op 树；
 *  - 所有循环都有 maxRounds；预算/熔断由 runner 统一兜底。
 */

export const TACTICS = {
  move_segment: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.move_segment',
    title: '移动到目标附近（一段一段走）',
    priorityClass: 'P3',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 24, maxSeconds: 20, maxTries: 2 },
    params: { target: 'Pos', arrive: 'number=4' },
    steps: [
      {
        op: 'until',
        maxRounds: 8,
        cond: { op: 'le', of: '$last.distance', to: '$arrive' },
        steps: [
          { op: 'atom', atom: 'atom.move_segment', params: { target: '$target', arrive: '$arrive' }, as: 'mv' },
        ],
      },
    ],
    success: { op: 'le', of: '$last.distance', to: '$arrive' },
    notes: '一次 move.to 一小段；no_path 时由上层决定 backoff/换目标',
  },

  dig_one: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.dig_one',
    title: '挖一格并尽量捡起',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 8, maxSeconds: 20, maxTries: 1 },
    params: { cell: 'Pos' },
    steps: [
      { op: 'atom', atom: 'atom.scan_block', params: { cell: '$cell' }, as: 'scan' },
      {
        op: 'if',
        cond: { op: 'field', of: '$vars.scan', field: 'air' },
        then: [{ op: 'set', vars: { dig: { air: true, block: '$vars.scan.name', delta: 0 } } }],
        else: [
          {
            op: 'if',
            cond: { op: 'not', of: { op: 'field', of: '$vars.scan', field: 'in_reach' } },
            then: [{ op: 'atom', atom: 'atom.move_segment', params: { target: '$cell', arrive: 3 }, as: 'mv' }],
          },
          { op: 'atom', atom: 'atom.dig_one', params: { cell: '$cell' }, as: 'dig' },
          { op: 'atom', atom: 'atom.collect_near', params: { radius: 4 }, as: 'col' },
        ],
      },
    ],
    success: { op: 'field', of: '$vars.dig', field: 'air' },
    notes: '先看再挖；不在 reach 就先贴近；挖完小半径捡；方块本来空气=已完成',
  },

  eat_one: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.eat_one',
    title: '吃一口（P0）',
    priorityClass: 'P0',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 6, maxTries: 1 },
    params: { item: 'string' },
    steps: [{ op: 'atom', atom: 'atom.eat_one', params: { item: '$item' }, as: 'eat' }],
    success: { op: 'gt', of: '$vars.eat.hunger_after', to: '$vars.eat.hunger_before' },
    notes: '快、硬抢占；无食物时由上层决定找食物或上报',
  },

  survive_eat: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.survive_eat',
    title: '生存：从背包选食物吃掉（P0）',
    priorityClass: 'P0',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 6, maxTries: 1 },
    params: {},
    steps: [{ op: 'atom', atom: 'atom.eat_best', as: 'eat' }],
    success: { op: 'gt', of: '$vars.eat.hunger_after', to: '$vars.eat.hunger_before' },
    notes: '无食物时原子返回 no_food，由上层决定找食物/上报',
  },

  survive_flee: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.survive_flee',
    title: '生存：逃离最近的敌对（P0）',
    priorityClass: 'P0',
    owner: 'tree',
    preempt: 'hard',
    deprecated: true, // 本能反射已覆盖，禁止自主调度；仅显式调用
    budget: { maxAtoms: 8, maxSeconds: 12, maxTries: 1 },
    params: { distance: 'number=12' },
    steps: [
      { op: 'atom', atom: 'atom.scan_entities', params: { type: 'hostile', radius: 16 }, as: 'scan' },
      {
        op: 'if',
        cond: { op: 'gt', of: '$vars.scan.count', to: 0 },
        then: [
          {
            op: 'until',
            maxRounds: 3,
            cond: {
              op: 'or',
              of: [
                { op: 'eq', of: '$vars.scan.count', to: 0 },
                { op: 'ge', of: '$vars.scan.distance', to: '$distance' },
              ],
            },
            steps: [
              {
                op: 'atom',
                atom: 'atom.move_flee',
                params: {
                  from: { x: '$vars.scan.x', y: '$vars.scan.y', z: '$vars.scan.z' },
                  distance: '$distance',
                },
                as: 'flee',
              },
              { op: 'atom', atom: 'atom.scan_entities', params: { type: 'hostile', radius: 16 }, as: 'scan' },
            ],
          },
        ],
      },
    ],
    success: {
      op: 'or',
      of: [
        { op: 'eq', of: '$vars.scan.count', to: 0 },
        { op: 'ge', of: '$vars.scan.distance', to: '$distance' },
      ],
    },
    notes: '没有敌对时直接成功；move.flee 失败→no_path，交给上层重试/脱困',
  },

  survive_fight: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.survive_fight',
    title: '生存：换武器并攻击最近的敌对（P0）',
    priorityClass: 'P0',
    owner: 'tree',
    preempt: 'hard',
    deprecated: true, // 本能反射已覆盖，禁止自主调度；仅显式调用
    budget: { maxAtoms: 18, maxSeconds: 25, maxTries: 1 },
    params: { radius: 'number=16' },
    steps: [
      { op: 'atom', atom: 'atom.scan_entities', params: { type: 'hostile', radius: '$radius' }, as: 'scan' },
      {
        op: 'if',
        cond: { op: 'gt', of: '$vars.scan.count', to: 0 },
        then: [
          { op: 'atom', atom: 'atom.equip_best_weapon', as: 'weapon' },
          // 必须近身：use.hit 不移动，超出攻击距离会失败 → 先走到 3 格内
          {
            op: 'if',
            cond: { op: 'gt', of: '$vars.scan.distance', to: 3 },
            then: [
              {
                op: 'until',
                maxRounds: 3,
                cond: { op: 'le', of: '$vars.scan.distance', to: 3 },
                steps: [
                  {
                    op: 'atom',
                    atom: 'atom.move_segment',
                    params: { target: { x: '$vars.scan.x', y: '$vars.scan.y', z: '$vars.scan.z' }, arrive: 2 },
                    as: 'mv',
                  },
                  { op: 'atom', atom: 'atom.scan_entities', params: { type: 'hostile', radius: '$radius' }, as: 'scan' },
                ],
              },
            ],
          },
          { op: 'set', vars: { targetId: '$vars.scan.id' } },
          {
            op: 'until',
            maxRounds: 6,
            cond: {
              op: 'or',
              of: [
                { op: 'eq', of: '$vars.scan.count', to: 0 },
                { op: 'ne', of: '$vars.scan.id', to: '$vars.targetId' },
              ],
            },
            steps: [
              { op: 'atom', atom: 'atom.swing_once', params: { entityId: '$vars.targetId' }, as: 'hit' },
              { op: 'atom', atom: 'atom.scan_entities', params: { type: 'hostile', radius: '$radius' }, as: 'scan' },
            ],
          },
        ],
      },
    ],
    success: {
      op: 'or',
      of: [
        { op: 'eq', of: '$vars.scan.count', to: 0 },
        { op: 'ne', of: '$vars.scan.id', to: '$vars.targetId' },
      ],
    },
    notes: '没有敌对=成功；用 use.hit 单次攻击（不移动），所以先走近到 3 格内；最多 6 次挥击',
  },

  survive_unstick: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.survive_unstick',
    title: '生存：脱困（向四个方向挪一段）',
    priorityClass: 'P0',
    owner: 'tree',
    preempt: 'hard',
    deprecated: true, // 本能反射已覆盖，禁止自主调度；仅显式调用
    budget: { maxAtoms: 4, maxSeconds: 12, maxTries: 1 },
    params: {},
    steps: [{ op: 'retry', maxTries: 2, steps: [{ op: 'atom', atom: 'atom.try_step', as: 'step' }] }],
    success: { op: 'gt', of: '$vars.step.moved', to: 0.5 },
    notes: 'MVP：只挪动，不挖墙；挖遮挡留给后面 Batch B',
  },

  attack_target: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.attack_target',
    title: '攻击指定实体（use.hit 单次挥击循环）',
    priorityClass: 'P1',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 14, maxSeconds: 20, maxTries: 1 },
    params: { entityId: 'number', radius: 'number=16' },
    steps: [
      { op: 'atom', atom: 'atom.scan_entity_id', params: { entityId: '$entityId', radius: '$radius' }, as: 't' },
      {
        op: 'if',
        cond: { op: 'field', of: '$vars.t', field: 'present' },
        then: [
          { op: 'atom', atom: 'atom.equip_best_weapon', as: 'weapon' },
          {
            op: 'if',
            cond: { op: 'gt', of: '$vars.t.distance', to: 3 },
            then: [
              {
                op: 'until',
                maxRounds: 3,
                cond: { op: 'le', of: '$vars.t.distance', to: 3 },
                steps: [
                  {
                    op: 'atom',
                    atom: 'atom.move_segment',
                    params: { target: { x: '$vars.t.x', y: '$vars.t.y', z: '$vars.t.z' }, arrive: 2 },
                    as: 'mv',
                  },
                  { op: 'atom', atom: 'atom.scan_entity_id', params: { entityId: '$entityId', radius: '$radius' }, as: 't' },
                ],
              },
            ],
          },
          {
            op: 'until',
            maxRounds: 8,
            cond: { op: 'eq', of: '$vars.t.present', to: false },
            steps: [
              { op: 'atom', atom: 'atom.swing_once', params: { entityId: '$entityId' }, as: 'hit' },
              { op: 'atom', atom: 'atom.scan_entity_id', params: { entityId: '$entityId', radius: '$radius' }, as: 't' },
            ],
          },
        ],
      },
    ],
    success: { op: 'eq', of: '$vars.t.present', to: false },
    notes: '指定目标版战斗：scan_entity_id→(远则走近)→use.hit 循环→目标消失=成功；最多 8 刀',
  },

  settle: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.settle',
    title: '急刹后 settle（停任务+观测+位置确认）',
    priorityClass: 'P0',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 1, maxSeconds: 5, maxTries: 1 },
    params: {},
    steps: [{ op: 'atom', atom: 'atom.settle', as: 's' }],
    success: { op: 'field', of: '$vars.s', field: 'ok' },
    notes: '任何 hard preempt 之后必须先跑它，再派下一个原子',
  },
};

export function getTactic(id) {
  return TACTICS[id] ?? TACTICS[String(id).replace(/^tactic\./, '')] ?? null;
}

function readPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 值引用：'$target' / '$vars.scan' / '$last.distance' / 字面量。 */
export function resolveValue(v, ctx) {
  if (typeof v === 'string' && v.startsWith('$')) {
    const path = v.slice(1).split('.');
    const base = path[0];
    const rest = path.slice(1);
    if (base === 'last') return readPath(ctx.last, rest);
    if (base === 'vars') return readPath(ctx.vars, rest);
    return readPath(ctx.params, path); // 参数
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, ctx));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, vv] of Object.entries(v)) out[k] = resolveValue(vv, ctx);
    return out;
  }
  return v;
}

/** 条件 op 树求值（不 eval 任意代码）。 */
export function evalCondition(cond, ctx) {
  if (cond == null) return true;
  if (typeof cond === 'boolean') return cond;
  if (typeof cond !== 'object') return !!cond;
  const val = (ref) => resolveValue(ref, ctx);
  switch (cond.op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'eq':
      return val(cond.of) === val(cond.to);
    case 'ne':
      return val(cond.of) !== val(cond.to);
    case 'lt':
      return Number(val(cond.of)) < Number(val(cond.to));
    case 'le':
      return Number(val(cond.of)) <= Number(val(cond.to));
    case 'gt':
      return Number(val(cond.of)) > Number(val(cond.to));
    case 'ge':
      return Number(val(cond.of)) >= Number(val(cond.to));
    case 'field': {
      const o = val(cond.of);
      const got = o == null ? undefined : o[cond.field];
      return cond.eq !== undefined ? got === cond.eq : !!got;
    }
    case 'exists':
      return val(cond.of) !== undefined && val(cond.of) !== null;
    case 'not':
      return !evalCondition(cond.of, ctx);
    case 'and':
      return (cond.of ?? []).every((c) => evalCondition(c, ctx));
    case 'or':
      return (cond.of ?? []).some((c) => evalCondition(c, ctx));
    default:
      throw new Error(`未知条件 op：${cond.op}`);
  }
}

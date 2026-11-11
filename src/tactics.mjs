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

  hold_item: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.hold_item',
    title: '手持指定物品（钓竿/工具）',
    priorityClass: 'P2',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 2, maxSeconds: 5, maxTries: 1 },
    params: { item: 'string' },
    steps: [{ op: 'atom', atom: 'atom.hold_item', params: { item: '$item' }, as: 'hold' }],
    success: { op: 'field', of: '$vars.hold', field: 'held' },
    notes: '用于钓竿等非武器手持物；战斗仍用 equip_best',
  },

  find_entity: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.find_entity',
    title: '找最近的某类实体（被动/敌对/掉落）',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 1, maxSeconds: 4, maxTries: 1 },
    params: { type: 'string=passive', radius: 'number=24' },
    steps: [{ op: 'atom', atom: 'atom.scan_entities', params: { type: '$type', radius: '$radius' }, as: 'scan' }],
    success: { op: 'gt', of: '$vars.scan.count', to: 0 },
    notes: '只读；成功时 vars.scan 带 id/type/x/y/z/distance',
  },

  try_step: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.try_step',
    title: '原地尝试走/跳一步（脱困用）',
    priorityClass: 'P0',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 4, maxSeconds: 12, maxTries: 1 },
    params: {},
    steps: [{ op: 'retry', maxTries: 2, steps: [{ op: 'atom', atom: 'atom.try_step', as: 'step' }] }],
    success: { op: 'gt', of: '$vars.step.moved', to: 0.5 },
    notes: '只挪动一步，不挖墙；脱困失败由上层换方向/挖',
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

  query_recipes: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.query_recipes',
    title: '只读：查某物品配方',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 2, maxSeconds: 5, maxTries: 1 },
    params: { item: 'string', limit: 'number=6' },
    steps: [{ op: 'atom', atom: 'atom.recipe_query', params: { item: '$item', limit: '$limit' }, as: 'q' }],
    success: { op: 'gt', of: '$vars.q.count', to: 0 },
    notes: '只读；vars.q.recipes_json 是配方数组（JSON 字符串），recipe_id/station 是第一条',
  },

  query_craftable: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.query_craftable',
    title: '只读：查当前能做什么',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 2, maxSeconds: 5, maxTries: 1 },
    params: { limit: 'number=8' },
    steps: [{ op: 'atom', atom: 'atom.craftable_query', params: { limit: '$limit' }, as: 'c' }],
    success: { op: 'gt', of: '$vars.c.count', to: 0 },
    notes: '只读；无材料可做时返回 not_success（不是错误）',
  },

  count_items: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.count_items',
    title: '只读：数背包某物品',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 2, maxSeconds: 4, maxTries: 1 },
    params: { item: 'string' },
    steps: [{ op: 'atom', atom: 'atom.count_items', params: { item: '$item' }, as: 'n' }],
    success: { op: 'exists', of: '$vars.n.count' },
    notes: '只读；vars.n.count 是数量（0 也算成功查询）',
  },

  locate_station: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.locate_station',
    title: '只读：找最近的工作站',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 2, maxSeconds: 5, maxTries: 1 },
    params: { block: 'string=minecraft:crafting_table', radius: 'number=24' },
    steps: [
      { op: 'atom', atom: 'atom.locate_station', params: { block: '$block', radius: '$radius' }, as: 's' },
    ],
    success: { op: 'field', of: '$vars.s', field: 'found' },
    notes: '只读；找到返回 x/y/z/distance，找不到 not_success',
  },

  open_station: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.open_station',
    title: '单步：右键打开工作站/容器',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 6, maxTries: 1 },
    params: { cell: 'Pos' },
    steps: [{ op: 'atom', atom: 'atom.open_station', params: { cell: '$cell' }, as: 'w' }],
    success: { op: 'field', of: '$vars.w', field: 'opened' },
    notes: '打开 3×3 合成台/熔炉/箱子；不走路（需先 move_segment 到旁边）',
  },

  craft_batch: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.craft_batch',
    title: '单步：在已开合成格做一批',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 8, maxTries: 1 },
    params: { recipe: 'string', count: 'number=1' },
    steps: [
      { op: 'atom', atom: 'atom.craft_batch', params: { recipe: '$recipe', count: '$count' }, as: 'c' },
    ],
    success: { op: 'gt', of: '$vars.c.crafted', to: 0 },
    notes: '配方由战略层选定（inv.recipes）；材料不足返回 no_material；more=true 表示还能再做',
  },

  store_batch: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.store_batch',
    title: '单步：存物品进容器',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 14, maxTries: 1 },
    params: { cell: 'Pos', item: 'string', count: 'number' },
    steps: [
      {
        op: 'atom',
        atom: 'atom.store_batch',
        params: { cell: '$cell', item: '$item', count: '$count' },
        as: 's',
      },
    ],
    success: { op: 'gt', of: '$vars.s.moved', to: 0 },
    notes: '会自己走到容器；count 省略=全存',
  },

  fetch_batch: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.fetch_batch',
    title: '单步：从容器取物品',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 14, maxTries: 1 },
    params: { cell: 'Pos', item: 'string', count: 'number' },
    steps: [
      {
        op: 'atom',
        atom: 'atom.fetch_batch',
        params: { cell: '$cell', item: '$item', count: '$count' },
        as: 'f',
      },
    ],
    success: { op: 'gt', of: '$vars.f.moved', to: 0 },
    notes: '会自己走到容器；count 省略=全取',
  },

  smelt_batch: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.smelt_batch',
    title: '长动作：熔炼一批（有界，超时走急刹+settle）',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 20, maxTries: 1 },
    params: { cell: 'Pos', item: 'string', count: 'number=1', fuel: 'string', timeout: 'number=10' },
    steps: [
      {
        op: 'atom',
        atom: 'atom.smelt_batch',
        params: { cell: '$cell', item: '$item', count: '$count', fuel: '$fuel', timeout: '$timeout' },
        as: 'm',
      },
    ],
    success: { op: 'gt', of: '$vars.m.took', to: 0 },
    notes: 'inv.smelt 自己走到炉子/放料/等待/取出；单次受 timeout 限制，超时由 lane 急刹+settle',
  },

  collect_drops: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.collect_drops',
    title: '单步：捡附近掉落物（有界半径）',
    priorityClass: 'P3',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 10, maxTries: 1 },
    params: { radius: 'number=6' },
    steps: [{ op: 'atom', atom: 'atom.collect_near', params: { radius: '$radius' }, as: 'd' }],
    success: { op: 'gt', of: '$vars.d.count', to: 0 },
    notes: '死亡点捡装备/战斗后捡掉落；没东西时 not_success',
  },

  equip_best: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.equip_best',
    title: '单步：换最好的武器（没有则 not_success）',
    priorityClass: 'P2',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 4, maxTries: 1 },
    params: {},
    steps: [{ op: 'atom', atom: 'atom.equip_best_weapon', as: 'w' }],
    success: { op: 'field', of: '$vars.w', field: 'held' },
    notes: '空手也返回 ok，但无武器时 not_success；供 get_weapon 验收用',
  },

  scan_container: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.scan_container',
    title: '只读：查看容器内容（箱子/熔炉）',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    budget: { maxAtoms: 2, maxSeconds: 4, maxTries: 1 },
    params: { cell: 'Pos' },
    steps: [{ op: 'atom', atom: 'atom.scan_container', params: { cell: '$cell' }, as: 'c' }],
    success: { op: 'exists', of: '$vars.c.count' },
    notes: '返回 slot1..slot12 文本；空容器 count=0 也算成功查询',
  },

  place_one: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.place_one',
    title: '单步：放一个方块',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 8, maxTries: 1 },
    params: { cell: 'Pos', block: 'string' },
    steps: [
      { op: 'atom', atom: 'atom.place_one', params: { cell: '$cell', block: '$block' }, as: 'p' },
    ],
    success: { op: 'gt', of: '$vars.p.placed', to: 0 },
    notes: '需要背包里有对应方块；不走路，需先站到可放置距离',
  },

  dig_cluster: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.dig_cluster',
    title: '单步：挖/砍一小簇（有界）',
    priorityClass: 'P3',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 18, maxTries: 1 },
    params: { block: 'string', radius: 'number=16', count: 'number=4' },
    steps: [
      {
        op: 'atom',
        atom: 'atom.dig_cluster',
        params: { block: '$block', radius: '$radius', count: '$count' },
        as: 'd',
      },
    ],
    success: { op: 'gt', of: '$vars.d.dug', to: 0 },
    notes: '已知方块 id（原木/石头）；砍完顺手 collect 半径 4',
  },

  sleep_once: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.sleep_once',
    title: '单步：睡床到天亮',
    priorityClass: 'P3',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 2, maxSeconds: 4, maxTries: 1 },
    params: { cell: 'Pos' },
    steps: [{ op: 'atom', atom: 'atom.sleep_once', params: { cell: '$cell' }, as: 's' }],
    success: { op: 'field', of: '$vars.s', field: 'slept' },
    notes: '不走路：需先到床边；白天睡会失败（返回原因）',
  },

  check_standable: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.check_standable',
    title: '检查目标点是否可站立',
    priorityClass: 'P4',
    owner: 'tree',
    preempt: 'soft',
    params: { cell: 'Pos' },
    budget: { maxAtoms: 1, maxSeconds: 3, maxTries: 1 },
    steps: [{ op: 'atom', atom: 'atom.check_standable', params: { cell: '$cell' }, as: 's' }],
    success: { op: 'field', of: '$vars.s', field: 'standable' },
  },

  travel_to: {
    schemaVersion: 1,
    kind: 'tactic',
    id: 'tactic.travel_to',
    title: '分片移动：一段一段走到目标附近',
    priorityClass: 'P3',
    owner: 'tree',
    preempt: 'hard',
    budget: { maxAtoms: 10, maxSeconds: 20, maxTries: 1 },
    params: { target: 'Pos', arrive: 'number=2' },
    steps: [
      {
        op: 'until',
        maxRounds: 8,
        cond: { op: 'le', of: '$vars.mv.distance', to: '$arrive' },
        steps: [
          {
            op: 'atom',
            atom: 'atom.move_segment',
            params: { target: '$target', arrive: '$arrive' },
            as: 'mv',
          },
        ],
      },
    ],
    success: { op: 'le', of: '$vars.mv.distance', to: '$arrive' },
    notes: '每段最多 8 轮；no_path 会直接失败，交给战略降级',
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

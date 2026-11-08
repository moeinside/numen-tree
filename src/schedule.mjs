/**
 * 日程表（**数据，不是代码**）—— 回答"现在这个时段，自动模式允许做什么"。
 *
 * 设计边界（docs/12 §1）：
 *  - 只做"时段 → 允许/禁止 + 参数"，**不做价值判断**、不发明目标；
 *  - 时段判定只用已观测的事实（`st.dark`）和地点簿（有没有记"家"），不读游戏、不联网；
 *  - 中断表管"危险时怎么办"，日程表只管"空闲时做什么"；两者互不覆盖；
 *  - LLM 显式下目标（tree_task / tree_goal）不受日程限制（外层大脑优先）。
 *
 * 段的字段：
 *  - id / title        给人看
 *  - when(st, ctx)     纯判断；ctx = { hasHome }
 *  - leash             { maxDistance }：该时段牵引绳的最大距离（anchor 仍由 st.tether 决定）
 *  - allow             键 → 是否允许该类自动行为；**未声明的键 = 允许**（向后兼容）
 *                      键：feed / regroup / production / dayWork / guard / patrol / combat
 *  - work              [{ key, recipe, cooldownSeconds, requires? }]：白天自动开工的候选（按顺序试）
 *  - guard             { enabled, radius, minHpPercent, requireWeapon, cooldownSeconds, priority, skill }
 *  - patrol            { enabled, radius, intervalSeconds, requireWeapon, priority, range }
 *
 * 加一个时段 / 调行为 = 改这个文件；不要改 lane 里的具体行为。
 */

/** 时段表：从上往下匹配，第一条 when 成立的胜出；最后一条必须是兜底（when 恒真）。 */
export const SCHEDULES = [
  // ── 夜里 + 有"家"：在家守家（守卫 + 巡逻），不再满世界跑 ──────────
  {
    id: 'night',
    title: '夜里守家',
    when: (st, ctx) => !!st.dark && !!ctx?.hasHome,
    leash: { maxDistance: 16 },
    allow: {
      feed: true,
      regroup: true,
      production: false,
      dayWork: false,
      guard: true,
      patrol: true,
      combat: true,
    },
    work: [],
    guard: {
      enabled: true,
      radius: 10, // 这个距离内的敌对才主动打
      minHpPercent: 55, // 血不低于这个才打（更低交给中断表撤）
      requireWeapon: true, // 没武器不打（先自保）
      cooldownSeconds: 15,
      priority: 40,
      skill: 'fight_safe',
    },
    patrol: {
      enabled: true,
      radius: 6, // 绕着"家"这个半径的四个角走
      intervalSeconds: 25,
      requireWeapon: false, // 家里没威胁时巡逻，不看武器
      priority: 15,
      range: 2,
    },
  },

  // ── 夜里 + 没记"家"：退回 M1 的老路径（night_danger 中断开 go_home，没家就跟主人）──
  {
    id: 'night_nohome',
    title: '夜里（没记家）',
    when: (st) => !!st.dark,
    leash: null,
    allow: {
      feed: true,
      regroup: true,
      production: false,
      dayWork: false,
      guard: false,
      patrol: false,
      combat: true,
    },
    work: [],
  },

  // ── 白天：可以出门干活（采集/挖矿），牵引绳放宽 ──────────────────
  {
    id: 'day',
    title: '白天干活',
    when: () => true,
    leash: { maxDistance: 48 },
    allow: {
      feed: true,
      regroup: true,
      production: true,
      dayWork: true,
      guard: false,
      patrol: false,
      combat: true,
    },
    work: [
      // 没武器/工具时优先自给自足（死亡重生后就是这条路）；冷却长，避免反复做
      { key: 'bootstrap_kit', recipe: 'bootstrap_kit', cooldownSeconds: 600, requires: 'no_weapon' },
      // 有武器但缺采集工具（镐/斧）时补一套——否则会一直举着剑不干活
      { key: 'craft_tools', recipe: 'craft_tools', cooldownSeconds: 600, requires: 'missing_tool' },
      { key: 'gather_wood', recipe: 'gather_wood', cooldownSeconds: 120 },
      // 挖石头需要镐；没有镐就跳过（上面的 craft_tools 会补）
      { key: 'mine_stone', recipe: 'mine_stone', cooldownSeconds: 180, requires: 'pickaxe' },
    ],
  },
];

/** 日程被配置关掉时的兜底段：一切按 M1 老行为（不做任何额外限制）。 */
export const OFF_SEGMENT = {
  id: 'off',
  title: '日程关闭',
  when: () => true,
  leash: null,
  allow: {
    feed: true,
    regroup: true,
    production: true,
    dayWork: false,
    guard: false,
    patrol: false,
    combat: true,
  },
  work: [],
};

const DAY_SEGMENT = SCHEDULES[SCHEDULES.length - 1];

/**
 * 选当前时段段。纯函数，不抛。
 * @param {object} state CompanionState（只读 st.dark）
 * @param {{hasHome?: boolean}} ctx 地点簿里有没有记"家"
 */
export function pickSegment(state, { hasHome = false } = {}) {
  for (const seg of SCHEDULES) {
    try {
      if (seg.when(state, { hasHome })) return seg;
    } catch {
      /* 单条判断出错就跳过，别让日程把整个 tick 带崩 */
    }
  }
  return DAY_SEGMENT;
}

/**
 * 该时段允不允许某类自动行为。
 * 未声明的键 = 允许（新增行为不会因为日程表没写而失效）。
 */
export function allow(segment, key) {
  if (!segment || !segment.allow) return true;
  const v = segment.allow[key];
  return v !== false;
}

/**
 * 巡逻的下一个路点：绕"家"的四个角按顺序轮换。
 * @returns {{x:number,y:number,z:number}|null}
 */
export function patrolTarget(segment, { homePos, index = 0 } = {}) {
  if (!homePos) return null;
  const x = Number(homePos.x);
  const y = Number(homePos.y);
  const z = Number(homePos.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  const r = Math.max(1, Number(segment?.patrol?.radius ?? 6) || 6);
  const corners = [
    { x: x + r, y, z },
    { x, y, z: z + r },
    { x: x - r, y, z },
    { x, y, z: z - r },
  ];
  const i = Math.abs(Math.floor(Number(index) || 0)) % corners.length;
  return corners[i];
}

/** 背包里有没有某类工具（目前只认 pickaxe；给日程的 requires 用）。 */
export function hasTool(inventory, tool = 'pickaxe') {
  if (!Array.isArray(inventory)) return false;
  const want = String(tool).toLowerCase();
  return inventory.some((s) => {
    const id = String(s?.item ?? '').toLowerCase();
    if (!id) return false;
    if (want === 'pickaxe') return id.endsWith('_pickaxe') || id === 'minecraft:pickaxe';
    return id === want || id.endsWith(`_${want}`);
  });
}

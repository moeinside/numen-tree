/**
 * 离线回放 fixture 的公共小工具（**数据/形状**，不含逻辑）。
 *
 * 每个 fixture 只描述"世界给什么观测、技能返回什么、期望发生什么"；
 * 驱动/打桩/断言执行在 probe/replay.mjs 里，fixture 不碰 Lane 内部。
 */

/** 一份"完整观测"的默认值；fixture 用 obs({hunger:6,...}) 覆盖需要的字段。 */
export function obs(over = {}) {
  return {
    hp: 20,
    hunger: 20,
    x: 0,
    y: 64,
    z: 0,
    dim: 'minecraft:overworld',
    game_time: 6000,
    task_id: null,
    task: null,
    task_state: null,
    elapsed_s: null,
    budget_left_s: null,
    owner_online: true,
    owner_dist: 4,
    owner_x: 5,
    owner_y: 64,
    owner_z: 0,
    hostile_n: 0,
    hostile_d: null,
    dark: false,
    food: 0,
    food_kinds: 0,
    weapon: null,
    weapon_score: 0,
    held: null,
    animal_n: 0,
    animal_d: null,
    animal_t: null,
    ...over,
  };
}

/** 技能成功回执：等价于技能 Lua 的 J({...}) 输出（"ok":1）。 */
export function ok(data = {}) {
  return { ok: 1, ...data };
}

/** 技能失败回执：等价于 F(kind,msg,hint) 输出（"ok":0）。 */
export function fail(kind, msg, hint = '') {
  return { ok: 0, kind, msg, hint };
}

/**
 * 一条断言。check(ctx) 返回它的数组；ok=false 会让整个 fixture FAIL。
 * @param {string} name 给人看的断言名
 * @param {any} cond 真值
 * @param {string} [detail] 失败/通过时补充的事实（便于定位）
 */
export function check(name, cond, detail = '') {
  return { name, ok: !!cond, detail: detail == null ? '' : String(detail) };
}

/**
 * 软断言：用来标记"与 docs/12 不符、但当前 src 就是这样做"的已知问题。
 * 它**不影响**场景 PASS/exit code，只在输出里打 ⚠，方便把核心代码问题带回给 Lead；
 * src 修好后它会自动变 ✓（就可以升级成硬断言）。
 */
export function soft(name, cond, detail = '') {
  return { name, ok: !!cond, detail: detail == null ? '' : String(detail), soft: true };
}


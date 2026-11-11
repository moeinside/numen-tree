/**
 * P0-b：GoalProfile 自动续跑的最小判断。
 *
 * 原则：
 *  - 不重放已完成的副作用：先查世界谓词；
 *  - 谓词只读 state/facts，不认执行器自报；
 *  - 不支持验收的 recipe 返回 unknown，交给调用方决定（默认不自动重开）。
 */
export function countItem(state, item) {
  return (state?.inventory || [])
    .filter((x) => String(x.item) === item && Number(x.count) > 0)
    .reduce((a, x) => a + Number(x.count), 0);
}

/** 只覆盖有明确终态谓词的 recipe；其它返回 null（未知）。 */
export function acceptanceForRecipe(recipeId, state = {}) {
  switch (String(recipeId)) {
    case 'gather_wood': {
      const n = (state.inventory || [])
        .filter((x) => /_log$/.test(String(x.item)) && Number(x.count) > 0)
        .reduce((a, x) => a + Number(x.count), 0);
      return { predicate: 'logs', value: n, done: n >= 8 };
    }
    case 'mine_stone': {
      const n = countItem(state, 'minecraft:cobblestone');
      return { predicate: 'cobblestone', value: n, done: n >= 8 };
    }
    case 'craft_tools': {
      const has = (re) => (state.inventory || []).some((x) => re.test(String(x.item)) && Number(x.count) > 0);
      const done = has(/_pickaxe$/) && has(/_axe$/);
      return { predicate: 'has_pickaxe+axe', value: done, done };
    }
    case 'bootstrap_kit': {
      const has = (re) => (state.inventory || []).some((x) => re.test(String(x.item)) && Number(x.count) > 0);
      const done = has(/_pickaxe$/) && has(/_axe$/) && has(/_sword$/);
      return { predicate: 'has_pickaxe+axe+sword', value: done, done };
    }
    case 'fish_food': {
      const food = Number(state.foodCount ?? 0);
      const fish = countItem(state, 'minecraft:cooked_cod') +
        countItem(state, 'minecraft:cod') +
        countItem(state, 'minecraft:salmon') +
        countItem(state, 'minecraft:cooked_salmon');
      return { predicate: 'food_or_fish', value: food + fish, done: food > 0 || fish > 0 };
    }
    default:
      return null;
  }
}

/** 决定是否自动重开：done → 不重开；unknown → 不自动重开。 */
export function resumeDecision(recipeId, state) {
  const a = acceptanceForRecipe(recipeId, state);
  if (!a) return { action: 'unknown', acceptance: null };
  return { action: a.done ? 'done' : 'resume', acceptance: a };
}

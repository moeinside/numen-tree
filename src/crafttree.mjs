/**
 * 合成链数据（**数据，不是代码**）——回答"做这个物品需要什么、能不能自己往上补材料"。
 *
 * 用途：`craft` 技能卡的 `chain:true` 模式按这张表递归补前置（原木→木板→木棍→工具），
 * 不需要把每种物品的合成步骤写死在技能卡里。加一条物品 = 这里加一行。
 *
 * 约定：
 *  - key   = 目标物品 id；yields = 一次合成产出数量（给"缺多少算几次"用，单位是物品数）
 *  - needs = [{ kind:'any_planks'|'stick', count } | { item:'minecraft:xxx', count }]
 *      kind=any_planks  任意木板（运行时看背包里有哪种原木，现做对应木板）
 *      kind=stick       木棍（会先补木板再补木棍）
 *      item=...         直接材料，不做上游合成（矿石、煤等必须靠挖/捡）
 *  - table = true 表示 3×3 配方，需要附近有工作台（放置由配方步骤负责，不在这里做）
 *
 * 只收录 M2 真的会用的物品；加新物品前先确认游戏里 `numen.inv.make` 支持该配方。
 */

/** 1.21.1 常见原木类型（顺序 = 优先尝试顺序，越常见越靠前）。 */
export const LOG_TYPES = [
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'dark_oak',
  'cherry',
  'mangrove',
];

export const LOG_ITEMS = LOG_TYPES.map((t) => `minecraft:${t}_log`);
export const PLANK_ITEMS = LOG_TYPES.map((t) => `minecraft:${t}_planks`);

/** 目标物品 → 配方（needs 是"一次合成"的消耗；yields 是一次产出数量）。 */
export const CRAFT_TREE = {
  // 基础材料
  'minecraft:stick': { yields: 4, needs: [{ kind: 'any_planks', count: 2 }] },
  'minecraft:crafting_table': { yields: 1, needs: [{ kind: 'any_planks', count: 4 }] },
  'minecraft:chest': { yields: 1, needs: [{ kind: 'any_planks', count: 8 }] },
  'minecraft:furnace': { yields: 1, needs: [{ item: 'minecraft:cobblestone', count: 8 }] },

  // 木制工具（3×3，需要工作台已放好）
  'minecraft:wooden_sword': {
    yields: 1,
    table: true,
    needs: [{ kind: 'any_planks', count: 2 }, { kind: 'stick', count: 1 }],
  },
  'minecraft:wooden_pickaxe': {
    yields: 1,
    table: true,
    needs: [{ kind: 'any_planks', count: 3 }, { kind: 'stick', count: 2 }],
  },
  'minecraft:wooden_axe': {
    yields: 1,
    table: true,
    needs: [{ kind: 'any_planks', count: 3 }, { kind: 'stick', count: 2 }],
  },

  // 石制工具（需要工作台 + 圆石）
  'minecraft:stone_sword': {
    yields: 1,
    table: true,
    needs: [{ item: 'minecraft:cobblestone', count: 2 }, { kind: 'stick', count: 1 }],
  },
  'minecraft:stone_pickaxe': {
    yields: 1,
    table: true,
    needs: [{ item: 'minecraft:cobblestone', count: 3 }, { kind: 'stick', count: 2 }],
  },
  'minecraft:stone_axe': {
    yields: 1,
    table: true,
    needs: [{ item: 'minecraft:cobblestone', count: 3 }, { kind: 'stick', count: 2 }],
  },

  // 火把（需要煤，挖矿后再用）
  'minecraft:torch': {
    yields: 4,
    needs: [{ item: 'minecraft:coal', count: 1 }, { kind: 'stick', count: 1 }],
  },
};

/** 规范化物品 id（补 minecraft: 前缀、去空白）。 */
export function normalizeItem(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.includes(':') ? s : `minecraft:${s}`;
}

/** 查物品配方；查不到返回 null。 */
export function getRecipe(item) {
  return CRAFT_TREE[normalizeItem(item)] || null;
}

/**
 * 递归展开"做 count 个 item 需要先补什么"，返回有序步骤列表（不含最终 make）。
 * 每步：{ type:'planks'|'sticks'|'material', item?, count }
 * 无配方或材料无法上游合成（如圆石/煤）→ material 步骤（只检查数量，不合成）。
 */
export function planPrerequisites(item, count = 1, seen = new Set()) {
  const target = normalizeItem(item);
  const steps = [];
  const recipe = getRecipe(target);
  if (!recipe) return steps;
  const crafts = Math.max(1, Math.ceil(Number(count) / Math.max(1, Number(recipe.yields) || 1)));
  for (const need of recipe.needs || []) {
    if (need.kind === 'any_planks') {
      steps.push({ type: 'planks', count: need.count * crafts });
    } else if (need.kind === 'stick') {
      steps.push({ type: 'sticks', count: need.count * crafts });
    } else {
      const dep = normalizeItem(need.item);
      if (!dep) continue;
      const depRecipe = getRecipe(dep);
      if (depRecipe && !seen.has(dep)) {
        const key = `${dep}:${need.count * crafts}`;
        if (seen.has(key)) continue;
        seen.add(key);
        steps.push(...planPrerequisites(dep, need.count * crafts, seen));
      } else {
        steps.push({ type: 'material', item: dep, count: need.count * crafts });
      }
    }
  }
  return steps;
}

/** 某物品是不是"任意木板"类目标（如 oak_planks）。 */
export function planksTypeOf(item) {
  const t = normalizeItem(item);
  const i = PLANK_ITEMS.indexOf(t);
  return i >= 0 ? LOG_TYPES[i] : null;
}

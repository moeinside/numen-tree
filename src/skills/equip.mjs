import { LUA_PRELUDE } from './prelude.mjs';

/**
 * equip —— 把背包里的工具/武器换到手上（`numen.gear.hold`）。
 *
 * 为什么需要：`numen.gear.hold` 是唯一换手持物的 API；`work.dig/mine`、砍树、挖矿前
 * 拿着对的手（斧/镐）效率才对，战斗则交给 `fight.attack` 自己挑武器（不要手动 hold）。
 *
 * params:
 *   items  string（逗号分隔的候选，按顺序取第一个背包里有的；如 "stone_pickaxe,wooden_pickaxe"）
 *   或 item string（单个候选）
 *
 * 返回：{held:"minecraft:xxx"}
 * 失败：no_material（候选一个都没有）/ bad_argument / failed
 */
export default {
  id: 'equip',
  title: '换手持物（工具/武器）',
  params: {
    items: 'string（逗号分隔候选，优先用前面的）',
    item: 'string（单个候选，等价于 items 只有一项）',
  },
  meta: { gives: ['held'], risk: 'low', budgetMs: 30_000 },
  build(ctx, params = {}) {
    const raw = params.items ?? params.item ?? '';
    const list = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.includes(':') ? s : `minecraft:${s}`));
    if (!list.length) {
      return {
        code: `${LUA_PRELUDE}return F("bad_argument", "缺少 item/items 参数", "示例 items=stone_pickaxe,wooden_pickaxe")`,
        timeoutMs: 5000,
      };
    }
    const arr = `{ ${list.map((s) => `"${s}"`).join(', ')} }`;
    const code = `${LUA_PRELUDE}
local CANDIDATES = ${arr}

local function cnt(it)
  local ok, v = pcall(numen.inv.count, it)
  if not ok then return 0 end
  return tonumber(v) or 0
end

local ok, r = pcall(function()
  for _, it in ipairs(CANDIDATES) do
    if cnt(it) > 0 then
      -- gear.hold 失败（饰品槽冲突等）就试下一个
      local hOk, hRes = pcall(numen.gear.hold, it)
      if hOk then return { held = it } end
    end
  end
  error({ kind = "no_material", message = "背包里没有可装备的候选工具",
    hint = "先 craft 一把（wooden_axe / wooden_pickaxe）" })
end)
if not ok then return FAIL(r) end
return J({ { "held", S(r.held) } })
`;
    return { code, timeoutMs: 30_000 };
  },
};

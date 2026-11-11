import { LUA_PRELUDE } from './prelude.mjs';
import {
  LOG_ITEMS,
  PLANK_ITEMS,
  getRecipe,
  normalizeItem,
  planksTypeOf,
  planPrerequisites,
} from '../crafttree.mjs';

/**
 * craft —— 合成物品。
 *
 * 两种模式：
 *  - 默认（chain=false）：直接 `numen.inv.make(item, count)`，缺材料/缺工作台就失败；
 *  - chain=true：按 src/crafttree.mjs 的数据**递归补上游材料**（原木→木板→木棍→工具），
 *    并给出明确的失败 kind（no_material / failed），供配方 onFail 走"先做台子/先去砍树"分支。
 *
 * params:
 *   item   string（必填，如 minecraft:wooden_sword；不带命名空间会补 minecraft:）
 *   count  number = 1
 *   chain  boolean = false（true=自动补木板/木棍等可合成的前置；矿石/煤不自动采）
 *
 * 注意：3×3 配方（木剑/木镐/石剑…）需要附近有工作台；放台子是配方步骤的事，
 * 这里只负责"材料凑齐 + 调 make"。`numen.inv.make` 会自动找/开台子（docs/10 §4.2）。
 */

/** Lua 表字面量：字符串数组。 */
function luaArray(list) {
  return `{ ${list.map((s) => `"${String(s).replace(/"/g, '\\"')}"`).join(', ')} }`;
}

function badArgument(msg, hint) {
  return {
    code: `${LUA_PRELUDE}return F("bad_argument", "${String(msg).replace(/"/g, '\\"')}", "${String(hint).replace(/"/g, '\\"')}")`,
    timeoutMs: 5000,
  };
}

export default {
  id: 'craft',
  title: '合成物品（可链式补材料）',
  params: {
    item: 'string（必填）',
    count: 'number = 1',
    chain: 'boolean = false（true=自动补木板/木棍等上游材料）',
  },
  meta: { gives: ['crafted'], risk: 'low', budgetMs: 120_000 },
  build(ctx, params = {}) {
    const item = normalizeItem(params.item || '');
    if (!item) return badArgument('缺少 item 参数', '示例 minecraft:oak_planks / wooden_sword');
    const count = Math.max(1, Math.floor(Number(params.count ?? 1)) || 1);
    const chain = params.chain === true || params.chain === 'true' || params.chain === 1;
    if (!chain) {
      // 简单模式：行为和 M1 一致
      const safe = item.replace(/'/g, "\\'");
      const code = `${LUA_PRELUDE}
local ok, r = pcall(function()
  return numen.inv.make('${safe}', ${count})
end)
if not ok then return FAIL(r) end
local have = 0
pcall(function()
  have = numen.inv.count('${safe}')
end)
return J({ { "item", S('${safe}') }, { "have", N(have) } })
`;
      return { code, timeoutMs: 120_000 };
    }
    return buildChain(item, count);
  },
};

/** 链式合成：把 JS 侧展开的前置步骤翻译成一段 Lua（运行时按背包实际情况补）。 */
function buildChain(item, count) {
  const recipe = getRecipe(item);
  const planksType = planksTypeOf(item);
  if (!recipe && !planksType) {
    return badArgument(
      `crafttree 里没有 ${item} 的配方`,
      'chain=true 只支持 crafttree.mjs 里登记过的物品；直接 make 请用 chain=false',
    );
  }

  const steps = planPrerequisites(item, count);
  const seq = [];
  if (planksType) {
    // 目标本身是木板：从对应原木做
    const idx = PLANK_ITEMS.indexOf(item) + 1;
    seq.push(`if not ensurePlanks(${count}, ${idx}) then fail("no_material", "缺对应原木，做不了 ${item}") end`);
  }
  for (const s of steps) {
    if (s.type === 'planks') {
      seq.push(`if not ensurePlanks(${s.count}) then fail("no_material", "缺原木/木板（需要 ${s.count} 木板）", "先去砍树") end`);
    } else if (s.type === 'sticks') {
      seq.push(`if not ensureSticks(${s.count}) then fail("no_material", "缺木棍（需要 ${s.count} 根）", "先补木板") end`);
    } else if (s.type === 'material') {
      seq.push(
        `if cnt("${s.item}") < ${s.count} then fail("no_material", "缺材料 ${s.item} x${s.count}", "需要先挖/捡到") end`,
      );
    }
  }

  const safeItem = item.replace(/'/g, "\\'");
  const finalBlock = planksType
    ? `  local after = cnt(ITEM)
  if after < COUNT then
    error({ kind = "no_material", message = "木板不够：想要 " .. COUNT .. " 个 " .. ITEM .. "，实际 " .. after,
      hint = "砍对应种类的树（ensurePlanks 已按原木补齐）" })
  end
  return { before = before, after = after }`
    : `  local mok, merr = pcall(numen.inv.make, ITEM, COUNT)
  if not mok then
    error({ kind = "failed", message = "合成失败：" .. tostring(merr),
      hint = "可能缺工作台（3×3 配方要先放台子）/ 材料 / 背包空间" })
  end
  local after = cnt(ITEM)
  if after < COUNT then
    error({ kind = "no_material", message = "合成后数量不够：想要 " .. COUNT .. "，实际 " .. after .. "（" .. ITEM .. "）",
      hint = "确认材料够、工作台在附近" })
  end
  return { before = before, after = after }`;

  const code = `${LUA_PRELUDE}
local ITEM = '${safeItem}'
local COUNT = ${count}
local LOGS = ${luaArray(LOG_ITEMS)}
local PLANKS = ${luaArray(PLANK_ITEMS)}

-- 链式分支内用的失败 helper（不能依赖全局 fail；numen 只暴露 numen.* API）
local function fail(kind, message, hint)
  error({ kind = kind, message = message, hint = hint })
end

local function cnt(it)
  local ok, v = pcall(numen.inv.count, it)
  if not ok then return 0 end
  return tonumber(v) or 0
end

local function cntAny(list)
  local s = 0
  for _, it in ipairs(list) do s = s + cnt(it) end
  return s
end

-- 补木板：优先用背包里现有的原木；单种失败再试下一种（最多试 3 种，省 API 调用）
local function ensurePlanks(n, preferLog)
  if cntAny(PLANKS) >= n then return true end
  local order = {}
  if preferLog ~= nil then table.insert(order, preferLog) end
  for i = 1, #LOGS do
    if i ~= preferLog then table.insert(order, i) end
  end
  local tried = 0
  for _, i in ipairs(order) do
    if tried >= 3 then break end
    if cnt(LOGS[i]) > 0 then
      tried = tried + 1
      pcall(numen.inv.make, PLANKS[i], n)
      if cntAny(PLANKS) >= n then return true end
    end
  end
  return cntAny(PLANKS) >= n
end

local function ensureSticks(n)
  if cnt('minecraft:stick') >= n then return true end
  local have = cnt('minecraft:stick')
  local needPlanks = math.ceil((n - have) / 4) * 2
  if not ensurePlanks(needPlanks) then return false end
  pcall(numen.inv.make, 'minecraft:stick', n)
  return cnt('minecraft:stick') >= n
end

local ok, r = pcall(function()
  if cnt(ITEM) >= COUNT then
    return { before = cnt(ITEM), after = cnt(ITEM), already = true }
  end
  local before = cnt(ITEM)
${seq.map((line) => `  ${line}`).join('\n')}
${finalBlock}
end)
if not ok then return FAIL(r) end
local made = (r.after or 0) - (r.before or 0)
return J({ { "item", S(ITEM) }, { "made", N(made) }, { "have", N(r.after or 0) } })
`;
  return { code, timeoutMs: 180_000 };
}

/**
 * 所有技能 Lua 程序共用的前缀。
 *
 * 约定：每个技能程序最后必须 return 一个"紧凑 JSON 字符串"（≤300 字符），
 * 因为 MCP 回执对单个长字符串会截断。树侧只认这个格式。
 */
export const LUA_PRELUDE = `
local function S(v)
  local s = tostring(v or "")
  s = s:gsub('"', "'"):gsub("[\\r\\n\\t]", " ")
  if #s > 110 then s = s:sub(1, 107) .. "..." end
  return '"' .. s .. '"'
end
local function N(v)
  local n = tonumber(v) or 0
  return tostring(math.floor(n * 100 + 0.5) / 100)
end
local function J(pairs)
  local out = { '{"ok":1' }
  for _, kv in ipairs(pairs) do
    out[#out + 1] = ',"' .. kv[1] .. '":' .. kv[2]
  end
  out[#out + 1] = '}'
  return table.concat(out)
end
local function F(kind, msg, hint)
  return '{"ok":0,"kind":' .. S(kind) .. ',"msg":' .. S(msg) .. ',"hint":' .. S(hint or "") .. '}'
end
local function FAIL(err)
  if type(err) == "table" then
    return F(err.kind or "failed", err.message or "", err.hint or "")
  end
  return F("failed", tostring(err), "")
end
`;

/** 把 JS 值安全地转成 Lua 字面量（只用于 params 注入）。 */
export function luaLiteral(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `{${value.map(luaLiteral).join(', ')}}`;
  if (typeof value === 'object') {
    const parts = Object.entries(value).map(
      ([k, v]) => `${JSON.stringify(k).replace(/^"|"$/g, '')} = ${luaLiteral(v)}`,
    );
    return `{${parts.join(', ')}}`;
  }
  // 字符串：单引号包住，转义反斜杠与单引号
  const s = String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${s}'`;
}

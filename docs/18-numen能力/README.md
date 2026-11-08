# numen 能力全表（索引 / 使用说明）

> 目的：把 numen MCP + Lua API 的**全部能力**整理成"可查、可程序消费"的资料，供树设计/战术包/换游戏适配使用。
> 别整份读！按需读对应组文件，或查 JSONL。

## 目录结构（小文件，按需读）

```
docs/18-numen能力/
  README.md              ← 本文件（索引 + 字段说明）
  mcp-tools.md           ← MCP 工具层（lua/get_events/list_companions/...）
  events.md              ← 事件清单（肾上腺素触发源候选）
  lua-<group>.md         ← 每个 Lua 组/模块一个文件（status/scan/work/move/inv/build/fight/gui/...）
docs/18-data/
  capabilities.jsonl     ← 机器可读：一行一个函数（人可 grep，程序可 parse）
  mcp-tools.json
  events.json
tools/numen-cap/
  build.mjs              ← 生成脚本（抓 API help → 写 JSONL/分文件表格）
  query.mjs              ← 查询脚本（按组/名字过滤，只输出你要的行）
```

## 现状（2026-11-08 首轮静态盘点完成）

- **MCP 工具**：9 个（见 `mcp-tools.md`；机器可读 `docs/18-data/mcp-tools.json`）
- **Lua API**：**18 个官方组 + `numen.shape` 模块 = 87 个函数**（见 `lua-*.md`；JSONL 106 行 = 87 函数 + 19 组）
- **事件**：已知 6 类，待实测补全（见 `events.md`）
- **判定列**（internal/cost/reliability/atomic/treeRole/priority）**已回填 18 个关键函数**（首轮实验，见 `docs/17 §10` 与 `docs/18-data/experiments.jsonl`）；其余仍 `❓`，下一轮补。

## 高效使用方式（省 token）

1. **先查索引**：`node tools/numen-cap/query.mjs --groups` 看有哪些组；
2. **查一个函数**：`node tools/numen-cap/query.mjs scan.blocks` 只输出那一行（含摘要/坑/原子判定）；
3. **看一个组**：读 `docs/18-numen能力/lua-scan.md`（一个组一个文件，别读全表）；
4. **程序消费**：直接 parse `capabilities.jsonl`（一行一个 JSON，不会破坏）；
5. 需要原始帮助文本时才读 JSONL 里的 `helpText` 字段（用 query 输出）。

## 字段定义（JSONL 每行）

| 字段 | 说明 |
|---|---|
| `layer` | `mcp` / `lua` / `event` |
| `group` | 所属组（如 `numen.scan`、模块 `numen.inv`） |
| `name` | 全名（如 `numen.scan.blocks`） |
| `signature` | 帮助里的签名行 |
| `brief` | 一句话摘要（取帮助首行） |
| `internal` | 是否复合动作（内部走+挖+捡等） |
| `cost` | 实测耗时档位：`ms` / `sec` / `tens` / `uncontrolled` / `na` |
| `reliability` | 已知坑/返回可靠性 |
| `atomic` | `yes` / `no` / `cond`（有条件，如限距） |
| `treeRole` | `delegate`（委托）/ `replace`（树替代）/ `keep`（保留预制战术包） |
| `priority` | 主要服务层级 `P0`~`P5` |
| `tested` | `✅` 实测过 / `⚠️` 有坑 / `❓` 待测 |
| `notes` | 备注 |
| `helpText` | 原始帮助文本（可能较长，仅 JSONL 有） |

## 维护约定

- **来源**：`numen.api.help(...)` 抓取 + docs/10 既有实测 + 后续实验补充；
- 改字段/加列 = 同步 README 和 `query.mjs`；
- 树设计只用这里的"判定列"（atomic/treeRole/priority），不要在别处重复造表；
- 每次实测回来在 `tested/notes` 更新，并保留 `helpText` 不动。

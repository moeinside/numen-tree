# 93. 试驾员：原生 MCP + 监督式 GM

> 2026-11-10。修正 docs/91/92 的工具路径与 GM 暴露问题。  
> 结论：Operator 必须是原生 MCP 工具调用；GM 只属于外部监督员，Operator 永远不知道。

## 1. 当前错误

### 错误 1：Operator 不是原生 MCP

现在：

```text
DSH subagent
  → pwsh
    → tools/pilot/dsh-bridge.mjs
      → HTTP MCP
```

所以日志里很多是 shell/Lua 文件，不是 `mcp__numen__*` 工具调用。  
原生“外接大脑（Numen）”预设：

```text
DSH Numen preset
  → mcp__numen__list_companions
  → mcp__numen__get_events
  → mcp__numen__lua
  → ...
```

工具面、循环、提示词都不同，这就是自主性差异的来源。

### 错误 2：GM 暴露给 Operator

上一轮 GOAL/提示词写了 GM TP 方法，Operator 把作弊当普通手段。  
**GM 必须从 Operator 的 prompt、工具、环境变量、文档、日志中完全消失。**

## 2. 正确架构

```text
Operator（原生 Numen MCP）
  - 只有一个目标 + 预算
  - 只看到正常工具
  - 不知道 GM/监督员/token
  - 自己观察、移动、采集、合成、战斗、吃
  - 一次一个原生工具调用
  - 不写 summary

Supervisor（Lead 或独立子体/进程）
  - 独立观测（status/trace）
  - 判断溺水/卡位/无路/HP 危殆
  - 决定是否 GM
  - 记录 gm.jsonl / assisted
  - 执行后通知 Operator：“环境状态已更新，请重新观察”
  - 执行 10 分钟硬截止

Logger
  - Operator 的 DSH session trace
  - Supervisor 的 gm/intervention 记录
  - 两者独立归档

Analyst（独立子体）
  - 读 trace + gm 记录
  - 写 roundtable-pack
```

## 3. Operator 提示词（按原生预设改）

原则来自 `dsh-plugin-numen-brain`：

```text
你是 Minecraft 里的 Numen 同伴，一个有身体、有背包、只有一条命的角色。
你不是助手；你会走、会挖、会造、会打，会饿会死。

目标：<只写结果目标>
预算：<硬截止由外部执行>
约束：<安全/资源边界，不写步骤>

行为：
- 一次只调一个工具，看结果再决定下一步。
- 先 list_companions / get_events / status，再行动。
- 有活连着做；不要回一句就停。
- 生存优先：血低/饿先撤、吃、躲；不空手打强力怪。
- 同一动作失败两次就换方法，不要原地重试。
- 找不到东西：换 id、加大半径、换方向探索。
- 不写总结、不解释工具调用、不输出长分析。
- 如果环境突然变化（位置/状态变了），重新观测后继续。
- 不要询问/假设任何 GM、作弊、外部救援；你只用手上的正常工具。
```

GM 不出现。  
外部干预表现为“世界状态变化”，Operator 只需重新观测。

## 4. Supervisor 干预协议

### 检测

- `in_water` 持续 > N 秒且位置无进展；
- 卡位/`no_path` 连续失败；
- 位置长时间不变且目标无进展；
- HP < 8；
- 无食物来源且已完成合理搜索。

### 决策

- 先给 Operator 时间自己解决；
- 超过阈值才 GM；
- GM 前写自问：真的无解？最小操作？是否影响测试？如何验证？
- 只做最小操作：TP 到安全/有食物环境、给测试物品、复位夹具；
- 标记 `assisted/gm`；
- 通知 Operator：“环境状态已更新，请重新观察并继续目标。”

### 不暴露

- 不说“我用了 GM”；
- 不给命令/token/端口；
- 不指导它“该做什么”；
- 只给状态变化这一事实。

## 5. 日志

```text
Operator trace（DSH session / MCP tool calls）
Supervisor:
  runs/<id>/gm.jsonl
  runs/<id>/interventions.jsonl
  runs/<id>/supervisor.log
Analyst:
  archive/<id>/roundtable-pack.md
```

## 6. 硬截止

- Supervisor 计时；
- 到点停止 Operator（中断 session / 关闭 dev 模式）；
- 不再接受任何 MCP 调用；
- 记录 `hard_timeout`；
- Operator 不能自己延长。

## 7. 落地顺序

1. 用原生 Numen 预设做 Operator（不再用 bridge 作为主路径）；
2. 写原生 Operator prompt（去掉 GM）；
3. Supervisor 独立观测 + GMProvider + intervention；
4. 日志归档；
5. 再跑 10 分钟“找吃的”。

## 8. 一句话

> **Operator 用原生 MCP，自己解决问题；GM 只存在于监督员手里，Operator 只知道“环境变了，重新决策”。**

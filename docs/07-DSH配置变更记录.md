# DSH 配置变更记录

> 记录所有**在本项目之外**做过的改动（DSH profile、mod 目录）。
> 出问题时先查这里：很可能是某次改动导致的。

---

## 变更 #1 — 2026-11-07：关闭 profile 根级 numen MCP 插入

### 现象

- 树进程的 trace 里反复出现 `slot_blocked` / `slot_unblocked`，最长被占 **142 秒**。
- 游戏日志里出现**手写 Lua**（不是树生成的）：
  `pcall(numen.work.collect)`、`pcall(numen.inv.craft, "minecraft:spruce_planks")`、`print(numen.api.help("numen.build"))`。
- 表现为「树卡住了，但 NPC 还在行动」。

### 原因

`~/.dsh/profiles/desktop/cordis.patch.yml` 里有一条**根级（profile 级）** 的 MCP 客户端插入：

```yaml
- insert:
    - id: mcp-numen
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: numen
        url: http://127.0.0.1:8765/mcp
        ...
```

根级 = **每个会话**都会挂上 numen 的 9 个工具（含 `lua`）。于是任何普通会话都能直接驱动同伴，
和树进程抢同一个「每同伴唯一」的 Lua 执行槽。

**不是插件 bundle 的问题**：`dsh-plugin-numen-brain` 只是声明了一个可选预设，
真正让所有会话拿到工具的是这条根级插入。实测两个活跃会话的 `agentPreset` 都是 `standard`。

### 改了什么

注释掉上述根级 `- insert: mcp-numen` 块（保留原文，便于恢复）。

- 文件：`C:\Users\Lihao\.dsh\profiles\desktop\cordis.patch.yml`
- 备份：`cordis.patch.yml.bak-before-disable-root-numen-20261107-190835`

### 影响

| 会话类型 | 改前 | 改后 |
|---|---|---|
| 普通会话（`standard`） | 有 numen 工具（含 `lua`） | **没有** |
| 外接大脑（Numen 树） | numen + tree（会抢槽） | **只有 tree** |
| 外接大脑（Numen）旧预设 | 有 | **仍有**（bundle 内部自带一份） |

### 回滚

把 `cordis.patch.yml` 里那段注释去掉，重启 DSH。

### 验证

1. 重启 DSH；
2. 新建普通会话 → 工具列表里不应再有 `mcp__numen__*`；
3. 新建会话选「外接大脑（Numen 树）」→ 只有 `mcp__tree__*`；
4. 新建会话选「外接大脑（Numen）」→ 仍有 `mcp__numen__*`；
5. 树不再出现 `slot_blocked`。

---

## 变更 #2 — 2026-11-07：新增预设「外接大脑（Numen 树）」

### 改了什么

在同一个 `cordis.patch.yml` 末尾追加了一个 `- insert:` 块，声明 `preset-numen-tree`：

- persona：约 1.1 KB，教模型"只下目标、不微操"
- `mcp-tree` → `http://127.0.0.1:8767/mcp`
- time-context、compaction
- `order: 21`，与旧预设（order 20）并存

### 备份

`cordis.patch.yml.bak-before-numen-tree`

### 回滚

删掉文件末尾那个 `- insert: preset-numen-tree` 块。

---

## 变更 #3 — 2026-11-07：mod 目录新增 `numenlockfix-1.0.0.jar`

### 为什么

修 numen 的僵尸锁：切存档后 `ServerPrograms.RUNNING`（JVM 静态表）残留，
导致同伴 Lua 槽永久被占。

### 改了什么

往 `.minecraft\versions\1.21.1-NeoForge\mods\` 放了一个 2.7 KB 的独立 mod。
它只在**服务器启动时**通过反射清空那张静态表，不改 numen 本体。

### 回滚

**删掉 `numenlockfix-1.0.0.jar`，重启游戏。**

### 详细说明

见 `patcher/README.md`。

---

## 变更 #4 — 2026-11-07：桌面启动脚本

新增 `启动树进程.bat`：

- 检测 8765（游戏）/ 8767（已有树进程）
- 8767 被占 → 打印 PID，5 秒后自动结束旧进程再启动（按 N 取消）
- 树崩溃时显示退出码并停住窗口

无破坏性；删掉即无影响。

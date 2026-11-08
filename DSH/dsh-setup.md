# DSH 侧安装手册（把这份文件整个交给 DSH 里的 AI）

> 以上说明由大肥鲸自动生成，可能与实际行为有出入，一切以源码为准。

**怎么用**：把这份文件完整交给 DSH 里的一个会话（普通会话就行），说一句：

> 「照这份文件把 DSH 侧配好」

AI 会照第 2 节的指令改好你的 DSH 配置。**全程只有一步需要你亲自做：最后重启 DSH**
（AI 不能自己重启——重启会把它的会话杀掉）。

这份文件是**自包含**的：要写入的 YAML 就在第 4 节，不需要另外找文件。

---

## 0. 这份文件要达成什么

在 DSH 里增加一个 Agent 预设「**外接大脑（Numen 树）**」，效果是：

- 选了它的会话，只连**树进程**（`http://127.0.0.1:8767/mcp`），拿到 `tree_*` 共 10 个工具；
- **不**连 numen 本身（8765），所以不会和树抢同一个同伴的执行槽；
- 预设自带一段人设，教模型「只下目标、不微操」。

最终交付物只有一个：**在你 DSH profile 的 `cordis.patch.yml` 末尾，多一个顶层 `- insert:` 块。**

---

## 1. 前置检查（AI 开工前先看）

| 条件 | 检查方式 | 不满足怎么办 |
|---|---|---|
| DSH 已装好 | 用户能正常新建会话 | 先装 DSH，本文件帮不上 |
| 树进程在跑 | `Test-NetConnection 127.0.0.1 -Port 8767` | 去 numen-tree 目录起树（`node src/daemon.mjs` 或 `启动树进程.bat`） |
| 游戏已开、同伴在线 | numen 的 MCP 在 `127.0.0.1:8765` | 先开游戏、召唤同伴；并确认游戏内 **设置 → 外接大脑 (MCP)** 已打开「外接大脑模式」并点了「保存并重启服务」 |
| AI 能写 `%USERPROFILE%\.dsh` | 尝试列目录/写测试 | 没权限就转第 5 节，由人工执行 |

> 树没起来**也**可以先配 DSH（预设里有 `failOnStartupError: false`，不会报错），只是暂时没有工具可用。

---

## 2. 给 AI 的指令：照这个做

### 2.1 你要达到的最终状态

- 文件：`%USERPROFILE%\.dsh\profiles\<profile 名>\cordis.patch.yml`
- 在**文件末尾**追加**一个**顶层条目（以 `- insert:` 开头，顶格，不要缩进）
- 内容 = 第 4 节代码块里的原文，**逐字照抄，不要改任何字**
- **不要**改动这个文件里已有的任何内容

### 2.2 步骤

```powershell
# ① 找到 profile 名（通常只有一个 desktop，也可能有 web / headless）
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object -ExpandProperty Name

# ② 设定变量（profile 名按上一步的实际值改）
$profileName = 'desktop'
$dst = Join-Path $env:USERPROFILE ".dsh\profiles\$profileName\cordis.patch.yml"
Test-Path $dst          # 必须为 True

# ③ 幂等检查：已经装过就不要再装
if (Select-String -Path $dst -Pattern 'id: preset-numen-tree' -Quiet) {
  '已安装过 preset-numen-tree，跳过写入'
} else {
  # ④ 先备份（文件名带时间戳，回滚时用）
  Copy-Item $dst "$dst.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  '备份完成'
}
```

然后写入。你要追加的内容就是**第 3 节的 YAML 原文**（逐字照抄，不要自己重写、不要改缩进、不要翻译）：

- **如果你有文件读写工具**（推荐）：以 UTF-8 编码把第 3 节内容追加到 `$dst` 末尾，前面补一个空行。
- **如果只有 shell**：先把第 3 节内容原样存成临时文件，再执行：

```powershell
$tmp  = Join-Path $env:TEMP 'preset-numen-tree.patch.yml'   # ← 先把这个文件写出来（UTF-8）
$yaml = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
[System.IO.File]::AppendAllText($dst, "`r`n" + $yaml, (New-Object System.Text.UTF8Encoding($false)))
'已追加预设'
```

### 2.3 校验（必须做）

```powershell
# 关键行只应出现 1 次
(Select-String -Path $dst -Pattern 'id: preset-numen-tree').Count

# 行数应比备份多 80 行左右。⚠ 必须加 -Encoding UTF8：
# PowerShell 5.1 对无 BOM 的 UTF-8 文件默认按 GBK 解码，不加会数错（实测 130 vs 169）
(Get-Content $dst -Encoding UTF8).Count
```

### 2.4 收尾

告诉用户：**「配置已写入，请重启 DSH，然后新建会话选『外接大脑（Numen 树）』预设」**。

### 2.5 红线（违反了就会弄坏用户环境）

1. **只许追加**那个 `- insert:` 块，不许改动文件里其它任何内容（模型、界面、其它预设都是用户在用的）。
2. **不许用 `Get-Content ... | Add-Content`**：PowerShell 5.1 会把 UTF-8 中文按 GBK 解码，造成乱码。用 2.2 的 .NET 写法。
3. **不许把 numen 的 MCP（8765）插到 profile 根级**：那会让每个会话都拿到 numen 的 `lua` 工具，和树抢执行槽（现象：同伴卡住却还在动、树 trace 反复 `slot_blocked`）。
4. 写坏了就用 2.2 ④ 的备份覆盖回去，再重启 DSH。

---

## 3. 要写入的 YAML（原文照抄，逐字一致）

```yaml
# Numen 树的 Agent 预设：外接大脑（Numen 树）
# 依赖：树进程在跑（cd <numen-tree 目录> && node src/daemon.mjs），MCP 端点 http://127.0.0.1:8767/mcp
- insert:
    - id: preset-numen-tree
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: numen-tree
        name: 外接大脑（Numen 树）
        description: 通过树进程指挥 Minecraft 里的 Numen 同伴；仅在选用此预设的会话中加载。
        order: 21
        plugins:
          - id: persona
            name: "@deepseek-ai/dsh-persona"
            config:
              prefix: |
                你是 Minecraft 世界里 Numen 同伴的"大脑"。你看不到、也动不了身体——身体由"树"按你的命令执行。你的职责只有三件：听懂主人的话、决定做什么、把结果说给主人听。你不负责"怎么做"。

                ## 你的工具（全部是树的接口）
                - tree_status()：同伴在哪、在做什么、队列里有什么。每次醒来先看它。
                - tree_skills()：树能做哪些事、各自什么参数。不确定能不能做就先查它。
                - tree_goal(companion, skill, params, priority)：下一个任务，立刻返回。可以排多个。
                - tree_control(companion, op)：pause / resume / clear / mode。
                - tree_inbox(since)：拉上报。★ 是需要你决策的，其余只是通知。
                - tree_wait(since, timeout_seconds)：等树找你（最长 90 秒）。没事时零成本，有事立刻返回。
                - say(companion, text)：游戏内说话。
                - memory(...)：跨会话笔记（坐标、偏好、教训）。

                ## 工作节奏（最重要）
                - 你的默认状态是"等"，不是"做事"。每次醒来先 tree_wait 或 tree_inbox，看完再决定。
                - 只有三种情况需要你出面：① 主人说话；② 树上报了 ★ 求助或失败；③ 当前目标完成，该考虑下一步。
                - 其余时间不要轮询、不要追问细节、不要自己补一步。
                - 绝对不要试图一步步指挥同伴走路、跳、挖、打。那是树的活。你只下"做什么"。

                ## 下目标的规矩
                - 一次一个目标，参数写全。不要下含糊的目标（"去那边"这种）。
                - 目标失败且树给了 kind（no_path / not_found / out_of_reach / denied…）：换方法，不要原样重试。
                - 同一个目标失败两次，停下来问主人，或者换目标。
                - 树没有对应技能时，直接告诉主人"这个我暂时不会"，不要硬凑。
                - 主人说"回来/过来/别乱跑"：用 go_to，target 写 "owner"。

                ## 说话
                - 游戏内说话一律用 say。你直接输出的文字只出现在 DSH 界面，游戏里的人看不到。
                - 主人说话后，第一件事先用 say 回一句，再动手。别一声不吭。
                - 短句、口语，像一起玩的朋友。不要念数据、不要报工具名、不要刷屏。

                ## 生存与安全
                - 树报了危险或失败，优先保命：先 retreat 或 go_to 主人，再谈任务。
                - 不要为了完成任务让同伴顶着打不过的架。
                - 没有主人明确要求，不要解散同伴、不要乱丢东西。
              includeRuntimeContext: false
          - id: time-context
            name: "@deepseek-ai/dsh-time-context"
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: "@deepseek-ai/dsh-compaction-basic"
              - id: command-compact
                name: "@deepseek-ai/dsh-command-compact"
              - id: tool-result-pruner
                name: "@deepseek-ai/dsh-compaction-tool-result-pruner"
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          - id: mcp-tree
            name: "@deepseek-ai/dsh-mcp-client"
            config:
              serverName: tree
              transport: streamable-http
              url: http://127.0.0.1:8767/mcp
              toolCallTimeoutMs: 120000
              failOnStartupError: false
              reconnect:
                enabled: true
                initialDelayMs: 500
                maxDelayMs: 30000
                maxAttempts: 10000
```

---

## 4. 人工安装（AI 没有文件权限，或你想自己动手）

1. 备份：
   ```powershell
   $dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
   Copy-Item $dst "$dst.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
   ```
2. 用编辑器（VSCode / Notepad++，**存 UTF-8**）打开 `$dst`，把第 3 节的 YAML 整段贴到**文件末尾**。
   注意 `- insert:` 必须顶格。
3. 保存 → 重启 DSH。

> 别用记事本「另存为 ANSI」。中文会变乱码，DSH 可能起不来。

---

## 5. 重启 DSH（必须人工）

配置只在 DSH 启动时加载。**关掉 DSH 再打开**，然后：

新建会话 → Agent 预设选「**外接大脑（Numen 树）**」→ 说一句试试：

> 「让 tyrander 走到我面前」

---

## 6. 验证清单

| 检查 | 怎么查 | 期望 |
|---|---|---|
| 树在跑 | `Test-NetConnection 127.0.0.1 -Port 8767` | `TcpTestSucceeded : True` |
| 预设出现了 | DSH 新建会话的预设列表 | 有「外接大脑（Numen 树）」 |
| 工具挂上了 | 会话里问「你有哪些工具」 | 有 `mcp__tree__tree_status`、`tree_goal` 等 |
| 真能动 | 「让 tyrander 走到我面前」 | 同伴开始走，树窗口有执行日志 |

---

## 7. 卸载 / 回滚

任一方式，然后重启 DSH：

```powershell
# 方式 A：用最新备份覆盖
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$bak = Get-ChildItem "$dst.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $bak.FullName $dst -Force

# 方式 B：手动删掉文件末尾那个 - insert: preset-numen-tree 块
```

---

## 8. 常见问题

| 症状 | 原因 / 处理 |
|---|---|
| 预设列表里没有「外接大脑（Numen 树）」 | 没重启 DSH；或 YAML 缩进坏了（`- insert:` 要顶格）；或写到了别的 profile |
| 有预设，但没有 `mcp__tree__*` 工具 | 树没跑 / 8767 没监听。先起树再重启会话 |
| 模型说「树无响应」 | 看树进程窗口报错；确认 `tree.config.json` 的 port 8767 没被占用 |
| 同伴不动 | 同伴在线吗？游戏暂停了吗？`node src/cli.mjs status` 看队列；别让两个会话同时驱动同一同伴 |
| 中文乱码 / DSH 起不来 | 编码坏了：用备份覆盖，重启，重做一次（编辑器里选 UTF-8） |
| 装完之后所有会话都变慢 | 可能误把 numen 的 MCP 插到了根级，见 2.5 第 3 条 |

---

## 9. 背景资料（可选阅读）

- 为什么不能让 numen 直连所有会话：本仓库 `docs/07-DSH配置变更记录.md`
- 树对 LLM 暴露的 10 个工具：`docs/05-接口契约.md`

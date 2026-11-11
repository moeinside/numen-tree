# Numen Lock Fix（僵尸锁补丁 v1.2）

修 numen 的"程序槽被永久占用"问题。**不修改 numen 本体**，删除本 jar 即完全回滚。

## 1. 问题是什么

numen 用一张 **JVM 静态表** 记录"每个同伴当前在跑哪个程序"：

```java
// com.dwinovo.numen.program.ServerPrograms
private static final Map<UUID, ServerPrograms.Running> RUNNING;
```

静态字段的生命周期 = **整个 JVM 进程**。只要某个程序没有正常结束，该同伴的 UUID 就留在表里，
此后任何 `lua` 调用都被拒：

```
a program is already running for this companion, or its built-in brain is acting
```

**会留锁的情况**：切存档/重进世界、客户端死在调用途中（树被杀/等回执超时）、同伴死亡打断在途调用。

## 2. 本补丁做了什么（v3）

| # | 能力 |
|---|---|
| 1 | **服务器启动时**清空整张表（那一瞬间不可能有合法程序在跑） |
| 2 | **同伴死亡时**延迟 1 tick 清掉该 UUID 的条目 |
| 3 | **`/numenlockfix` 指令**（权限 2）手动清空 |
| 4 | **本地控制端口 `127.0.0.1:8768`**（v3 新增）——给树进程/终端用，不用玩家在游戏里敲命令、不用重启游戏、不用重建同伴 |
| 5 | **`POST /reset-brain`**（v1.2 新增）——清掉内置脑/任务槽的卡死任务（`CompanionTickDispatcher.cancelFor` + `clearActiveTask` + `TaskPersistence.forget`），**不删实体、不丢背包** |

> v1.2 解决"内置脑任务卡死"：补丁 `/status` 里 `count=0`（没有残留 Lua 程序），但同伴动作槽被 `CompanionBrain` 的 task 占着，`unlock` 清不掉。

### 2.1 外部控制端口（v3 核心）

只绑回环地址，纯 `ServerSocket` 实现，无额外依赖：

| 请求 | 作用 |
|---|---|
| `GET /status` | 返回补丁版本、反射是否找到 `ServerPrograms`（`foundClass`）、内置脑反射是否可用（`brainReady`）、当前锁条目 `running[]` |
| `POST /unlock?uuid=<同伴UUID>` | 清一个同伴的锁（表键或 `Running.companion` 匹配） |
| `POST /unlock?all=1` | 清全部锁 |
| `POST /reset-brain?uuid=<同伴UUID>` | **v1.2**：清该同伴的内置脑/任务槽（cancelFor + clearActiveTask + forget） |
| `POST /reset-brain?all=1` | **v1.2**：清所有同伴的内置脑/任务槽 |

清锁方式：先走 numen 公开 API `ServerPrograms.cutOff(uuid, programId, false)`（内部 `Program.cancel`），
再删 `RUNNING` 表项；比只删 Map 干净。动作尽量 `server.execute(...)` 到服务器线程。

**reset-brain 风险**：会取消同伴当前正在做的任务/consent（动作立即停止），但**不删实体、不掉背包**；
只在"内置脑任务卡死、unlock 无效"时使用。

端口可用 JVM 参数改：`-Dnumenlockfix.port=8768`。

### 2.2 日志（v2 最大的教训：静默 = 无法定位）

每条都打 `[numenlockfix]` 前缀：

```
[numenlockfix] v1.2.0 加载：目标=com.dwinovo.numen.program.ServerPrograms，外部清锁端口=127.0.0.1:8768
[numenlockfix] 反射成功：loader=...
[numenlockfix] brain 反射成功：loader=...
[numenlockfix] server started: foundClass=true RUNNING=0
[numenlockfix] death: uuid=... cleared=1
[numenlockfix] http unlock uuid=... all=false cleared=1
[numenlockfix] http reset-brain uuid=... all=false players=1 reset=1
```

如果 `foundClass=false`，日志会带每个类加载器的尝试链（`SimpleName→异常`），方便修反射目标。

## 3. 树侧怎么用（另见 docs/12 §10.12）

| 动作 | 命令 |
|---|---|
| 查状态 | `node src/cli.mjs lock` |
| 清单个 | `node src/cli.mjs lock --companion helper` |
| 清全部 | `node src/cli.mjs lock --all` |
| **清内置脑卡死** | `node src/cli.mjs lock --companion helper --reset-brain`（v1.2；不丢背包） |
| 清全部内置脑 | `node src/cli.mjs lock --all --reset-brain` |
| 自动 | 默认开启：慢观测连续被拒 **2 次**自动清锁（`tree.config.json` → `behavior.lockRecovery`） |
| MCP | `tree_control {op:"unlock"}` / `{op:"lock_status"}` |

## 4. 文件

```
patcher/
├─ src/numenlockfix/NumenLockFix.java   ← 全部逻辑
├─ src/META-INF/neoforge.mods.toml      ← mod 元数据（version 1.2.0）
├─ src/pack.mcmeta
├─ build.ps1                             ← 构建脚本（ASCII-only，PowerShell 5.1 友好）
└─ build/numenlockfix-1.2.0.jar          ← 产物
```

## 5. 构建

```powershell
cd E:\game\HMCL\numen-tree\patcher
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

依赖：JDK 21+、本机 NeoForge 1.21.1 库。编译 classpath 必须含：
- `neoforge-21.1.265-universal.jar` / `loader` / `bus`
- `client-1.21.1-...-srg.jar`（**真正的 Minecraft 类在这里**；版本目录里的 `1.21.1-NeoForge.jar` 只是启动壳）
- `brigadier-1.3.10.jar`

## 6. 安装 / 卸载 / 升级（⚠ 必须重启游戏）

**mod 只在 JVM 启动时加载 → 换 jar 后必须重启 Minecraft 才生效。**

```powershell
$mods = 'E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\mods'
Remove-Item "$mods\numenlockfix-1.1.0.jar"   # 旧版必须删，避免同 modId 冲突
Copy-Item 'E:\game\HMCL\numen-tree\patcher\build\numenlockfix-1.2.0.jar' $mods
```

卸载：删掉 `mods\numenlockfix-1.2.0.jar`，重启游戏。

## 7. 怎么确认生效

1. 重启游戏进存档；
2. 日志搜 `numenlockfix`：应看到 `v1.2.0 加载`、`反射成功：loader=...`、`brain 反射成功：loader=...`、`server started: foundClass=true`；
3. 树侧 `node src/cli.mjs lock` → `{"patch":"1.2.0","foundClass":true,"brainReady":true,...}`；
4. 终极验收：故意制造一次锁（或等死亡打断），连续 2 次被拒后树会自动 `lock_unlock`，同伴不用重建。
   （2026-11-08 01:24 已实测：杀树造锁 → `/status` 看到 orphan program → 新树 2 次被拒自动清锁，id/背包不变。）
5. 内置脑卡死验收：等 `instinct_stuck` 后 `node src/cli.mjs lock --companion bigWhale --reset-brain` → 应返回 `{ok:true, reset:1}`，树下一拍恢复观测。

**`/status.count` 语义**：是"当前在跑的程序数"，不是锁数——空闲 0、正常动作中 1 都正常；僵尸锁的表现是
"`count` 有值但树连续被拒"。`POST /unlock?all=1` 会 cancel 当前在跑的程序，别在正常动作中使用。

## 8. 风险

- 只做：清空静态 `RUNNING` / 删除指定 UUID 条目 / 调 `cutOff` cancel 程序。
- 控制端口只绑 `127.0.0.1`，无鉴权（本机调试用）；不需要可在 tree.config 关闭树侧调用，或用 `-Dnumenlockfix.port=0`？——目前不支持 0，改 tree 侧不调即可。
- 最坏情况（游戏起不来）：删掉 jar 即可恢复原状。

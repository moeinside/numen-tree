# Numen 脑树（numen-tree）

> 以下说明由大肥鲸自动生成，可能与实际行为有出入，一切以源码为准。

给 Minecraft 里的 Numen 同伴加一层**常驻的自动执行层**：LLM 只下目标，树负责查表执行、仲裁、上报。
一句话：**LLM 当指挥官，树当小脑，numen 自己的身体和反射照旧。**

仓库 <https://github.com/moeinside/numen-tree> · MIT 许可证 · 文档全在 [`docs/`](docs/)

---

## 1. 需要什么

| 组件 | 版本 | 说明 |
|---|---|---|
| **Minecraft** | **1.21.1** | 只支持这一个版本 |
| **NeoForge** | **21.1.265** | 最低 21.1.233 |
| **numen** | **0.1.4.1** | 同伴本体，`numen-neoforge-1.21.1-0.1.4.1.jar` |
| **numenlockfix** | **1.1.0** | 本仓库附带：[`mods/numenlockfix-1.1.0.jar`](mods/)。**必需**，见下 |
| **Node.js** | 18+（实测 v24.14） | 跑树进程 |
| JDK 21 | 仅重新编译补丁时需要 | 日常使用不需要 |

**为什么 numenlockfix 是必须的**：numen 用一张 JVM 静态表记录"哪个同伴正在跑程序"，切存档、树被杀、同伴死亡都会留下永远清不掉的锁 —— 表现是同一条命令反复被拒、同伴不听指挥，只能重建。这个补丁在启动/死亡时清表，并开一个 `127.0.0.1:8768` 本地端口给树用来自动解锁。它**不改 numen 本体**，删掉 jar 即完全回滚。详见 [mods/README.md](mods/README.md)。

---

## 2. 安装

**第一步：装 mod**（HMCL 版本隔离下的路径）

```
E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\mods\
├─ numen-neoforge-1.21.1-0.1.4.1.jar   ← numen 本体
└─ numenlockfix-1.1.0.jar              ← 本仓库 mods/ 里拿
```

放好后**重启游戏**（mod 只在启动时加载）。日志里能看到 `[numenlockfix] v1.1.0 加载`。

**第二步：确认前置**

- 进存档，至少有一个 numen 同伴在线；
- numen 的 MCP 服务在 `127.0.0.1:8765`。

**第三步：起树**

```powershell
cd E:\game\HMCL\numen-tree
node src/daemon.mjs          # 或双击 启动树进程.bat（会自动处理端口冲突）
```

---

## 3. 使用方法

```powershell
# 看状态：同伴在哪、在干什么、当前技能跑了多久
node src/cli.mjs status

# 技能卡列表（当前 25 个，加文件即扩展）
node src/cli.mjs skills

# 下目标（目标 = 技能 + 参数，树自己执行到结束）
node src/cli.mjs goal --companion tyrander --skill go_to --params-file probe\params-arrive.json

# 自然语言任务（M1 计划层：意图 → 配方 → 分步执行 → 阶段上报）
node src/cli.mjs task --companion tyrander --intent "把木头存了"
node src/cli.mjs task --companion tyrander --intent "回家过夜" --deadline 300

# 模式切换（每个同伴独立：survival / production / combat）
node src/cli.mjs control --companion tyrander --op mode --mode production

# 暂停 / 清队列 / 热重载技能卡 / 优雅退出（别用 taskkill，会留僵尸锁）
node src/cli.mjs control --op pause
node src/cli.mjs control --op clear
node src/cli.mjs control --op reload-skills
node src/cli.mjs control --op exit

# 地点簿（死亡点自动记；家/基地手动记）
node src/cli.mjs place list
node src/cli.mjs place record --name 家 --pos here --note 主人脚下的基地
node src/cli.mjs place find --query "上次死的地方"

# 锁：查 / 清单个 / 清全部（numenlockfix 提供能力，树侧自动清锁默认开启）
node src/cli.mjs lock
node src/cli.mjs lock --companion helper
node src/cli.mjs lock --all

# 看上报（需要大脑决策的事件）
node src/cli.mjs inbox --brain

# 不开游戏的离线回放测试
node probe/replay.mjs
```

树对 LLM 的 10 个 MCP 工具（`tree_goal` / `tree_task` / `tree_place` / `tree_control` 等）见 [docs/05-接口契约.md](docs/05-接口契约.md)。

### 端口

| 端口 | 用途 |
|---|---|
| 8765 | numen 的 MCP（游戏内提供） |
| 8766 | 树的控制 API（CLI 用） |
| 8767 | 树对 LLM 的 MCP 工具面 |
| 8768 | numenlockfix 本地清锁端口 |

所有参数（阈值、冷却、牵引绳、模式参数）都在 [`tree.config.json`](tree.config.json)。

---

## 4. 目录

```
numen-tree/
├─ src/         树本体：编排、执行通道、黑板、计划层、技能卡、地点簿、MCP 工具面
├─ mods/        numenlockfix 补丁 jar（必需）+ 说明
├─ patcher/     补丁源码（Java），需要改才动；产物已随 mods/ 提供
├─ probe/       探针脚本 + 离线回放测试（不开游戏也能跑）
├─ tools/       能力审计工具 + 实时树图可视化（treeview）
├─ lines/       台词库数据
├─ docs/        架构、接口契约、维护手册、交接记录、Lua API 速查
├─ tree.config.json   所有可调参数
└─ 启动树进程.bat / 启动树监控.bat
```

**不随仓库提供**（运行时产物，已写进 `.gitignore`）：`logs/`（trace 日志）、`places.json`（地点簿，跟存档走）、`patcher/build/`、`node_modules/`。

---

## 5. 文档索引

新接手先读 **[docs/14-交接-2026-11-08.md](docs/14-交接-2026-11-08.md)**。

| 文档 | 内容 |
|---|---|
| [docs/01-需求与架构.md](docs/01-需求与架构.md) | 分层、数据流、执行模型、三模式 |
| [docs/05-接口契约.md](docs/05-接口契约.md) | MCP 工具、上报格式、技能契约 |
| [docs/10-numen-Lua-API速查.md](docs/10-numen-Lua-API速查.md) | numen 的 Lua API 全签名 + 实测坑 |
| [docs/12-全功能树设计-M1.md](docs/12-全功能树设计-M1.md) | 计划层、配方表、中断/恢复表 |
| [docs/13-Windows-PowerShell踩坑总表.md](docs/13-Windows-PowerShell踩坑总表.md) | 本机 PowerShell 坑 |
| [docs/21-Git与GitHub上手.md](docs/21-Git与GitHub上手.md) | 不会 Git 就看这篇 |
| [mods/README.md](mods/README.md) | numenlockfix 安装/卸载/验证 |
| [patcher/README.md](patcher/README.md) | 补丁原理、构建、风险 |

---

## 6. 三条硬边界

1. **不动 numen 本体** —— 不反编译、不改它的文件；唯一例外是独立的僵尸锁补丁，删 jar 即回滚。
2. **一个同伴同一时间只被一个驱动者控制** —— 单 Lua 程序槽，双开会互相锁死。
3. **树不做判断** —— 查表 + 固定规则，语言只查表不生成，对话归 LLM。

## 7. 许可

[MIT](LICENSE)。第三方 mod（numen、NeoForge、Minecraft）版权归各自作者。

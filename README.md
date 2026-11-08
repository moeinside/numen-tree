# Numen 脑树（numen-tree）

给 Minecraft 里的 Numen 同伴加一层**常驻的自动执行层**，让 LLM 从"逐步微操"退回"只下目标"。

> 一句话：**LLM 当指挥官，树当小脑，numen 的身体和反射照旧。**

**接手请先读 👉 [docs/09-交接-2026-11-07.md](docs/09-交接-2026-11-07.md)**（现状、下一步、坑）

---

## 1. 一句话现状

树进程能跑：下目标 → 执行 → 上报；M1 起支持**意图 → 计划 → 分步执行 → 阶段上报**（配方表 + 中断表 + 恢复表，加行为只加数据）。
支持 **survival / production / combat** 三种模式（按同伴独立切换）和**多同伴并发**；LLM 通过 10 个 MCP 工具指挥（含地点簿 `tree_place`、计划任务 `tree_task`），不直接写 Lua。

---

## 2. 五分钟上手

前置：游戏已启动（numen MCP 在 `127.0.0.1:8765`），至少一个同伴在线。

```powershell
cd E:\game\HMCL\numen-tree

# 1) 起树（双击 启动树进程.bat 也可以）
node src/daemon.mjs

# 2) 看状态
node src/cli.mjs status          # 同伴在哪/在干什么/当前技能已运行秒数/上一步
node src/cli.mjs skills          # 16 个技能卡
node src/cli.mjs lines           # 台词库
node src/cli.mjs inbox --brain   # ★ 需要大脑决策的上报

# 3) 下目标
node src/cli.mjs goal --companion tyrander --skill go_to --params-file probe\params-arrive.json

# 4) 切模式 / 暂停 / 清队列
node src/cli.mjs control --companion tyrander --op mode --mode production
node src/cli.mjs control --companion tyrander --op pause
node src/cli.mjs control --companion tyrander --op clear

# 5) 地点簿（死亡点自动记；家/基地/矿洞手动记）
node src/cli.mjs place list
node src/cli.mjs place record --name 家 --pos here --note 主人脚下的基地
node src/cli.mjs place find --query "上次死的地方"

# 6) 计划任务（M1：模糊意图 → 配方 → 分步执行）
node src/cli.mjs task --companion tyrander --intent "把木头存了"
node src/cli.mjs task --companion tyrander --intent "回家过夜" --deadline 300
node src/cli.mjs status          # 会显示"计划 X 第 N/共 M 步（当前步 Y）"

# 7) 离线回放测试（不开游戏）
node probe/replay.mjs

# 8) 改完技能卡热重载 / 优雅退出（不要 taskkill，会留僵尸锁）
node src/cli.mjs control --op reload-skills
node src/cli.mjs control --op exit
```

| 端口 | 用途 |
|---|---|
| 8765 | numen 的 MCP（游戏内） |
| 8766 | 树的控制 API（CLI 用） |
| 8767 | 树对 LLM 的 MCP 工具面 |

---

## 3. 目录

```
numen-tree/
├─ README.md                  ← 本文件
├─ 启动树进程.bat             双击起树（自动处理端口冲突）
├─ tree.config.json           所有可调参数
├─ docs/
│  ├─ 01-需求与架构.md         分层、数据流、执行模型、牵引绳、三模式
│  ├─ 02-探针记录.md           mod 内部结构、实测数据、僵尸锁分析
│  ├─ 03-维护手册.md           环境、启停、故障处置、变更记录
│  ├─ 04-可扩展性设计.md       技能卡 / Lua 模块 / NumenPlugin 三层扩展点
│  ├─ 05-接口契约.md           9 个 MCP 工具、上报格式、技能契约、地点簿
│  ├─ 06-路线图.md             阶段与状态
│  ├─ 07-DSH配置变更记录.md    所有项目外改动 + 回滚方式
│  ├─ 08-试验记录-三模式与多同伴.md
│  ├─ 09-交接-2026-11-07.md    ★ 交接快照
│  ├─ 10-numen-Lua-API速查.md  ★ Lua API 全签名 + 实测坑
│  ├─ 11-行为树打磨记录-2026-11-07晚.md  ★ 规则表/觅食/战斗/地点簿/踩坑
│  ├─ 12-全功能树设计-M1.md    ★ 计划层/配方/中断/恢复表 + 验收
│  ├─ 13-Windows-PowerShell踩坑总表.md  ★ 本机 PowerShell 坑速查
│  └─ 14-交接-2026-11-08.md    ★★ 新会话先读这份
├─ places.json                地点簿（死亡点/基地/自定义地点，运行时生成）
├─ src/
│  ├─ daemon.mjs              编排 + 控制 API（含 /places）+ 动态发现同伴
│  ├─ lane.mjs                每同伴一条执行通道（观测/仲裁/执行/事件）
│  ├─ numen.mjs               numen MCP 客户端 + 回执解析
│  ├─ state.mjs               黑板 / 目标栈 / 收件箱
│  ├─ places.mjs              地点簿：持久化 + 模糊解析
│  ├─ lines.mjs               台词库（纯数据+机械选择）
│  ├─ mcpserver.mjs           对 LLM 的 9 个工具
│  ├─ trace.mjs               jsonl 留痕
│  └─ skills/                 16 个技能卡（自动发现，加文件即扩展）
├─ lines/                     台词库数据（default.json + 人设覆盖）
├─ patcher/                   僵尸锁补丁 mod（numenlockfix）
├─ probe/                     探针脚本（只读为主）
└─ logs/                      trace-YYYYMMDD.jsonl
```

---

## 4. 名词表

| 词 | 含义 |
|---|---|
| **大脑** | 常驻的 LLM 会话（DSH）。定目标、说话、处理异常 |
| **右脑** | 一次性子 agent。无状态、纯推理、只返回数据（尚未实现） |
| **树 / 小脑** | 常驻外部进程。查表执行、仲裁、目标栈、哨兵、trace |
| **脊髓** | mod 内置反射（逃跑、脱困、落地缓冲），不经树 |
| **同伴** | Numen 的 NPC 实体，各自有独立 Lua 执行槽 |
| **技能卡** | 树里一个可执行技能：`can_start` / 执行 / 失败码 |
| **宏计划** | 几个技能卡的固化组合（尚未实现） |
| **模式** | survival / production / combat，按同伴独立 |
| **牵引绳** | 离主人太远自动往回走 |
| **台词库** | 机械播报用的数据表，运行时只查表不生成 |
| **唤醒源** | 允许把 LLM 叫醒的封闭事件清单 |

---

## 5. 三条硬边界

| 边界 | 说明 |
|---|---|
| **不动 numen 本体** | 不反编译、不改它的文件。唯一例外：僵尸锁补丁 mod（独立 jar，删掉即回滚） |
| **一个同伴同一时间只被一个驱动者** | 单 Lua 程序槽，双开会互相锁死 |
| **树不做判断** | 查表 + 固定规则；语言只查表不生成；对话归 LLM |

---

## 6. 设计原则（摘要，全文见 docs/01）

1. 树是"自动"不是"自主"。
2. LLM 只有目标权/否决权/时间权，没有逐步指挥权。
3. 树掌握节拍，永不等 LLM。
4. 下行写目标、上行读事件，两条单向通道。
5. 汇报 = 分类 + 事实，不给建议。
6. 报了 = 已停手等你；只有求助推，其余拉。
7. 贵的思考外包给右脑，结果沉淀成宏计划（待做）。

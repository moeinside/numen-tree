# numen 底层能力审计（树的地基）

> 目标：在写"战术包/战略包"之前，先把 **numen MCP / Lua API** 这一层摸清：
> 哪些能力强、哪些坑、哪些应该由树自己组合替代、各自服务哪个优先级。
> 本文只做记录与判定；**未改任何代码**。
> 相关：`docs/10-numen-Lua-API速查.md`（API 签名与实测坑）、`docs/18-numen能力/`（**全量能力表：9 个 MCP 工具 + 87 个 Lua 函数 + 分组小文件**）、`docs/19-战术包第一批.md`（原子注册表 + 8 个战术包数据表）、`docs/15`（双策略/任务变换）、`docs/16`（treeview，忽略）。

## 0. 术语（本文统一口径）

| 术语 | 含义 |
|---|---|
| **原子动作** | 一次 Lua 程序，几秒内返回，只做一件事；对应 numen 的 1~N 个只读/单写 API |
| **战术包** | 若干原子动作 + 局部成功条件 + 重试；解决"一件事"（如"挖一格""吃一口"） |
| **战略包** | 目标 + 验收标准 + 预算 + 降级策略 + 优先级；解决"一个意图"（如"找吃的""建基地"） |
| **唯一槽** | 每个同伴同时只能跑一个 Lua 程序；观察与动作共用此槽；事件通道（get_events）不占槽 |
| **委托** | 树直接调用 numen 提供的现成能力 |
| **替代** | 树用更底层的 API 自己组合（拿回决策/抢占/可靠性） |

**判定准则**：
- 委托：单步、可靠、时长可控、属于物理/UI 引擎层；
- 替代：内部含决策、返回值不可靠、会卡死/不可打断、混合多件事导致无法抢占。

## 1. 表 1：numen API 能力清单

> 状态列：✅ 已知可用 / ⚠️ 有坑 / ❓ 待实测。
> "占槽"：一次调用平均占用唯一槽的时长。

### 1.1 只读/查询类（不改变世界）

| API | 内部行为 | 占槽 | 可靠性 | 判定 | 优先级相关 |
|---|---|---|---|---|---|
| `numen.status.self()` | 读自身状态（位置/血/饥饿/维度/朝向） | 毫秒 | ✅ | 委托（原子） | P0/P1 感知 |
| `numen.status.world()` | 时间/天气/亮度等 | 毫秒 | ✅ | 委托（原子） | P0/P1 感知 |
| `numen.status.owner()` | 主人位置/在线/距离 | 毫秒 | ✅（主人死亡时仍在线） | 委托（原子） | P0/P1/回归 |
| `numen.task.status()` | 当前任务状态 | 毫秒 | ✅ | 委托（原子） | 观测 |
| `numen.scan.block(cell)` | 单格 BlockInfo（含 in_reach） | 毫秒 | ✅ | 委托（原子） | P0/P1/P4 |
| `numen.scan.blocks(ids,{radius})` | 找方块簇 | 毫秒~几十 ms | ✅（半径越大越慢） | 委托（原子，但限半径） | 感知/生产 |
| `numen.scan.entities(type,{radius})` | 扫生物/掉落物 | 毫秒~几十 ms | ✅ | 委托（原子，但限半径） | **P0/P1 感知核心** |
| `numen.scan.cluster(blocks)` | 方块列表→簇（模块函数） | 微秒 | ✅ | 委托（原子） | 感知 |
| `numen.scan.container(cell)` | 不开箱读容器内容 | 毫秒 | ✅ | 委托（原子） | P4 生产 |
| `numen.scan.map({radius})` | 俯视地形图 | 几 ms~几十 ms | ✅ | 委托（原子，限半径） | 移动前感知 |
| `numen.scan.sight(target)` | 视线/遮挡判断 | 毫秒 | ✅ | 委托（原子） | 感知 |
| `numen.inv.count/item(...)` | 背包计数 | 微秒 | ✅ | 委托（原子） | 感知/合成 |
| `numen.api.help(...)` / `numen.module.list()` | 读 API 文档 | 毫秒 | ✅ | 开发期 | — |

**关键结论**：观察=只读 API，但**依然要占用唯一 Lua 槽**（树现在用 1.2s/3.6s 两档观察程序）；因此"边跑长动作边轮询扫描"不可行。

### 1.2 单次写/装备/交互类

| API | 内部行为 | 占槽 | 可靠性 | 判定 | 优先级 |
|---|---|---|---|---|---|
| `numen.work.dig(cell)` / `work.dig(Block)` | 挖**单格**（不走路、不捡） | 单块挖掘时长 | ✅ 基本可靠；不捡 | 委托（原子） | P4 生产 / P0 逃生（挖墙） |
| `numen.build.place(...)` 单块 | 放一块 | 毫秒~秒 | ✅（需材料/支撑） | 委托（原子） | P4 生产 / P0 垫脚 |
| `numen.gear.hold(item)` | 换手持 | 毫秒 | ✅ | 委托（原子） | P0/P1 战斗 |
| `numen.inv.eat(item)` | 吃一口 | 秒级 | ✅（背包要有食物） | 委托（原子） | **P0 生存** |
| `numen.inv.make(item,count)` | 合成；**自动找最近台子，不换台** | 秒级（含找台） | ⚠️ 打不开的台会失败 | 部分替代（3×3 链由树控制）；基础合成可委托 | P4 |
| `numen.use.block(cell)` / `gui.*` | 开容器/操作 GUI | 秒级 | ✅（但 GUI 细节多） | 委托（UI 层不重写） | P4 |
| `numen.fight.attack(target)` | 攻击指定目标（自动选武器） | 秒级/次 | ⚠️ 不会捡掉落物 | 委托（单次攻击原子），战斗循环由树写 | **P0/P1** |
| `numen.move.to(pos,{...})` | 走到目标；内部寻路 | 取决于距离 | ⚠️ 远距/复杂地形会很久 | **有条件委托**：必须限距/限时，否则当战术包 | 所有层级 |
| `numen.move.go(...)` | 长距离导航（**detached**） | 不可控，可能几分钟 | ⚠️ 分离任务，超时后仍在跑 | **替代或"可急刹的预制包"**：detach 不可控，必须能 cutOff | 移动/回家 |
| `numen.work.collect(...)` | 走进范围内掉落物捡起 | 取决于范围 | ⚠️ 可能 no_path | 战术包（限半径 4~8） | P4 / P0 捡食物 |
| `numen.work.mine(cluster)` | 走+挖+捡（复合） | 几十秒 | ⚠️ **返回值不可靠**（实测挖到但返回 nil） | **替代**：scan.cluster + move.to + dig + collect 组合 | P4 |
| `numen.inv.smelt(furnace,...)` | 放燃料/烧/等/取 | 等烧完（几十秒） | ✅ 但慢 | 战术包（分"放料/等/取"） | P4 |
| `numen.inv.fetch(pos,item,count)` | 走+开箱+取+关（复合） | 几秒~几十秒 | ⚠️ 依赖路径/容器 | 替代（先 scan.container + move + gui）或暂委托 | P4 |

### 1.3 环境/任务/其他

| API | 说明 | 判定 |
|---|---|---|
| `numen.task.timer(...)` | **会打断当前程序，禁用**（docs/10 坑） | 禁用 |
| `numen.task.cancel/...` | 任务取消 | 仅急刹流程用 |
| 事件通道 `get_events` | 独立 MCP 会话，**不占 Lua 槽** | 委托（P0/P1 报警来源） |

## 2. 表 2：事件通道清单（待补全）

已知（树 trace 里见过的）：

| 事件 | 含义 | 可作肾上腺素触发？ |
|---|---|---|
| `reflex` | mod 自带"打不过就跑"反射 | ✅ 强候选（已有威胁判断） |
| `hungry` | 饥饿告警 | ✅ P0（吃） |
| `death` | 同伴死亡/复活 | ✅ P0 |
| `owner_query` | 主人对话 | 信息类 |
| `task_finished/task_failed` | 任务状态 | 观测类 |
| `leash` | 牵引绳触发 | 策略类 |

**待实测**：受击事件？血量骤降？敌对接近？夜间？主人受伤？——决定肾上腺素靠事件还是靠轮询。

## 3. 表 3：现有 25 个技能分类（初步，待审计确认）

| 分类 | 技能 | 说明 |
|---|---|---|
| **只读原子** | `scan_ground`、`find_block` | 纯查询，毫秒级 |
| **单写原子** | `equip`、`eat`、`place_block`（单块）、`dig_cells`（若≤2格） | 短 |
| **短移动原子** | `go_to`（限 1 段/几格）、`approach_owner`（限 1 段）、`follow_owner`（1 段）、`retreat`（1 段） | 需要限距/限时才算原子 |
| **战术包（可保留）** | `collect_items`（限半径）、`idle` | 短循环 |
| **必须拆** | `mine_nearby`、`dig_nearby`、`forage`、`seek_food`、`craft`（chain）、`smelt`、`fetch_items`、`store_items`、`place_build`、`pave_forward`、`fight_nearest`、`fight_safe`、`explore` | 内部多步/长等待，需拆成原子+战术包 |
| **特殊** | `pave_forward` | 已接近"战术包"（走+垫），但内部循环长，需分段 |

## 4. 表 4：原子动作 ↔ 优先级映射（草案）

| 优先级 | 原子动作例子 |
|---|---|
| P0 救命 | 撤退（短撤）、吃一口、换武器、跳/垫脚离开岩浆、挖一格脱困 |
| P1 应急 | 攻击一次、面向威胁、短距离拉开、吃（非濒死） |
| P2 LLM 覆盖 | 任意战术包的首个原子（由 LLM 指令触发） |
| P3 战略目标 | 移动段、挖、放、捡、合成、熔炼 |
| P4 自主生产 | 同上，但由树自主发起 |
| P5 待命 | idle、巡逻移动段 |

## 5. 表 5：第一批战术包候选（审计后开工）

1. `tactic.move_segment`：一次短移动（限格数/秒数）
2. `tactic.dig_one`：走到 1 格旁 + 挖 + 捡
3. `tactic.eat_one`：从背包选食物 + 吃一口
4. `tactic.flee`：选远离威胁方向 + 连续短撤（限次数）
5. `tactic.attack_one`：选目标 + 攻击 + 检查是否死亡
6. `tactic.collect_near`：小半径捡掉落
7. `tactic.come_home`：回家（短移动段 ×N + 到达判定）
8. `tactic.find_food`：扫被动生物 → 接近 → 攻击 → 捡 → 吃（组合）

## 6. 需要实测的实验清单（开发期可随便占同伴）

| # | 实验 | 目的 | 判定 |
|---|---|---|---|
| 1 | `numen.module.list()` + `numen.api.help` 关键组 | 补全 API 清单/内部说明 | 文档 |
| 2 | 观察事件通道：连续记录 `get_events` 的 kind | 事件清单（肾上腺素触发源） | 文档 |
| 3 | `work.dig` 单格：返回值/耗时/是否捡 | 确认原子性 | 数据 |
| 4 | `work.mine(cluster)`：返回值 vs 背包差 | 确认不可靠 | 数据 |
| 5 | `move.to` 限距（3/6/10 格）耗时与失败率 | 定"短移动"上限 | 数据 |
| 6 | `move.go` detach 后 `unlock` 能否真停 | **急刹可行性** | 关键结论 |
| 7 | `inv.make` 遇"打不开的台"行为 | 合成链容错 | 数据 |
| 8 | `work.collect` 半径 4/8 的耗时/失败率 | 定捡拾上限 | 数据 |
| 9 | `inv.smelt` 全流程耗时/中断后状态 | 是否拆"放料/等/取" | 数据 |
| 10 | `fight.attack` 单次攻击耗时/返回 | 战斗原子化 | 数据 |
| 11 | `inv.fetch` 失败率/耗时 | 委托还是替代 | 数据 |
| 12 | `scan.blocks/entities` radius 8/16/32 耗时 | 感知切片预算 | 数据 |

**实验纪律**：只读优先；需要动作的实验用固定坐标 + 重建同伴；每次实验记录到本文对应行（补"实测"列）。

## 7. 数据格式：可扩展性约定（战术包/战略包）

原则：**数据表 + 版本号 + 未知字段容忍 + op 注册表**；先支持最小集，之后只加不改。

```jsonc
{
  "schemaVersion": 1,
  "kind": "tactic",              // tactic | strategy
  "id": "tactic.dig_one",
  "title": "挖一格并捡起",
  "priorityClass": "P4",         // P0~P5
  "owner": "tree",               // tree | llm
  "preempt": "soft",             // hard | soft | none
  "budget": { "maxSeconds": 12, "maxRetries": 2 },
  "success": { "op": "inventoryDelta", "item": "*", "min": 1 },   // 条件用数据描述
  "steps": [
    { "op": "scan.block", "cell": "$target" },
    { "op": "move.to", "target": "$target", "maxDistance": 3 },
    { "op": "work.dig", "cell": "$target" },
    { "op": "work.collect", "radius": 4 }
  ],
  "onFail": { "no_path": "retry", "out_of_reach": "abort" },
  "ext": {}                      // 预留：未来字段放这里，旧执行器忽略
}
```

**扩展便利性保证**：
1. `schemaVersion` 递增；执行器只认自己支持的版本，低版本数据可降级；
2. `steps[].op` 用**注册表**（op → 执行函数），新增 op 不动调度器；
3. 未知 `op` / 未知字段：加载时警告并跳过该步骤（或整体拒绝），**不崩溃**；
4. 条件（success/onFail）也走"op"形式，不用裸 JS；
5. `ext` 自由区 + `capabilities` 声明（需要哪些能力，换游戏时校验）；
6. 数据文件旁边配 JSON Schema，加载时校验并给出可读错误。

## 8. 可观测性契约（treeview 兼容性）

> 用户要求：新版本的树仍然能用 treeview 实时观察。结论：**能，但要守契约**。treeview 只依赖下面这份"监控契约"，树主干不依赖 treeview。

### 9.1 契约分三层

| 层 | 内容 | 谁负责 |
|---|---|---|
| 静态模型 | `src/recipes.mjs`、`interrupts.mjs`、`schedule.mjs`、`crafttree.mjs`、`skills/*`（未来加 `tactics.mjs`、优先级表） | 树（数据文件）；treeview 的 `model.mjs` 适配 |
| 运行态 `/status`（8766） | 每个 companion 的稳定字段：`name/id/pos/hp/hunger/mode/paused/schedule`、`plan{id,recipeId,status,cursor,steps_done,steps_total,source}`、`goals[]`、`current{skill}`、`lastAction{skill,ok,kind}` | 树保证"旧字段存在或保留别名" |
| 事件 trace | 至少保留 `kind/companion/note`；**建议新增结构化字段** `data`（goal/skill/recipe/step/tactic/atom/priority），treeview 优先读结构化字段 | 树；treeview 兼容解析 |

### 9.2 重构期兼容策略

1. **不删旧字段**：新架构新增 `strategy/tactic/atom/priorityClass` 字段，但保留 `plan.cursor`、`current.skill`、`lastAction.skill` 作为**兼容别名**（映射到当前原子/战术）；
2. **事件增加结构化 `data`**：trace 行里加 `data:{goalId, skill, recipeId, step, tacticId, atomOp, priorityClass, ok, kind}`，旧 note 继续保留；treeview 先读 data，读不到再退回解析 note；
3. **modelVersion 继续用**：任何模型/契约变化 `modelVersion+1`，treeview 自动重拉；
4. **treeview 适配层同步**：主干加新数据文件时，treeview 的 `model.mjs` 加对应节点/边，`app.mjs` 加新节点类型/颜色/路径映射（`MAINTENANCE.md` 已写"新增节点类型"步骤）；
5. **契约变更纪律**：改 `/status` 或 trace 格式 = 必须同时更新 `docs/17 §9` + treeview 适配，否则算破坏监控（新增优先、旧字段缓删）。

### 9.3 重构后 treeview 要补的（小改）

- 新节点类型：`strategy`（战略包）、`tactic`（战术包）、`atom`（原子动作）；
- 路径高亮从"步骤/技能"扩展到"原子/战术"，优先级用颜色区分（P0 红→P5 灰）；
- 事件解析切换为结构化 `data`；
- 失败标记继续沿用（对 atom/tactic 节点都生效）。

### 9.4 结论

treeview 与主干是"适配器关系"：**主干可以大改，只要监控契约在/有兼容别名，treeview 只需小改适配层**，不会成为重构阻碍；反之，重构期间若改坏契约，会立刻在监控上表现为"页面失明"——所以把它作为开发 checklist 的一项。

---

## 9. 首轮实验结果（2026-11-08 15:0x，独占 Lua 槽）

> 环境：重建 companion（HP20/饥饿20），树临时停止，直接走 numen MCP；MCP 基础往返 ≈ 94ms。
> 原始记录：`docs/18-data/experiments.jsonl`；判定列已回填 18 个函数到 `capabilities.jsonl`。

| 实验 | 结果 | 结论 |
|---|---|---|
| baseline | 83~100ms（3 次） | MCP 往返 ~0.1s；所有 API 耗时要扣这个底 |
| status 读取 | 299ms（3 API + 返回） | 只读便宜，但**占唯一槽** |
| `scan.blocks`+`scan.entities` | r4=255ms, r8=307ms, r16=486ms, r32=454ms | 半径 32 内可接受；感知切片预算 ~0.3~0.5s |
| `scan.map` | r4/8/16 ≈ 150ms | 很便宜 |
| `scan.block` 字段 | `... name=minecraft:grass_block, hardness, in_reach ...` | **BlockInfo 用 `.name` 不是 `.id`** |
| `work.dig` 单格 | 1.7s（泥土手挖），ok=true，掉落会到脚下并被自动拾取 | **可当原子**（单格）；不走路 |
| `work.mine` 小簇（1 格） | 1.9s，返回 1，背包 +1 | 小簇可用 |
| `work.mine` 大簇（dirt cluster） | **120s 超时未返回** | 大簇不可控 → 树应替代/拆开 |
| `move.to` 3/6/10 格 | 356 / 1103 / 1789ms；`arrive="near"` 停在 ~3 格外 | 短距可当原子；需限距/限时 |
| `move.go`（30~40 格） | 地形 `no_path` 快速失败；未成功触发 detach | 仍需专门测 detach |
| **cutOff 对在跑程序** | `wait(15)` 起跑 1s 后补丁 unlock：`cleared=1`；Lua 回执 `detached`（"this turn was cut off; t906 keeps running"）；**随后新 Lua 调用 100ms 返回** | **急刹可行：槽立即释放**；被切的任务会由"新身体动作"替换/停止（事件 task_finished 停止原因 "a newer body action replaced it"） |
| `inv.make` 无材料 | 返回 `no_material`（缺 3 木板 2 木棍） | 报错可读，可据此做前置检查 |
| 事件通道 30s（空闲） | 只收到 1 条 `task_finished` | 空闲时无环境事件；受击/危险事件仍需专项采集 |
| `move.explore` | `bad_argument: needs until_ = a function` | 调用必须传 `until_` 回调 |

**首轮关键结论**：
1. **急刹（cutOff）确实能把唯一槽抢回来**——这是"长动作可打断"的底牌；
2. `work.mine` 的耗时完全取决于簇大小（小簇秒级、大簇无上界）→ 不能当固定原子，必须由树按簇大小拆；
3. 感知（scan/status）便宜但同样占槽 → 观察必须"合并成一次 + 塞在动作之间"；
4. `BlockInfo.name`、`inv.count(item)`、`move.explore(until_)` 这类字段/参数坑要写进能力表（已回填备注）。

**剩余实验（下一轮）**：`inv.smelt` 全流程、`inv.fetch`/容器（需要先有材料/箱子，延后）、事件专项采集（受击/低血/敌对）。

### 9.1 第二轮实验（detach / collect / fight）

| 实验 | 结果 | 结论 |
|---|---|---|
| `move.go` detach + 急刹（专项） | 新重建后 plan OK（+20 格）；跑 1s 后 `unlock` → `cleared=1`，Lua 回执 `detached`（"this turn was cut off; t918 keeps running"）；**位置采样：-10.07 → 1.87 → 2.57**；随后 `task.status=nil`，新 Lua 100ms | **急刹能释放槽，但分离任务可能继续推身体一段** → 急刹后必须发一个短"settle"动作替换它并确认位置稳定，再派新目标 |
| `work.collect` r4 / r8 | 1014ms / 2446ms，`ret=1 delta=1` | 小半径可当原子；返回捡到数量 |
| `fight.attack`（目标 27.6 格） | `not_found — none of the requested entity ids could be attacked` | **只打可达目标、不走路**；必须先 move 到攻击距离 |
| `inv.drop` 签名 | `drop(item,{count=n})`，不是 `(item,count)` | 坑（已回填备注） |
| `scan.blocks` 结构 | Cluster.count=1610（半径16 多类方块连成一片）；Block 只有 `.name` + `.pos{x,y,z}` | 大簇=上千块 → `work.mine` 必超时；挖单格用 `.pos`，别用 `.x` |

**设计含义**：
1. 预制战术包（`work.mine`/`move.go`）要么树替代，要么必须配"急刹 + settle"；
2. `move.go` 的 detach 残留必须处理：cutOff 后先跑短观测/身体动作把残留任务顶掉，再继续；
3. 大范围 `scan.blocks` 会返回上千块的簇，**不要直接交给 `work.mine`**，要树自己按"最近单块"拆。

---

## 10. 待补充 / 下一步

- [ ] 实测表（第 6 节 12 个实验）
- [ ] 补全表 2 事件清单
- [ ] 用实测结果修正表 1 的"判定"
- [ ] 产出"25 技能重分类"最终版
- [ ] 然后才写第一批战术包（第 5 节）

# 离线回放测试（probe/replay.mjs）说明

不开游戏、不连 MCP、不写 `logs/`、不碰真实 `places.json` / `world.json`，
用打桩的 numen 驱动**真实的 Lane / Planner / PlaceBook / WorldMemory**，回归 M1 的
仲裁（自动开计划）、计划推进、中断抢占、上报预算、状态字段。

## 跑法

```bash
node probe/replay.mjs                  # 跑全部 6 个场景；全过 exit 0，有失败 exit 1
node probe/replay.mjs --only=hungry    # 只跑一个（可逗号分隔：--only=hungry,night）
node probe/replay.mjs --list           # 列出场景 id / 标题
node probe/replay.mjs --dump           # 每个场景额外打印 inbox / trace / planHistory / state
```

6 个场景（`probe/fixtures/*.mjs`）：

| id | 覆盖 |
|---|---|
| `hungry` | 饥饿且没吃的 → 仲裁自动开 `feed` → eat/forage/seek 两轮 → `starving` 上报 + `survivalHaltedUntil` |
| `eat_first` | 有吃的 → `feed` 一步 eat 成功 → 计划 `done`；auto 计划 `plan_done.needsBrain=false`，无 `goal_done` |
| `low_hp` | hp 8/20 + 敌对 → `near_death` 中断派 `retreat`（单技能，不误开计划） |
| `night` | 夜间+有敌 → `night_danger` 中断开 `go_home`；`go_to` 解析地点簿"家"坐标 → `hold` → `doneWhen` 天亮正常结束 |
| `stuck` | `go_to` 返回 `no_path` → 真实代码设 `stuckSince` → 回拨 50s → `stuck` 中断 + 上报 + 停手 |
| `death` | 计划在跑时事件流给 `death` → 计划 `ABANDONED`、地点簿多一条 `kind=death`、inbox `death` |

## 实现结构（replay.mjs）

- `FakeNumen.lua(companion, code, timeoutMs)`：按 **Lua 代码特征**识别技能（`classifyLua`），
  - 观测程序（含 `animal_n` + `numen.status.self`）→ 返回 fixture 的下一条 `observations`（弹完用最后一条兜底）；
  - 技能程序 → `fixture.results(ctx, skill, callIndex)` 决定返回 `{ok:1,...}` / `{ok:0,kind,msg}`，
    也可直接返回回执信封（如 `{kind:'text', message:'a program is already running...'}` 模拟槽被占）；
  - 所有调用记进 `ctx.luaCalls`，断言可查"调了哪个技能、返回了什么"。
- `FakeEvents.events()`：`fixture.eventsWhen(ctx)` 成立时投递 `fixture.events` 一次，否则空 + sleep 20ms 防空转。
- `MemoryTrace`：只进内存（`ctx.traceOf(kind)`），**不实例化 Trace、不写 logs/**。
- 真实组件：`CompanionState / Lane / Planner(RECIPES) / Inbox / PlaceBook / WorldMemory`；
  `cfg` 来自 `loadConfig()` 再覆盖：`loop.tickMs=8`、`lines.enabled=false`、
  `places.file` / `worldmem.file` 指到 `fs.mkdtempSync(os.tmpdir())`，跑完 `rmSync`。
- 驱动：`lane.start()` 后每 1ms 轮询 `state.lastTickAt`，**确认本 tick 稳定结束**才调
  `fixture.onTick` / `fixture.done`（避免和 tick 的 await 抢跑）；`maxTicks` / `timeoutMs` 兜底，结束 `lane.stop()`。

## 加一个新 fixture（只加数据，不动 replay.mjs）

1. 新建 `probe/fixtures/<id>.mjs`，`export default { ... }`；
2. 在 `probe/replay.mjs` 顶部 `import`，并加进 `FIXTURES` 数组（唯一需要改 replay.mjs 的地方）；
3. fixture 字段：

| 字段 | 作用 |
|---|---|
| `id` / `title` | 场景标识与标题 |
| `observations` | 观测队列；每次 Lane 观测弹一条，弹完复用最后一条（用来模拟环境变化） |
| `observation(ctx, n)` | 可选，函数式观测（比队列更灵活，如按 tick 动态改） |
| `results(ctx, skill, callIndex)` | 技能回执：`{ok:1,...}` 成功 / `{ok:0,kind,msg}` 失败 / `{kind:'text',...}` 回执信封 |
| `places` | 预置地点簿（每项同 `PlaceBook.record` 参数，如 `{name:'家',kind:'base',...}`） |
| `setup(ctx)` | 启动前预置：`ctx.lane.startPlan(...)`、`ctx.state.stuckSince=...`、`ctx.state.mode=...` 等 |
| `events` / `eventsWhen(ctx)` | 事件流；`eventsWhen` 为真时投递一次（death 场景用它等计划跑起来） |
| `onTick(ctx)` | 每个 tick 结束后调用（改环境、记证据、countdown 等） |
| `done(ctx)` | 提前结束条件；没有就跑到 `maxTicks` / `timeoutMs` |
| `maxTicks` / `timeoutMs` | 默认 300 tick / 15000ms |
| `cfg` | 可选，深合并进 cfg（如改 `behavior.survival.*` 阈值） |
| `check(ctx) → [{name,ok,detail}]` | 断言数组；用 `_common.mjs` 的 `check()`（硬）/ `soft()`（警告） |

ctx 上常用助手：`ctx.state`、`ctx.inbox`、`ctx.traceOf(kind)`、`ctx.inboxOf(kind)`、
`ctx.skills()`、`ctx.countSkill(id)`、`ctx.plan()`（=planHistory[0]）、`ctx.places`、`ctx.luaCalls`、`ctx.evidence`。

`_common.mjs`：`obs({...})` 造完整观测、`ok(data)` 成功回执、`fail(kind,msg)` 失败回执、
`check(name,cond,detail)` 硬断言、`soft(...)` 软断言（**不计入 PASS/FAIL**，只打 ⚠，
用于标记"与 docs/12 不符、但当前 src 就是这样做"的已知问题，src 修好后会自动变 ✓）。

## 已知偏差（当前 src，⚠ 软断言；src 修好后升级成硬断言）

1. **`plan.mjs` 的 `cloneSteps` 丢字段**：没复制 `escalate`，配方里 report 步的 `escalate`
   在 build 后丢失 → lane 的 `step.escalate || 'plan_failed'` / `|| 'report'` 全部退化。
   实测：`stock_wood.report_nohome` 本应上报 `no_home`，实际进 inbox 的是 `plan_failed`
   （stuck 场景的 ⚠ 就是这条）。feed 的 `report` 步（starving）同理。
2. **失败路径 `#finishPlan(..., {silent:true})`**：计划失败只由调用方各自的 escalate 上报一次
   （所以 `hungry` 只有 `starving`、没有 `plan_failed`）。任务书/docs §3.2 若要求
   "plan_failed + starving 两条"就与此不符（hungry 场景的 ⚠ 就是这条）。
3. **中断想开计划会被挂起计划挡住**：`#maybeInterrupt` 先 `suspendPlan` 当前计划，
   再 `startPlan`；但 `startPlan` 的 `planAlive(st.plan)` 把 suspended 也算占用 → 返回 busy。
   `interrupts.mjs` 给 `night_danger` 加了 `goal: go_to owner` 兜底，但"中断计划"语义
   （docs §3 ③）在有计划在跑时走不到。目前 6 个场景未覆盖"计划在跑时夜间来袭"。

## 隔离

- 地点簿/世界记忆一律用 `$TEMP\numen-replay-<id>-*` 临时文件，跑完删除；
- trace 只进内存，本回放器代码里没有 `new Trace(...)`，不会写 `logs/`；
- 汇总里会对比根目录 `places.json` / `world.json` 的 mtime/size：若变化只 WARN
  （树进程可能同时在写真实文件），本次回放自身只读不写那两个文件。

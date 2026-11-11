# Pilot / Mode MVP 收尾交付

> 2026-11-10。范围：docs/86 §8 + §11.3（MVP 无 GM）、docs/84 试驾员协议。  
> 维护边界：只动 `tools/`、`docs/84`、根 `.gitignore`；未改 `src/`、docs/78/86/87、验收口径、树行为。`src/daemon.mjs` 入口 guard 已由树侧落地，本轮维护子体只同步文档。  
> 结论：**MVP 工具侧收尾完成；src 入口启动 guard 已完成；触手只读客户端与一次性分析器已交付；GM/8770 已构建但未安装/未重启/未实机；真实 LLM 端到端仍待 endpoint/key。**

## 1. 完成项

- [x] `mode.mjs`：`OFF / TREE / DEV / DEV_PROTECTED / TRANSITION` 状态机；
- [x] lease + 单调 fencing（`runs/.pilot-lock.json` + `runs/.fencing`，`mode.json` 只是快照）；
- [x] `protect`：TTL + heartbeat + runId/reason，树启动拒绝码 `dev_protected`；
- [x] `force-tree` / `force-dev`：`--yes` 二次确认、runId 审计、graceful handoff（不 taskkill）、失败/超时回 `OFF`；
- [x] `tools/tree-start.mjs`：启动 guard（lease 校验 + tree lease + heartbeat）；
- [x] `src/daemon.mjs` 入口启动 guard：活跃 dev/pilot/mode lease 时 `exit 3`；`TREE_ALLOW_DEV=1` 紧急绕过；`TREE_GUARD_LOCK` 供临时锁自测；权威仍是 lease；
- [x] Pilot Harness 集成：`enterDev / heartbeat / 每步 ownership+fencing / exitDev`；
- [x] `run.mjs` 不再自动 handoff 树；树在跑时拒绝启动，切换只走 Lead force；
- [x] trace 归档 `archive/<runId>/` 与 manifest token 指标；
- [x] README / MAINTENANCE / TESTPLAN 与 `docs/84 §7/§8` 更新；
- [x] 根 `.gitignore` 覆盖 `run/`、`runs/`、`archive/`；
- [x] 自测通过：mode `10/10`、recovery `9/9`、replay `21/21`。

## 2. 未完成 / 后置（非本轮阻塞）

1. **GM 实机**：8770 dev command portal + GMProvider 已构建并通过 mock 测试，但**未安装 jar、未重启游戏、未对真实世界发命令**；设计见 docs/85，实机步骤见 `GM.md` §8。
2. **触手真实 8769**：客户端已交付并自测；真实监听/延迟/UUID 权限未验证（需 mod 已装且游戏已重启）。
3. **一次性分析器**：已交付并自测；真实 run 的分段/失败判定仍需人工抽查。
4. 实机待验：真实 8766/8767 下 `tree-start` 启停；真实 OpenAI-compatible LLM 端到端（**仍待 endpoint/key**）；CreativeGiveProvider 实机；fixture 与 RUNNING 物理分区。

> `src/` 最小 hook 已完成（2026-11-10.4）：直接 `node src/daemon.mjs` 在活跃 dev lease 下 `exit 3`；证据见 §3。MVP 验收口径不变。  
> 第二阶段非 GM 补充（2026-11-10.5）：`tentacle-client.mjs`、`analyze-run.mjs` 及其自测已交付，见 §6。

## 3. 验证证据

| 项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| mode 自测 | `node tools/pilot/mode-selftest.mjs` | **10/10 PASS** | `logs/mode-selftest.json`（`passed=true`，`gmDelivered=false`） |
| 恢复演练 | `node tools/pilot/recovery-drill.mjs` | **9/9 PASS** | `logs/pilot-recovery-drill.json`（`passed=true`） |
| Track A 只读回归 | `node probe/replay.mjs` | **21/21 场景、185/185 断言 PASS** | 回放 stdout；未写 `logs/`、未改真实 places/worldmem |
| 真实状态 | `node tools/mode.mjs status` + 端口检查 | `state=OFF`、`lease=null`、无 `.pilot-lock`、`fence=6` | `run/mode.json`、`runs/.fencing` |
| 端口 | `Get-NetTCPConnection -State Listen` | 8766/8767/8770 未监听；8765 游戏监听（可保留） | 现场检查 |
| 干净状态 guard | `node tools/tree-start.mjs --dry-run` | `ok=true`、`state=OFF`、`warnings=[]` | 本轮 stdout |
| src 入口 guard | `logs/src-guard-selftest.json`（伪造 dev lease + `TREE_GUARD_LOCK`；干净状态仅 dry-run/端口检查） | **6/6 PASS**：`node src/daemon.mjs` `exit=3` + `[tree-guard]`；stale/非 dev 放行；`TREE_ALLOW_DEV` 源码级校验 | `logs/src-guard-selftest.json` |

本轮证据时间：mode/recovery `2026-11-10T07:09Z` 左右（mode 复跑 `07:18Z`）；src guard `2026-11-10T07:18Z` 左右。测试全部临时目录 + 模拟端口/临时锁，未启动真实树/游戏、未 taskkill、未动真实锁。

## 4. 维护者交接

### 4.1 先读

1. `tools/pilot/README.md`：用法与命令；
2. `tools/pilot/MAINTENANCE.md`：架构/状态机/lease/force/恢复/故障；
3. `tools/pilot/TESTPLAN.md`：验收矩阵与本轮记录；
4. `docs/84`：试驾员协议（§7/§8 已按实现更新）。

### 4.2 不可破坏的约束

- 真相是 **lease + fencing**，不是 `mode.json`，也不是 8765 端口占用；
- 树启动只走 `tree-start.mjs` / `启动树进程.bat`；直接 `node src/daemon.mjs` 现在会被 src 入口 guard 拒绝（活跃 dev lease 时 `exit 3`），但仍不会 claim tree lease；
- 紧急绕过仅 `TREE_ALLOW_DEV=1`（确认 dev 已停但 lease 残留时）；不得把它当常规启动方式；
- `force-*` 必须 `--yes`，并绑定 runId（未给自动生成），否则拒绝并审计；
- 不 taskkill、不杀游戏；切换用 graceful handoff；
- 不删除 `runs/`、`archive/`、`logs/preemption.jsonl` 作为“清锁”手段；
- 测试必须隔离到临时目录/模拟端口，不碰真实 lease/端口/游戏；
- GM 未安装：不得把 `fixture` 当 GM；`devtools/` 源码/manifest 不得被当作已实机验证（GM 已构建，见 §6）；
- 维护子体只改 `tools/` 与工具文档，不改 `src/`、验收口径、树行为。

### 4.3 接手动作

```bash
node tools/mode.mjs status          # 期望 OFF / 无 lease
node tools/tree-start.mjs --dry-run # 期望干净状态放行
node tools/pilot/mode-selftest.mjs  # 期望 10/10
node tools/pilot/recovery-drill.mjs # 期望 9/9
node probe/replay.mjs               # 期望 21/21
```

若状态不是 `OFF`：先看 `status` 的 `lease/transition`，再 `node tools/mode.mjs recover`；仍无法收口才由 Lead 决定 `off --force`。不要用删文件掩盖。

### 4.4 留给 Lead 的决定

1. 何时授权安装 GM jar + 重启游戏 + 实机 `/tp`（docs/85，需独立验收；本文件不代表已实机）；
2. 何时用真实 8769/真实 run 抽查触手客户端与分析器，是否把它们接入 `run.mjs` 自动流程；
3. 是否把 `tree-start` 设为唯一允许入口（用运维流程约束，而非再加代码）。

## 5. 备注

- docs/86 未改动；其 §8/§11.3 与本次交付范围一致（MVP 不含 GM/8770/触手客户端；第二阶段补充见 §6）。
- 若后续改动 `mode.mjs` 状态机或 lease 字段，必须同步更新本文件、README、MAINTENANCE、TESTPLAN 和 `docs/84 §7/§8`。

## 6. 第二阶段非 GM 补充（2026-11-10.5）

| 项 | 状态 | 证据/说明 |
|---|---|---|
| `tools/pilot/tentacle-client.mjs` | 已交付 | 只读 8769；self/terrain/entities/water/landmarks；每次调用写 `tentacle_use.jsonl`；`diagnostic-only`/`actionPrecondition=false`；结构化失败 |
| `tools/pilot/analyze-run.mjs` | 已交付 | 只读 run；`archive/<runId>/analysis.{json,md}`；分段/失败/token/调用数/重复观测/GM/触手；默认只输出路径 + 一句话 |
| 触手自测 | **12/12 PASS** | `logs/tentacle-client-selftest.json`（随机 fake HTTP 端口，未连真实 8769） |
| 分析器自测 | **11/11 PASS** | `logs/analyze-run-selftest.json`（临时 run/archive，run 未变） |
| GM mod / GMProvider | **已构建、mock 测试通过；未安装/未重启/未实机** | `GM.md`、`devtools/README.md`、`devtools/MAINTENANCE.md` |
| 真实 LLM 端到端 | **待 endpoint/key** | `PILOT_LLM_BASE_URL/MODEL/API_KEY` |

边界：本轮只改 `tools/` 与工具文档；未改 `src/`、`devtools/` 源码、GM 代码、验收口径；未重启游戏、未 taskkill、未改树。

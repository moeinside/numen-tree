# Pilot / Mode 验收清单（MVP，无 GM）

> 对应：docs/86 §8 + §11.3、docs/84、docs/82。  
> 被测：`tools/pilot/mode.mjs`、`tools/mode.mjs`、`tools/tree-start.mjs`、`tools/pilot/run.mjs` 的 mode 集成。  
> 证据：`node tools/pilot/mode-selftest.mjs` → `logs/mode-selftest.json`；src 入口 guard 补充证据 → `logs/src-guard-selftest.json`。  
> 边界：不启动真实树/游戏、不 taskkill、不动真实锁；全部用临时目录 + 模拟端口。src 入口 guard 只有在伪造 dev lease 时运行到 guard 并 `exit 3`，不进入配置/监听阶段。  
> GM（8770 / GMProvider）不在本 MVP 清单：**已构建并通过 mock 测试，但未安装、未重启游戏、未实机验证**；GM 单独验收（见 `GM.md`、`devtools/TESTPLAN.md`）。  
> 第二阶段补充的触手客户端 / 一次性分析器见 §9。

## 0. 判定规则

- 每项必须可由 `mode-selftest.mjs` 重复执行，输出 `PASS/FAIL`。
- “通过”以退出码 + `logs/mode-selftest.json` 为准，不以口头结论为准。
- 任一必测项 FAIL → MVP 不通过。
- 测试不得依赖上一轮残留；临时目录每轮新建、结束删除。
- 测试不得连接 8765/8766/8767/8768/8769/8770；端口探测使用临时空闲端口。
- 测试不得调用 `taskkill`/杀游戏；仅允许结束自测自己 spawn 的子进程。

## 1. 必测项

| ID | 验收项 | 方法 | 期望 |
|---|---|---|---|
| T1 | 干净状态树可启动（100%） | 无 lease、无 mode、模拟端口关闭；连续 20 次 `guardCheck` + 1 次 `tree-start --dry-run` + 1 次 `tree-start`（`PILOT_TREE_TEST_CMD` 假子进程） | 20/20 放行；dry-run 退出 0；实际 wrapper 退出 0；假子进程收到启动；不残留 lease |
| T2 | dev 持 lease 时树启动被拒 | 子进程 `mode dev --hold` 持 lease；`guardCheck` + `tree-start --dry-run` | 拒绝；退出码 3；`code=dev_active` |
| T2b | protect 下拒绝码 | T2 基础上 `protect on --ttl-ms=...` | `code=dev_protected`；TTL 到期回落 DEV |
| T3 | stale lease + PID 死可恢复 | 子进程持 lease 后被 SIGKILL；检查 stale；guard/recover | stale=true、pidAlive=false；guard 清理后放行；state=OFF；旧 lease 归档 |
| T4 | force 中途失败回 OFF | (a) 无 `--yes` 被拒；(b) 注入 handoff 返回失败；(c) 注入切换崩溃后再 `recover` | (a) 退出 2 `confirmation_required`；(b)(c) 均回到 `OFF`；无残留 lease；不卡 `TRANSITION` |
| T5 | force 幂等 | 连续两次 `force-tree`；再连续两次 `force-dev`（`--once`） | 最终态稳定（TREE / DEV）；两次均 ok；fencing 单调递增；无残留过渡锁 |
| T6 | 并发 force | 两个 `force-tree` 同时启动（带测试延迟） | 恰好 1 个成功；另 1 个退出 4 `transition_busy`；最终 mode 合法、无残留 transition lock |
| T7 | 工具关闭时 Track A 回放不受影响 | 确保 `OFF` + 无 lease；子进程跑 `node probe/replay.mjs` | 退出 0；`21/21` 场景通过；回放后 mode 仍 `OFF`、无 lease、无工具写入 |
| T8 | fencing 失效校验 | 旧 lease 被 force 后，用旧 owner+fencing 调 `heartbeatLease` | 拒绝（`not_owner` 或 `fencing_mismatch`）；旧进程不能复活 |
| T9 | TRANSITION 超时回 OFF | 注入崩溃/超时，deadline 过期后 `recover` 或 guard | 自动/手动回 `OFF`；审计含 `transition_recovered`；无残留锁 |
| T10 | force-tree 不杀进程 | 用 mock dev holder（自测子进程）模拟 dev；force-tree 后 | holder 自行发现 lease 丢失并退出；无 taskkill；最终 TREE |

## 2. 回归项

| ID | 项目 | 命令 | 期望 |
|---|---|---|---|
| R1 | 既有 pilot 恢复演练 | `node tools/pilot/pilot.mjs drill recovery` | 9/9 通过；`logs/pilot-recovery-drill.json` |
| R2 | pilot mock dry-run | 见 README | 不接树、不执行变更动作 |
| R3 | mode 自测可重复 | 连续跑两次 `mode-selftest.mjs` | 两次均 PASS；不因上一轮残留失败 |
| R4 | 文档一致性 | 人工 | README/MAINTENANCE/TESTPLAN 命令与实际一致；GM 明确标“已构建未安装/未重启” |
| R5 | token 预算/效率字段 | mock run 后读 manifest/observations | `tokens`/`llmCalls`/`repeatedObservations` 存在；observations 带 hash/unchanged；caps 生效 |

## 3. 不允许的“通过”方式

- 改 `src/`、docs/78、docs/86、验收口径或树行为来让测试过；
- 用 `taskkill` / 杀游戏进程清理锁；
- 复用真实 `runs/.pilot-lock.json` 或真实 `run/mode.json` 做测试；
- 测试中真正启动 `src/daemon.mjs`（越过入口 guard、开始加载配置/监听）或连接 8765；唯一例外：伪造 dev lease 验证入口 guard，进程必须在 guard 处 `exit 3`；
- 删除测试失败证据后重跑掩盖；
- 把 GM/fixture 当作互斥豁免；
- 把“直接 `node src/daemon.mjs` 在无活跃 dev lease 时能启动”当作 T2 通过：T2 必须由 `guardCheck`/`tree-start` 验证拒绝；直接启动的入口 guard 只在活跃 dev/pilot/mode lease 时 `exit 3`（见 `logs/src-guard-selftest.json` G3），它是补充证据，不改变 T1–T10 口径。

## 4. 覆盖矩阵（对照交付要求）

| 要求 | 覆盖 |
|---|---|
| 干净状态树可启动（100%） | T1 |
| dev 持 lease 时树启动被拒 | T2 |
| stale lease + PID 死可恢复 | T3 |
| force 中途失败回 OFF | T4 + T9 |
| force 幂等 | T5 |
| force 二次确认 + runId | T4 |
| 并发 force | T6 |
| 工具关闭时 Track A 回放不受影响 | T7 |
| lease fencing 校验 | T8 |
| 不杀进程 | T10 + 全局 |
| GM 已构建但未实机声明 | §0 + MAINTENANCE §1.2 |
| src 入口 guard（补充，不改变 T1–T10） | `logs/src-guard-selftest.json` G1–G6 |
| 触手只读/非权威/记录 | §9 B1–B5 |
| 分析器只读/归档/无正文 | §9 C1–C6 |

## 5. 运行方式

```bash
# 全部自测（推荐）
node tools/pilot/mode-selftest.mjs

# 只跑某个检查（便于调试；最终验收必须跑全量）
node tools/pilot/mode-selftest.mjs --only=T2,T6

# 证据
Get-Content logs/mode-selftest.json

# src 入口 guard 补充证据（临时锁；不启动真实树）
Get-Content logs/src-guard-selftest.json
# G3: TREE_GUARD_LOCK=<temp> node src/daemon.mjs -> exit 3 + [tree-guard]
```

### 5.1 隔离环境变量（自测内部设置，手工复现时也建议）

| 变量 | 用途 |
|---|---|
| `PILOT_LOCK_DIR` | 临时 lease 目录 |
| `PILOT_MODE_RUN_DIR` | 临时 transition/mode 目录 |
| `PILOT_MODE_FILE` | 临时 mode.json |
| `PILOT_PREEMPTION_LOG` | 临时审计 JSONL |
| `PILOT_TREE_CONTROL_PORT` / `PILOT_TREE_MCP_PORT` | 模拟端口（避开 8766/8767） |
| `PILOT_MODE_EXTERNAL=noop` | 屏蔽真实 handoff/clearLocks（仅自测） |
| `PILOT_MODE_TRANSITION_TIMEOUT_MS` | 缩短 transition 超时（仅自测） |
| `PILOT_MODE_TEST_DELAY_MS` | 放大切换窗口以测并发（仅自测） |
| `PILOT_MODE_TEST_ABORT` | 在切换写完后崩溃（仅自测） |
| `PILOT_TREE_TEST_CMD` | 替换 tree-start 启动的子进程（仅自测；不得在生产设置） |
| `TREE_GUARD_LOCK` | 仅 src 入口 guard 自测：指向临时锁文件，不碰真实 `runs/.pilot-lock.json` |
| `TREE_ALLOW_DEV=1` | 紧急绕过；**不得**用于自测“成功启动”，否则可能起真实树 |

## 6. 证据格式

`logs/mode-selftest.json`：

```json
{
  "at": "...",
  "version": "2026-11-10.1",
  "env": { "lockDir": "...", "modeFile": "...", "ports": [ ... ] },
  "checks": [
    { "id": "T1", "name": "clean_start_allowed_100", "ok": true, "detail": {...} }
  ],
  "passed": true,
  "durationMs": 12345
}
```

## 7. 当前状态（2026-11-10）

- [x] T1–T10 全绿（`logs/mode-selftest.json`，连续两轮 10/10）
- [x] R1 既有 recovery drill 不回归（9/9）
- [x] R3 连续两次可重复（两轮均 10/10）
- [x] R4 文档一致性（README/MAINTENANCE/TESTPLAN 命令一致；GM 明确标“已构建未安装/未重启”）
- [x] R2 pilot mock dry-run（真实 numen 8765、树未运行；dev lease→mock→exitDev OFF）
- [x] R5 token 预算/效率字段（manifest `tokens/llmCalls/repeatedObservations`；observations `hash/unchanged`）
- [x] src 入口 guard 补充证据：活跃 dev lease 时直接 `node src/daemon.mjs` 退出 3；`TREE_ALLOW_DEV` 源码级校验（不改变 T1–T10 口径）
- [x] B1–B5 触手客户端自测 12/12（`logs/tentacle-client-selftest.json`）
- [x] C1–C6 分析器自测 11/11（`logs/analyze-run-selftest.json`）
- [ ] 真实树 `tree-start` 实机启动/退出（自测用 fake child 验证全链，避免启动真实树）
- [ ] 触手真实 8769 监听/延迟（需 mod 已装且游戏已重启）
- [ ] GM 实机 `/tp`（未安装/未重启/未授权）

> 完成项由维护子体在 `tools/pilot/README.md` 的“验证证据”一节回填；本轮已回填。

## 8. 收尾运行记录（2026-11-10）

| 项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| mode 自测 | `node tools/pilot/mode-selftest.mjs` | **10/10 PASS**（T1–T10） | `logs/mode-selftest.json`（`at=2026-11-10T07:18:15.563Z`，`gmDelivered=false`） |
| 恢复演练 | `node tools/pilot/recovery-drill.mjs` | **9/9 PASS** | `logs/pilot-recovery-drill.json`（`at=2026-11-10T07:09:11.579Z`） |
| Track A 回归 | `node probe/replay.mjs` | **21/21 场景、185/185 断言 PASS** | 只读回放 stdout；不写 `logs/`、不改 places/worldmem |
| 真实状态 | `node tools/mode.mjs status` + 端口检查 | `state=OFF`、`lease=null`、无 `runs/.pilot-lock.json`；8766/8767/8770 未监听；8765 由游戏监听（可保留） | 见下 |
| 干净状态 guard | `node tools/tree-start.mjs --dry-run` | `ok=true`、`state=OFF`、`warnings=[]`、`wouldStart=src/daemon.mjs` | 本轮 stdout |
| src 入口 guard | 临时 dev lease + `TREE_GUARD_LOCK` 跑 `node src/daemon.mjs`；干净状态仅 dry-run/端口检查 | **6/6 PASS**：G3 `exit=3` + `[tree-guard]`；G4 stale/非 dev 放行；G5 `TREE_ALLOW_DEV`；G6 8766/8767/8770 未监听 | `logs/src-guard-selftest.json`（`at=2026-11-10T07:18:37.170Z`） |

真实状态字段：`fence=6`、`transition=null`、`warnings=[]`、`reconciled=[]`；`run/mode.json` 为 `OFF` 快照（不是锁）。

> 以上测试全部使用临时目录 + 模拟端口；未启动真实树/游戏、未 taskkill、未改真实锁。GM 已构建但未安装/未重启/未实机，不在本轮测试范围。

## 9. 第二阶段补充：触手客户端 / 一次性分析器

> 2026-11-10。对应 docs/90 §1B/§1C、docs/84 §5/§6。  
> 证据：`logs/tentacle-client-selftest.json`、`logs/analyze-run-selftest.json`；均使用临时目录 + 随机端口，不碰真实 8769 / runs / archive。

### 9.1 触手只读客户端（B1–B5）

| ID | 验收项 | 期望 |
|---|---|---|
| B1 | 只读 | 只调用 `GET /health` / `GET /perception`；非 GET 由 mod 拒绝；客户端无动作/写接口 |
| B2 | 五个投影 | `self/terrain/entities/water/landmarks` 均可查询；单字段查询不泄漏其他字段 |
| B3 | 记录 | 每次调用（含失败）写 `runs/<runId>/tentacle_use.jsonl`，含 runId/purpose/fields/ok/summary 或结构化 error |
| B4 | 非权威 | 记录与返回均带 `authority=diagnostic-only`、`actionPrecondition=false`；不参与动作执行 |
| B5 | 结构化失败 | `missing_uuid`/`invalid_uuid`/`timeout`/`invalid_response`/`server_not_ready`/`network_error` 均返回 `{ok:false,error:{code,message}}`，不抛 HTTP 异常；默认拒绝非 loopback |

覆盖用例：`tentacle-client-selftest.mjs` T1–T12（12/12）。

### 9.2 一次性分析器（C1–C6）

| ID | 验收项 | 期望 |
|---|---|---|
| C1 | 一次性读 run | 读 manifest/observations/actions/raw/console/gm/tentacle_use；不需要把全文回灌 Lead |
| C2 | 摘要字段 | `analysis.json` 含 run 信息、tokens/llmCalls/steps、重复观测/重复率、时间分段、失败列表、GM/触手使用 |
| C3 | 归档 | 写 `archive/<runId>/analysis.json` + `analysis.md` |
| C4 | 只读 | 不改 run 目录；分析前后文件指纹一致（`readOnly.runUnchanged=true`） |
| C5 | 无正文回灌 | 默认 stdout 仅路径 + 一句话；不包含观测正文/原始 trace |
| C6 | 负样本 | 不存在的 run 返回 `run_not_found`；坏 JSONL 行计数但不崩溃 |

覆盖用例：`analyze-run-selftest.mjs` A1–A11（11/11）。

### 9.3 仍未覆盖（真实验证）

- 真实 8769 监听、真实 UUID/权限/延迟；
- 真实 run 的分段/失败判定人工抽查；
- GM 实机（未安装/未重启/未授权）；
- 真实 OpenAI-compatible LLM 端到端（需 endpoint/key）。

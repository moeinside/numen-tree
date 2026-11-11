# Pilot 工具（MVP）

> 2026-11-10。对应 docs/82、docs/83、docs/86 §8/§11.3、docs/91。  
> 状态：独占锁/交接/解锁/恢复演练 + LLM MCP 循环 + 外部 JSONL/manifest + 只读观测 + 批准/caps/目标退出 + **mode/lease/fencing/protect/force + tree-start guard + src 入口启动 guard** 已实现；**触手只读客户端 `tentacle-client.mjs` 与一次性分析器 `analyze-run.mjs` 已交付并自测通过**；**docs/91 `devtool` 流水线（prepare/operator-brief/close/analyze/status）已交付，10/10 临时隔离自测通过**；真实 LLM 仍待 endpoint/key；cheat fixture 未实机验证。  
> **GM（8770/GMProvider）已构建并通过 mock 测试，但未安装、未重启游戏、未对真实世界发命令**（见 `GM.md`、`devtools/README.md`）；不属于 MVP 验收。  
> 当前真实状态（2026-11-10 收尾）：`mode=OFF`、无 `runs/.pilot-lock.json`、8766/8767/8770 未监听、8765 可留游戏；8769 未在本轮验证。

## 0. 互斥与 mode（新增）

```bash
# 看状态（lease + 端口 + fencing；mode.json 只是人类可读快照）
node tools/mode.mjs status
node tools/pilot/mode.mjs status          # 等价；下文二选一

# dev 持 lease（默认前台 hold，Ctrl-C 释放；--once 仅脚本用，退出即 stale）
node tools/mode.mjs dev --run-id=night --reason="night test"
node tools/mode.mjs dev --protect --reason="do not start tree" --ttl-ms=600000
node tools/mode.mjs protect on  --owner=<owner> --reason="..." --ttl-ms=600000
node tools/mode.mjs protect off --owner=<owner>

# 声明 TREE（不启动树）；真正启动必须走 guard 包装器
node tools/mode.mjs tree
node tools/tree-start.mjs                 # 正确启动方式
node tools/tree-start.mjs --dry-run       # 只跑 guard

# Lead 强杀（需 --yes 二次确认；写 logs/preemption.jsonl；不 taskkill）
node tools/mode.mjs force-tree --yes --reason="switch to A"
node tools/mode.mjs force-dev  --yes --reason="Lead switch"     # 默认前台 hold
node tools/mode.mjs off --force
node tools/mode.mjs recover               # 清 stale lease / 超时 TRANSITION

# 自测（临时目录 + 模拟端口，不碰真实锁/游戏/树）
node tools/pilot/mode-selftest.mjs
# 证据：logs/mode-selftest.json
```

关键规则：

- 同一时间只有一个工具能用 numen MCP（8765）；**lease + fencing 是锁，`mode.json` 不是**；
- 树启动前必须校验 lease：`DEV/DEV_PROTECTED` 时拒绝启动；
- dev 正常启动不驱逐树；要切换用 Lead `force-dev`；
- `force-*` 先 graceful handoff / 清锁 / 换 fencing；失败或超时回 `OFF`；
- **直接 `node src/daemon.mjs` 也会被启动 guard 拒绝**：`src/daemon.mjs` 入口最前面读取 `runs/.pilot-lock.json`（测试可用 `TREE_GUARD_LOCK` 指向临时锁），若 lease 为 dev/pilot/mode、未过期且 PID 活着，打印 `[tree-guard]` 并以 **exit 3** 退出；干净状态/无 lease 照常启动。**权威仍是 lease**，`mode.json` 只是快照。紧急人工绕过仅 `TREE_ALLOW_DEV=1`（仅限确认 dev 已停但 lease 残留时），详见 `MAINTENANCE.md` §8.2。启动树仍推荐 `tree-start.mjs`：它额外 claim tree lease、探测端口并 heartbeat；直接启动现在不会绕过 dev 互斥，但也不会 claim tree lease。

详细架构、端口、状态机、force/恢复/fail-safe、故障排查见 **[MAINTENANCE.md](MAINTENANCE.md)**；验收矩阵见 **[TESTPLAN.md](TESTPLAN.md)**；收尾清单与维护者交接见 **[MVP-COMPLETE.md](MVP-COMPLETE.md)**。

## 触手只读客户端（第二阶段）

```bash
# 只读查询 8769（默认 127.0.0.1:8769，host/port 可配）
node tools/pilot/tentacle-client.mjs --uuid=<同伴UUID> --run-id=<runId> \
  --purpose="diagnose water" --fields=self,terrain,entities,water,landmarks
node tools/pilot/tentacle-client.mjs --health

# 自测（本地 fake HTTP，随机端口，不碰真实 8769）
node tools/pilot/tentacle-client-selftest.mjs
# 证据：logs/tentacle-client-selftest.json
```

- 只发 `GET /health` / `GET /perception`，无动作接口；
- 每次调用（含失败）追加 `runs/<runId>/tentacle_use.jsonl`，记录 `runId/purpose/fields/ok/错误摘要/summary`；
- **触手只作诊断/候选**：`authority=diagnostic-only`、`actionPrecondition=false`，不作动作前置权威，也不能替代 numen 现场观测；
- landmarks/water 可能穿墙/未按 FOV/LOS 过滤，必须在分析里标注“非全知”；
- 失败结构化：`missing_uuid`/`invalid_uuid`/`network_error`/`timeout`/`invalid_response`/`server_not_ready`/`tentacle_error` 等，不抛 HTTP 异常；
- 默认拒绝非 loopback host；测试用临时端口，不连真实 8769。

## docs/91 流水线：目标 → Operator → 日志 → Analyst

```bash
# 1) Lead 写 goal JSON（字段见 tools/templates/GOAL.md 的“原始合同”）
#    然后 prepare：校验 goal、建 run、启动后台 lease holder、写 Operator 简报
node tools/devtool.mjs prepare --goal=path/to/goal.json --run-id=day1 --topic="Day1 木链/食物/夜间安全"

# 2) Operator 子体只读简报、只执行；不分析、不写 summary
node tools/devtool.mjs operator-brief --run=day1
#    简报路径：runs/day1/OPERATOR-BRIEF.md
#    Operator 环境：PILOT_RUN_DIR=runs/day1
#    只通过 node tools/pilot/dsh-bridge.mjs ... 操作 numen MCP

# 3) 收口：停 holder、释放 lease、mode OFF、验证无锁；不 taskkill 游戏/树
node tools/devtool.mjs close --run=day1

# 4) Analyst 子体：只读 run，生成 analysis.* + roundtable-pack.md
node tools/devtool.mjs analyze --run=day1
#    默认只打印 analysis/json/pack 路径 + 一句摘要

# 任意时刻查看
node tools/devtool.mjs status --run=day1
```

- `prepare` 只建 `runs/<runId>/GOAL.md`、`manifest.json`、`OPERATOR-BRIEF.md`、`holder.log` 和后台 lease holder；**不启动树/游戏**。
- lease holder 走 `mode.mjs dev --hold`；`close` 通过 `.holder-stop` 文件让它自行释放，**不 taskkill**；若 holder 已失联，只释放本 run 自己的 lease。
- `analyze` 调用 `analyze-run.mjs`，写 `archive/<runId>/analysis.{json,md}` 和 `archive/<runId>/roundtable-pack.md`；不改 run 目录，不产验收结论。
- **Operator 路径是 DSH 子体**；`run.mjs` 的 OpenAI-compatible provider 仍是可选项，不是本流水线前提。
- 不实现 GM/LLM；GOAL 未明确允许时 Operator 不得用 GM。
- 测试：`node tools/pilot/devtool-selftest.mjs`（临时目录/端口；证据 `logs/devtool-selftest.json`）。

隔离环境变量：`PILOT_RUNS_DIR`、`PILOT_MODE_RUN_DIR`、`PILOT_LOCK_DIR`、`PILOT_TREE_CONTROL_PORT`、`PILOT_TREE_MCP_PORT`、`PILOT_NUMEN_PORT`、`PILOT_ARCHIVE_DIR`。

## 一次性 run 分析器（第二阶段）

```bash
# 读一个 run（不打印正文），生成并归档 analysis.md/json
node tools/pilot/analyze-run.mjs --run=<runId|path>
# 仅调试需要看正文时显式加 --print（默认不打印）
node tools/pilot/analyze-run.mjs --run=<runId> --print

# 自测（临时 run/归档目录，不碰真实 runs/archive）
node tools/pilot/analyze-run-selftest.mjs
# 证据：logs/analyze-run-selftest.json
```

- 一次性读 run 目录：`manifest/observations/actions/raw/console/gm/tentacle_use`；**只读，不改 run**；
- 输出 `archive/<runId>/analysis.json` + `analysis.md`：分段、失败、token/调用数、重复观测、GM/触手使用；
- 默认 stdout 只有归档路径 + 一句话摘要，不把 trace 回灌 Lead；
- 只产诊断/假设/缺口，不产验收证据。

## 命令（既有 pilot）

```bash
# 只读预检：8765 numen MCP / 8767 树 / 锁状态
node tools/pilot/pilot.mjs preflight

# 锁
node tools/pilot/pilot.mjs lock status
node tools/pilot/pilot.mjs lock acquire --owner=pilot-xxx --mode=reference-pilot
node tools/pilot/pilot.mjs lock acquire --owner=pilot-xxx --recover-stale
node tools/pilot/pilot.mjs lock release --owner=pilot-xxx

# 让树优雅退出（control --op exit，不 taskkill）
node tools/pilot/pilot.mjs handoff

# 解锁：清僵尸锁 + 释放 lease（可选重启树）
node tools/pilot/pilot.mjs unlock
node tools/pilot/pilot.mjs unlock --restore-tree

# 最坏恢复演练（临时目录，不动真实锁/游戏）
node tools/pilot/pilot.mjs drill recovery

# Mock dry-run（不执行变更动作）
node tools/pilot/pilot.mjs run --provider=mock --dry-run --yes \
  --steps=3 --minutes=1 --no-lock --no-handoff --companion=bigwhale

# 真实参考运行（需人工批准；默认逐条批准）
node tools/pilot/pilot.mjs run --provider=mock --steps=1 --minutes=1 \
  --no-handoff --companion=bigwhale

# 运行期 protect（树启动会被拒；heartbeat 续 TTL）
export PILOT_LLM_BASE_URL=http://127.0.0.1:1234/v1
export PILOT_LLM_MODEL=...
export PILOT_LLM_API_KEY=...
node tools/pilot/pilot.mjs run --provider=openai --minutes=20 --protect \
  --protect-reason="reference run" --target-file=targets/day1.lua
```

> run 现在先 `enterDev` 拿 mode lease：树在跑时会**拒绝启动**，不会自动把树 handoff 掉。  
> 要切换请由 Lead 先 `mode force-dev`。`--no-lock` 仅用于不接 mode 的离线/mock 调试。

## 退出机制（防上下文爆炸）

三层：

1. LLM 自己返回 `{"action":"stop","reason":"..."}`；
2. harness 目标谓词：`--target-file=<lua>`，返回 true 立即停（`target_reached`）；
3. 硬 caps：`--steps`、`--minutes`、`--max-tokens`；Ctrl-C 也会在当前调用后停。

上下文控制：

- 外部 JSONL 记录，不把全量日志塞回 LLM；
- 观测裁剪到 companions 600 / events 1500 / self 300 字符；
- history 只保留最近 10 条；
- 每次只发一个动作请求；
- manifest 记录 `tokens` / `llmCalls` / `repeatedObservations`；`observations.jsonl` 带 `hash`/`unchanged`，用于核对 token 效率（docs/86 §11.4）。

## 已实现

- `mode.mjs`：`OFF/TREE/DEV/DEV_PROTECTED/TRANSITION` + lease/fencing/protect/force + TRANSITION 超时回 OFF；
- `tree-start.mjs`：树启动 guard（lease 校验 + tree lease + 运行期 heartbeat）；
- `src/daemon.mjs` 入口启动 guard：直接启动时校验 dev/pilot/mode lease，命中即 `exit 3`；`TREE_ALLOW_DEV=1` 紧急绕过；证据 `logs/src-guard-selftest.json`；
- `mode-selftest.mjs`：T1–T10 自测（临时目录/模拟端口）；
- `lock.mjs`：O_EXCL 原子锁、owner/pid/runId、heartbeat、stale 检测、归档恢复、fencing/kind 字段；
- `tree-control.mjs`：控制面白名单 `status/handoff/clearLocks`；
- `mcp-readonly.mjs`：preflight 只读；
- `numen-client.mjs`：MCP initialize/tools/list/tools/call；
- `run.mjs`：mode dev lease→确认树未运行→清锁→fixture→观测→LLM→批准→执行→target/caps→settle→exitDev；每步校验 owner+fencing；
- `run-store.mjs`：manifest/raw/actions/observations/console/report；
- `llm-provider.mjs`：mock + OpenAI-compatible；
- `approval.mjs`：只读动作自动，变更动作逐条确认；
- `caps.mjs`：步数/时间/token；
- `fixture.mjs`：creative.give 白名单（需 `--allow-creative`）；
- `recovery-drill.mjs`：崩溃持锁 → stale → recover → owner 校验；
- `tentacle-client.mjs`：只读 8769 查询 self/terrain/entities/water/landmarks + `tentacle_use.jsonl` + 结构化失败 + 非权威标记；
- `analyze-run.mjs`：一次性 run 分析（分段/失败/token/重复观测/GM/触手）+ `archive/<runId>/analysis.*`，默认不回灌正文；
- `devtool.mjs`：docs/91 薄编排（prepare/operator-brief/close/analyze/status）+ `templates/GOAL.md` / `templates/roundtable-pack.md`；后台 holder 用 `.holder-stop` 优雅停止；
- `gm-provider.mjs`：8770 GM 薄客户端（已构建/mock 测试，未实机安装）。

## 验证证据

Mode / 树启动 guard 自测（10/10，连续两轮）：

```
PASS T1 clean_start_allowed_100
PASS T2 dev_lease_blocks_tree_start
PASS T3 stale_lease_recovery
PASS T4 force_failure_returns_off
PASS T5 force_idempotent
PASS T6 concurrent_force
PASS T7 track_a_replay_unaffected
PASS T8 fencing_rejects_old_lease
PASS T9 transition_timeout_returns_off
PASS T10 force_tree_does_not_kill
evidence: logs/mode-selftest.json
```

T7 同时证明：工具 `OFF` / 无 lease 时，`node probe/replay.mjs` 仍 `21/21` 通过。

src 入口启动 guard 自测（6/6，临时锁 + `TREE_GUARD_LOCK`，未起真实树）：

```
PASS G1 clean_state_wrapper_guard_dry_run
PASS G2 clean_real_state_no_lock_no_tree_ports
PASS G3 fake_dev_lease_blocks_real_daemon_entry   # exit=3，[tree-guard]
PASS G4 guard_logic_stale_expired_dead_nondev_missing
PASS G5 emergency_bypass_tree_allow_dev           # 源码级校验
PASS G6 no_tree_ports_after_guard_test
evidence: logs/src-guard-selftest.json
```

触手客户端自测（12/12，本地 fake HTTP；随机端口，不碰真实 8769）：

```
PASS T1 health returns mod/version
PASS T2 perception returns all five projections
PASS T3 per-field queries select only that projection
PASS T4 missing uuid rejected locally (no HTTP)
PASS T5 invalid uuid rejected locally
PASS T6 timeout is structured
PASS T7 bad JSON is invalid_response
PASS T8 mod ok:false is structured (server_not_ready)
PASS T9 network error is structured
PASS T10 non-loopback host refused by default
PASS T11 journal has runId/purpose/summary and non-authority flags
PASS T12 journal path derives from runId/runDir
evidence: logs/tentacle-client-selftest.json
```

一次性分析器自测（11/11，临时 run/归档；不碰真实 runs/archive）：

```
PASS A1 analyzeRun succeeds and archives analysis.json/md
PASS A2 segments split on the 17-minute gap
PASS A3 failure list includes abort/action/observation/GM/tentacle
PASS A4 token/call/repeat metrics are populated
PASS A5 GM usage summary
PASS A6 tentacle usage summary and non-authority flag
PASS A7 run directory is unchanged (read-only)
PASS A8 analysis body does not embed raw observation text
PASS A9 default summary is paths + one sentence, no trace body
PASS A10 CLI default stdout has no body
PASS A11 missing run is a structured error
evidence: logs/analyze-run-selftest.json
```

devtool 流水线自测（10/10，临时目录/端口；不启动树/游戏、不动真实锁）：

```
PASS D1 prepare creates GOAL.md/manifest and a live detached lease holder
PASS D2 operator-brief is a one-page execute-only contract
PASS D3 status reports prepared phase, lease and live holder
PASS D4 close stops the holder, releases the lease and leaves mode OFF
PASS D5 analyze generates analysis.* and roundtable-pack.md from a synthetic run
PASS D6 prepare fails when tree ports are active (no run is created)
PASS D7 prepare fails when a valid dev lease already exists
PASS D8 prepare rejects a goal missing required fields
PASS D9 real runs/.pilot-lock.json, .fencing and run/mode.json are untouched
PASS D10 no taskkill/tree/game command was used
evidence: logs/devtool-selftest.json
```

收尾回归（2026-11-10）：mode `10/10`、recovery drill `9/9`、replay `21/21`（185/185 断言）；真实状态 `OFF` / 无锁 / 8766/8767/8770 未监听。明细见 `TESTPLAN.md` §8 与 `MVP-COMPLETE.md`。

恢复演练（9/9，回归）：

```
PASS holder acquired lock
PASS lock exists before crash
PASS lock remains after SIGKILL
PASS lock is stale after crash
PASS normal acquire blocked while stale
PASS recoverStale takeover ok
PASS non-owner release rejected
PASS owner release ok
PASS control-plane whitelist rejects unknown
evidence: logs/pilot-recovery-drill.json
```

真实交接（手动 `pilot handoff`；`pilot run` 现在不再自动 handoff）：

```
tree_listening=True
pilot handoff -> ok, exit status 0
tree_after=False
```

Mock dry-run / 真实 Lua 单步 / target 退出：

```
[obs] hp=5 food=6 pos=79.58,62.99,115.62
[target] reached; stopping
abortReason=target_reached
lock = null
```

Mode 集成（mock run，真实 numen、树未运行）：

```
dev lease acquired pilot-xxxx fencing=1
step 0 observe / step 1 get_events / step 2 stop
dev lease release: {"ok":true,"from":"DEV","to":"OFF","fencing":1,...}
```

## 尚未验证/待补

- **GM 实机**：`numen-devtools-0.1.0.jar` 未安装、游戏未重启、8770 未监听、未对真实世界发过命令；需 Lead 授权安装 + 重启一次（见 `GM.md` §8、`devtools/README.md`）；GM run 必须标 `assisted`，不作验收/学习；
- **触手真实 8769**：客户端/自测已完成，但本轮未验证真实 mod 监听、真实 UUID/权限/延迟；需 mod 已安装且游戏已重启；
- **分析器真实 run**：只在临时合成 run 上自测；首个真实 run 的分析结果需人工抽查“分段/失败”是否合理；
- **devtool 真实流水线**：prepare/close/analyze 只在临时目录/合成 run 上自测；首个真实 run 需 Lead 按 GOAL 执行并检查 holder/lease 收口；
- 真实 OpenAI-compatible LLM 端到端（需 endpoint/model/key）；
- CreativeGiveProvider 实机（需创造模式/世界 cheats）；
- 运行中树重新出现后的 abort 实机演练；
- `--recover-stale` 接管后的树重启/Track A 完整演练；
- fixture 与 RUNNING 物理分区（当前靠 mode/manifest/阶段顺序）；
- 真实 8766/8767 下的 `tree-start` 实机启动/退出（自测只跑 guard dry-run，避免启动真实树）。

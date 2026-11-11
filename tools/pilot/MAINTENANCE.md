# Pilot / Mode 维护手册（MVP，无 GM）

> 版本：2026-11-10.6  
> 适用：`tools/devtool.mjs`、`tools/pilot/mode.mjs`、`tools/mode.mjs`、`tools/tree-start.mjs`、`tools/pilot/pilot.mjs`、`tools/pilot/run.mjs`、`tools/pilot/tentacle-client.mjs`、`tools/pilot/analyze-run.mjs`。  
> 口径：docs/86 §8 + §11.3（MVP 无 GM）；docs/84 试驾员协议；docs/91 目标→Operator→日志→Analyst 流水线。  
> 维护边界：本手册与 `tools/` 由独立工具维护子体维护；**不改 `src/`、不改验收口径、不改树行为**。

## 0. 一句话

> `mode` 用 **lease + fencing token** 决定“现在谁能用 numen MCP 8765”；`mode.json` 只是给人看的快照，不是锁；树启动走 `tree-start` guard；`src/daemon.mjs` 入口也有最小 lease guard（直接启动命中 dev/pilot/mode lease 即 `exit 3`）；force 失败/超时一律回 `OFF`。

## 1. 交付范围与明确未交付项

### 1.1 本 MVP 已交付

- `mode.mjs`：`OFF / TREE / DEV / DEV_PROTECTED / TRANSITION` 状态机；
- 全局 lease（复用 `tools/pilot/lock.mjs`）+ 单调 fencing token；
- `protect`（TTL + heartbeat + runId/reason）；
- `force-tree` / `force-dev`（Lead 专用；写 `preemption.jsonl`；不 taskkill）；
- `tree-start.mjs` 启动 guard：校验 lease 后再启动 `src/daemon.mjs`；
- `src/daemon.mjs` 入口启动 guard：直接启动也拒绝活跃 dev/pilot/mode lease（`exit 3`，`TREE_ALLOW_DEV=1` 紧急绕过）；
- `mode-selftest.mjs`：可重复自测，证据写 `logs/mode-selftest.json`；
- Pilot Harness 与 mode 集成（`run.mjs` 通过 `enterDev/exitDev/heartbeatLease` 持 lease）；
- 触手只读客户端 `tentacle-client.mjs`：8769 `/health` + `/perception`，self/terrain/entities/water/landmarks 投影，`tentacle_use.jsonl`，结构化失败，`authority=diagnostic-only`；
- 一次性分析器 `analyze-run.mjs`：只读 run 目录，`archive/<runId>/analysis.{json,md}`，默认只输出路径 + 一句话；
- 维护文档与验收清单。

### 1.2 明确未交付 / 未验证（第二阶段）

- **GM 实机**：`devtools/` mod + `gm-provider.mjs` 已构建、已过 mock 测试；但 **jar 未安装、游戏未重启、8770 未监听、未对真实世界发过命令**（见 `GM.md`、`devtools/README.md`、`devtools/MAINTENANCE.md`）；
- **触手真实 8769**：客户端/自测已完成，但本轮未验证真实 mod 监听、真实 UUID/权限/延迟；需 mod 已安装且游戏已重启；
- **分析器真实 run**：仅用临时合成 run 自测；首个真实 run 需人工抽查分段/失败判定；
- 真实 OpenAI-compatible LLM 端到端（需 `PILOT_LLM_BASE_URL/MODEL/API_KEY`）；
- CreativeGiveProvider / cheat fixture 实机；
- 真实 8766/8767 下 `tree-start` 启停；fixture 与 RUNNING 物理分区。

> `fixture.mjs` 里的 `creative.give` 是既有 pilot fixture，不是 GM，也不在 mode 互斥里获得豁免。  
> GM 与触手都不进树验收/学习；GM run 必须标 `assisted`。

## 2. 架构

```text
                     ┌──────────────────────────────┐
  Lead / operator ──▶│ tools/tree-start.mjs (guard) │
                     └──────────────┬───────────────┘
                                    │ 1) lease 校验 + 端口检查
                                    │ 2) claim tree lease
                                    ▼
                     ┌──────────────────────────────┐
                     │ src/daemon.mjs（树；入口含    │
                     │ lease guard）                │
                     │ 8766 control / 8767 tree MCP │
                     └──────────────────────────────┘

  Lead / pilot ─────▶ tools/pilot/mode.mjs ──▶ lock.mjs (lease) ──▶ runs/.pilot-lock.json
                                    │                 │
                                    │                 └── runs/.fencing (单调计数器)
                                    ├──▶ run/mode.json（人类可读快照）
                                    ├──▶ run/.mode-transition.lock（切换互斥）
                                    └──▶ logs/preemption.jsonl（切换/拒绝/force 审计）

  tools/pilot/run.mjs ── enterDev/heartbeatLease/exitDev ──▶ mode.mjs
```

关键点：

- **lock.mjs 是唯一租约实现**；mode 不另造一套锁。
- `mode.json` 不参与放行判断；guard 只信 `runs/.pilot-lock.json`（lease）+ fencing + 端口事实。
- `run/.mode-transition.lock` 只用于串行化 mode 切换，防止并发 force 互相踩。
- `src/daemon.mjs` 入口已有最小启动 guard：直接 `node src/daemon.mjs` 时，活跃 dev/pilot/mode lease 会在加载配置前被拒（`exit 3`，见 §8.2）。它不替代 `tree-start.mjs`：直接启动仍不会 claim tree lease、不做端口检查。

## 3. 端口 / 资源

| 端口 | 服务 | 谁持有 | MVP 说明 |
|---|---|---|---|
| 8765 | numen MCP | 游戏 mod；树或 dev 作为客户端 | **互斥资源**。端口本身由游戏监听，工具无法靠 bind 判独占；独占由 lease + fencing 裁决 |
| 8766 | 树 control API | 树 daemon | 树活着时 dev 不启动；guard 也检查 |
| 8767 | 树 MCP | 树 daemon | pilot 不连；guard 检查 |
| 8768 | numenlockfix | 游戏 mod 补丁（可选） | 只做清锁；不在则优雅失败 |
| 8769 | 触手 | 游戏 mod 补丁（可选） | 只读诊断；客户端已交付，真实监听待验证；不参与动作权威 |
| 8770 | dev GM portal | 游戏内 `numen_devtools`（dev 配置） | **已构建，未安装/未重启，默认不监听**；GM 不进验收/学习 |

> 8765 由游戏进程持有，**不要**把“8765 端口开着”误读成“没有 dev”。真正的“谁在用 8765”由 lease/fencing 决定；端口探测只用于判断 numen/树是否在线。

## 4. 状态机

### 4.1 状态

| 状态 | 含义 | 判定（有效来源） |
|---|---|---|
| `OFF` | 没有工具持有 | 无有效 lease，且 8766/8767 未监听 |
| `TREE` | 树持有 / 声明为树态 | 有效 lease `kind=tree`，或 8766/8767 监听，或 mode.json 声明 TREE 且无 dev lease |
| `DEV` | dev 持有 lease | 有效 lease `kind=dev` 且 protect 未生效 |
| `DEV_PROTECTED` | dev 持有且拒绝被树启动 | 有效 lease `kind=dev` 且 `protect.until > now` |
| `TRANSITION` | 模式切换中 | 存在未过期的 `run/.mode-transition.lock` |

### 4.2 允许的切换

```text
OFF ──dev──▶ DEV ⇄ DEV_PROTECTED
OFF ──tree──▶ TREE
OFF ──force-dev──▶ DEV
OFF ──force-tree──▶ TREE
TREE ──force-dev──▶ DEV        （先 graceful handoff + 清锁）
DEV/DEV_PROTECTED ──force-tree──▶ TREE（释放 dev lease；不杀进程）
任意 ──off──▶ OFF              （有活跃他人 lease 时需 --force）
任意 ──异常/超时──▶ OFF         （fail-safe）
```

非对称规则：

- 树启动**不能**驱逐 `DEV/DEV_PROTECTED`；
- dev 正常启动**不能**驱逐树；要切换必须 Lead `force-dev`；
- Lead 的 force 不被 dev 拒绝；
- `force-*` 不 `taskkill` 任何进程；dev 进程在下次 heartbeat/ownership 校验时发现 lease 丢失并自行退出。

### 4.3 TRANSITION 超时兜底

1. 进入切换前写 `run/.mode-transition.lock`（含 pid / op / target / deadline / token）。
2. 同时把 `mode.json` 写成 `TRANSITION` + `deadlineAt`。
3. 正常完成→ 写目标态并删除 transition lock。
4. 进程崩溃/超时：下一次任何 mode 命令或 `tree-start` guard 调 `reconcile()`：
   - 检查 transition lock 的 pid 是否存活、deadline 是否过期；
   - 过期→ 强制释放 lease、写 `OFF`、写审计 `transition_recovered`；
   - 清理 stale transition lock。
5. **不会后台自动跑定时器**；兜底在“下一次操作”触发。这是 MVP 的显式限制。

## 5. Lease / fencing

### 5.1 lease 文件

默认：`runs/.pilot-lock.json`（`PILOT_LOCK_DIR` 可覆盖，测试必须覆盖到临时目录）。

字段：

```json
{
  "owner": "pilot-1a2b3c4d",
  "pid": 12345,
  "runId": "2026-11-10T...-abc123",
  "mode": "reference-pilot",
  "kind": "dev",
  "fencing": 7,
  "acquiredAt": "...",
  "heartbeatAt": "...",
  "expiresAt": "...",
  "protect": {
    "enabled": true,
    "runId": "...",
    "reason": "night-test",
    "until": "...",
    "heartbeatAt": "..."
  }
}
```

- TTL 默认 30s；持锁进程每 5s heartbeat。
- stale 判定：PID 死 **或** `expiresAt` 过期。
- 恢复：`recoverStale` 把旧 lease 归档为 `.pilot-lock.stale.<ts>.json` 后重新抢。

### 5.2 fencing token

- 计数器在 `runs/.fencing`，单调递增，仅由 mode 的切换/获取路径生成。
- **一个 lease 只有在 `lease.fencing === 当前计数器` 时才有效**（兼容旧 lease：无 `fencing` 字段的视为 legacy，仅在未 stale 时有效）。
- force 会推进计数：旧 lease 即使被旧进程 heartbeat 写回，也会因 fencing 落后而被 guard/status 判为无效。
- 关键动作（heartbeat、protect、release、pilot 每步 ownership 校验）都校验 owner + fencing。
- 目的：防止“被 force 掉的进程复活后继续认为自己持有 8765”。

### 5.3 为什么不是“检查 8765 端口占用”

8765 是游戏侧 numen MCP 服务端口，树和 dev 都是客户端；操作系统层面无法用 bind 表达“谁独占”。因此：

- 独占语义 = **lease + fencing**；
- 8765 探测只用来判断游戏/numen 是否在线；
- 8767/8766 探测用来判断树是否实际在跑（辅助事实）。

这一点与 docs/86 §11.1 的工程目标一致，但实现上必须诚实：**端口不是锁，lease 才是锁**。

## 6. Protect

```bash
node tools/pilot/mode.mjs protect on  --owner=<owner> --run-id=<runId> --reason=<why> --ttl-ms=600000
node tools/pilot/mode.mjs protect off --owner=<owner>
node tools/pilot/mode.mjs protect status
```

- 只能对有效 `kind=dev` lease 设置；
- `protect.until` 到期后状态自动回到 `DEV`；
- pilot 的 heartbeat 会同时续 protect TTL；
- `DEV_PROTECTED` 下树启动被拒，错误码 `dev_protected`；
- protect 不是永久锁：必须有 TTL；没有 `protect off` 也会到期。

## 7. Force

### 7.1 `force-tree`

```bash
node tools/pilot/mode.mjs force-tree --yes --reason="switch to A"
```

步骤（顺序固定）：

1. `reconcile()` + 获取 transition lock；
2. 推进 fencing（使旧 dev lease 失效）；
3. graceful handoff：`tree-control.handoff()`（`control --op exit`，**不 taskkill**；树不在则 noop）；
4. 清僵尸锁：`tree-control.clearLocks()`（失败不阻塞切换，但记录）；
5. 强制释放旧 lease；
6. 写 `mode.json = TREE`，审计 `force-tree`；
7. 释放 transition lock。

失败处理：handoff 失败 / 异常 → 释放 lease → 写 `OFF` → 退出码非 0。**不会停在 TRANSITION**。  
如果 handoff 失败但树仍在监听，`mode status` 会按端口事实显示 `TREE`（端口事实优先于 mode.json 的失败快照）；先处理树，再重试 force。

> `force-tree` 不会自己启动树；下一步用 `tree-start`（或 `启动树进程.bat`，见 §8）。

### 7.2 `force-dev`

```bash
node tools/pilot/mode.mjs force-dev --yes --reason="Lead switch"
```

步骤：

1. transition + fencing；
2. graceful handoff 树（若在跑）；
3. 清锁；
4. 释放旧 lease；
5. 申请 `kind=dev` lease（含新 fencing）；
6. 写 `DEV`；默认前台持有并 heartbeat，直到 Ctrl-C；`--once` 只申请后退出（脚本用，退出即 stale，慎用）。

### 7.3 幂等与并发

- **二次确认 + runId**：CLI `force-*` 必须带 `--yes`；审计与 `detail.runId` 绑定本次切换（未给则生成 `force-*<timestamp>`）。
- **幂等**：重复 `force-tree` 结果仍为 `TREE`；重复 `force-dev` 结果仍为 `DEV`（fencing 会递增）。第二次不应报错。
- **并发**：两个 force 同时跑，只有一个能拿到 transition lock；另一个快速失败（退出码 `4`，`transition_busy`），不改状态。最终状态必须是一个完整 JSON + 无残留 transition lock。
- force 期间不要手动删 `run/.mode-transition.lock`；等 deadline 或跑 `mode recover`。

## 8. 树启动 guard（wrapper + src 入口）

### 8.1 正确启动方式

```bash
node tools/tree-start.mjs
```

`tree-start` 做的事：

1. `reconcile()`：清理 stale lease / 过期 TRANSITION（fail-safe 到 OFF）；
2. 读有效 lease：
   - `kind=dev` → 拒绝，退出码 `3`，错误码 `dev_active` 或 `dev_protected`；
   - `kind=tree` 且树已在跑 → 拒绝 `tree_already_running`；
3. 探测 8766/8767：已在监听 → 拒绝 `tree_already_running`；
4. 干净状态 → `claimTreeLease()`（`kind=tree` + fencing）；
5. `spawn node src/daemon.mjs`，前台等待；运行期间每 5s heartbeat；
6. 子进程退出 → 释放 tree lease → 写 `OFF`。

支持：

```bash
node tools/tree-start.mjs --dry-run        # 只跑 guard，不启动
node tools/tree-start.mjs --fail-closed    # guard 自身异常时拒绝启动
node tools/tree-start.mjs --json           # 机器可读输出
```

> 仅自测：设置 `PILOT_TREE_TEST_CMD=<fake .mjs>` 可替换被启动的子进程，用于验证
> claim→spawn→release 全链而不启动真实树。生产环境不要设置该变量。

### 8.2 直接启动 `node src/daemon.mjs`（已由 src 入口 guard 拦截）

`src/daemon.mjs` 的第一段可执行代码（在 `loadConfig()` / `loadNumenEndpoint()` 之前）执行 `activeDevLease()`：

1. `TREE_ALLOW_DEV=1` → 跳过检查（紧急人工绕过）；
2. 读锁：默认 `runs/.pilot-lock.json`；`TREE_GUARD_LOCK` 可覆盖路径，仅用于自测，生产不要设置；
3. lease 的 `kind`（或 `mode`）匹配 `dev|pilot|mode`，或 `owner` 以 `dev|pilot|mode` 开头；
4. `expiresAt` 未过期，且 PID 活着（`process.kill(pid, 0)`；`EPERM` 视为活着）；
5. 命中 → stderr 打印 `[tree-guard] dev lease active ...` / `refuse to start tree` / `stop dev first ...`，并 **`process.exit(3)`**；不会加载配置、不会监听 8766/8767。

干净状态、无 lease、stale（过期/PID 死）、非 dev/pilot/mode lease → 正常启动。**权威仍是 lease**，`mode.json` 不参与判断。

可重复证据（临时锁，不碰真实锁、不启动真实树）：

```bash
node tools/pilot/mode-selftest.mjs        # T1–T10，wrapper/mode 回归
# src 入口 guard：见 logs/src-guard-selftest.json
#   G3: TREE_GUARD_LOCK=<temp> node src/daemon.mjs -> exit 3 + [tree-guard]
#   G4: stale/过期/PID 死/非 dev lease 不拦截
#   G5: TREE_ALLOW_DEV=1 源码级校验
```

紧急绕过（仅在确认 dev 已停、只是 lease 残留、且需要人工恢复树时）：

```bash
TREE_ALLOW_DEV=1 node src/daemon.mjs
```

绕过不会 claim tree lease，也不会释放 dev lease；事后用 `mode recover` / `off --force` 清残留。任何情况下仍优先：

- 启动树走 `tree-start.mjs` / `启动树进程.bat`：它额外 claim tree lease、探测端口并 heartbeat；
- 不以“直接启动现在也被拒”为由改验收口径或树行为；`src` guard 只是入口兜底。

### 8.3 fail-safe 策略

| 场景 | 默认行为 | `--fail-closed` |
|---|---|---|
| 无 lease / 干净状态 | 放行（100% 可启动） | 放行 |
| lease stale（PID 死/过期） | 清理后放行 | 清理后放行 |
| lease 有效且 `kind=dev` | 拒绝 | 拒绝 |
| `mode.json` 损坏/缺失 | 忽略（它不是锁） | 忽略 |
| lease 文件损坏/读失败 | **放行 + 警告 + 审计** | 拒绝 `guard_error` |
| 端口探测异常 | 放行 + 警告 | 拒绝 |
| fencing 读失败 | 视为无有效 lease（放行） | 拒绝 |

干净状态必须可启动是硬要求；fail-closed 只作为高安全场景的可选开关。

`src` 入口 guard 的 fail-safe 更简单：锁文件缺失/损坏/读失败、lease 过期、PID 死、或 lease 不是 dev/pilot/mode → **放行**；只有确定活跃的 dev/pilot/mode lease 才拒绝（`exit 3`）。`TREE_ALLOW_DEV=1` 跳过全部检查；`TREE_GUARD_LOCK` 只改读取路径，不改变判断。

## 9. 恢复流程

### 9.1 stale lease + PID 死

```bash
node tools/pilot/mode.mjs status         # 应显示 stale / pidAlive=false
node tools/pilot/mode.mjs recover        # 归档 stale lease，写 OFF
# 或直接 node tools/tree-start.mjs（guard 内部会 recover）
```

### 9.2 force 中途崩溃 / TRANSITION 卡住

```bash
node tools/pilot/mode.mjs status         # state=TRANSITION, transition 过期
node tools/pilot/mode.mjs recover        # 释放 lease → OFF
```

`recover` 是幂等的。

### 9.3 dev 进程还活着但 lease 被 force

不需要杀进程：

- 旧进程的 heartbeat 会因 fencing 不匹配失败；
- pilot run 在下一步 ownership 校验时 abort `lock_lost`；
- mode holder 检测到 lease 丢失后退出（不写 OFF，避免覆盖 force 的目标态）。

### 9.4 树启动失败

`tree-start` 会在子进程退出后释放 lease 并写 `OFF`；若 wrapper 自身被杀，tree lease 在 TTL（默认 15s）后 stale，`recover`/下一次 guard 清理。

### 9.5 完全手动复位（最后手段）

```bash
node tools/pilot/mode.mjs off --force
```

只释放工具侧 lease/状态，不杀游戏、不 taskkill。树进程本身用 `control --op exit` 优雅退出。

## 10. 文件与日志

| 路径 | 内容 | 说明 |
|---|---|---|
| `runs/.pilot-lock.json` | 当前 lease | 唯一锁真相 |
| `runs/.fencing` | fencing 计数器 | 单调递增 |
| `runs/.pilot-lock.stale.*.json` | 归档的 stale lease | 证据 |
| `run/mode.json` | 人类可读快照 | **不是锁** |
| `run/.mode-transition.lock` | 切换互斥 | 含 deadline/token |
| `logs/preemption.jsonl` | 切换/拒绝/force 审计 | 追加 JSONL |
| `logs/mode-selftest.json` | 自测证据 | 每次覆盖 |
| `logs/src-guard-selftest.json` | src 入口 guard 证据 | G1–G6；临时锁，不启动真实树 |
| `logs/tentacle-client-selftest.json` | 触手客户端证据 | 12/12；临时 fake HTTP，不碰真实 8769 |
| `logs/analyze-run-selftest.json` | 分析器证据 | 11/11；临时 run/归档 |
| `runs/<runId>/tentacle_use.jsonl` | 触手诊断使用 | 每次调用一行（含失败） |
| `runs/<runId>/GOAL.md` | docs/91 GOAL 合同 | prepare 生成；Operator 不改 |
| `runs/<runId>/manifest.json` | run 状态/phase/holder/lease | prepare/close 更新 |
| `runs/<runId>/OPERATOR-BRIEF.md` | Operator 一页任务 | 只执行/不分析/停条件/日志路径 |
| `runs/<runId>/.holder-stop` | holder 优雅停止标记 | close 写入；holder 自行释放 lease |
| `archive/<runId>/roundtable-pack.md` | 圆桌包初稿 | analyze 生成；非验收 |
| `runs/<runId>/gm.jsonl` | GM 使用 | 含 selfChallenge/前后态/assisted |
| `archive/<runId>/analysis.{json,md}` | 一次性分析归档 | 只读摘要；不改 run |
| `runs/<runId>/...` | pilot 运行产物 | 既有 |

测试必须覆盖 `PILOT_LOCK_DIR` / `PILOT_MODE_RUN_DIR` / `PILOT_MODE_FILE` / `PILOT_PREEMPTION_LOG` 到临时目录，**不得**动真实 lease、真实端口、真实游戏。

### 10.1 触手只读客户端

```bash
node tools/pilot/tentacle-client.mjs --uuid=<uuid> --run-id=<runId> \
  --purpose="diagnose water" --fields=self,terrain,entities,water,landmarks
node tools/pilot/tentacle-client.mjs --health
```

- 默认 `http://127.0.0.1:8769`，host/port 可配但默认拒绝非 loopback；
- 未给 `--run-id` 时 CLI 自动生成 `tentacle-diag-<ts>`；库调用同样自动生成；仅显式 `journalPath:null` 才关闭记录（调试用）；
- 只发 GET；`/perception` 的 `self/terrain/entities/water/landmarks` 是同一响应的投影；
- 每次调用（含本地校验/超时/坏 JSON/网络失败）写 `tentacle_use.jsonl`：
  `{ts,schema,source,authority:'diagnostic-only',actionPrecondition:false,assisted:false,runId,purpose,fields,query,ok,summary|error}`；
- **非权威**：不得把触手结果当动作前置条件；驾驶优先用 numen 现场观测；landmarks/water 的穿墙/未过滤问题必须标注；
- 失败码：`missing_uuid`/`invalid_uuid`/`invalid_fields`/`invalid_param`/`network_error`/`timeout`/`invalid_response`/`http_<status>`/`server_not_ready`/`entity_not_found`/`tentacle_error`。

### 10.2 一次性 run 分析器

```bash
node tools/pilot/analyze-run.mjs --run=<runId|path>          # 默认只打印路径 + 一句话
node tools/pilot/analyze-run.mjs --run=<runId> --print       # 人工调试才打印正文
```

- 只读 run 目录；输出 `archive/<runId>/analysis.json` + `analysis.md`；
- 内容：run 基本信息、`tokens/llmCalls/steps/repeatedObservations`、时间分段、失败（abort/observe/action/GM/触手）、GM/触手使用摘要、文件缺失、畸形 JSONL 行数；
- 默认不把 trace 正文回灌 Lead；分析器只产假设/缺口，不作验收证据；
- 归档 `analysis.*` 会覆盖同 run 上一次分析；不删除 run 原始文件。

### 10.3 docs/91 流水线（`tools/devtool.mjs`）

一条薄编排命令链，不启动树/游戏、不 taskkill、不实现 GM/LLM：

```bash
# Lead：Goal JSON -> run + 后台 lease holder + Operator 简报
node tools/devtool.mjs prepare --goal=<goal.json|inline-json> --run-id=<id> [--topic=]
# Operator 子体：只执行，不分析
node tools/devtool.mjs operator-brief --run=<id>
# Lead：停本 run 的 holder、释放 lease、mode OFF、验证无锁
node tools/devtool.mjs close --run=<id> [--reason=]
# Analyst 子体：只读 run，生成 analysis.* + roundtable-pack.md
node tools/devtool.mjs analyze --run=<id>
# 状态
node tools/devtool.mjs status --run=<id>
```

- **GOAL 校验**：`goal/budget/environment/allowed/forbidden/success/stop/logs/pack` 缺一即 `invalid_goal`（退出码 2），不建 run；模板在 `tools/templates/GOAL.md`。
- **prepare**：先跑 mode 预检（树活跃/已有 lease 直接失败），再建 `runs/<runId>/`、写 `GOAL.md` + `manifest.json` + `OPERATOR-BRIEF.md`；通过 `mode.mjs dev --hold` 启动 **detached** holder，等 lease owner/pid/fencing 对得上后才返回；记录 `holderPid/fencing`。**不启动树/游戏**。
- **holder 停止**：`PILOT_HOLDER_STOP_FILE`（本 run 的 `.holder-stop`）是唯一优雅停止通道；`holdLease` 每 2s 检查一次，命中后自行 `exitDev`。`close` **不发 OS kill**；若 holder 已失联，只对 owner 匹配的本 run lease 调 `exitDev`（失败才 `mode off --force` 兜底），最后验证锁已消失、mode 回 `OFF`。
- **analyze**：调用 `analyze-run.mjs`（只读 run），额外写 `archive/<runId>/roundtable-pack.md`；默认 stdout 只有 analysis/json/pack 路径 + 一句摘要。pack 是机械初稿，失败分类（capability/material/unknown）必须由 Analyst 复核，不作验收证据。
- **角色**：DSH 子体是 Operator 路径；`run.mjs` 的 OpenAI-compatible provider 是可选自动循环，不是流水线前提。GM 仅 GOAL 明确允许时可用；本工具不新增 GM/LLM。
- **隔离**：`PILOT_RUNS_DIR`、`PILOT_MODE_RUN_DIR`、`PILOT_LOCK_DIR`、`PILOT_TREE_CONTROL_PORT`、`PILOT_TREE_MCP_PORT`、`PILOT_NUMEN_PORT`；额外 `PILOT_ARCHIVE_DIR`。测试必须覆盖到临时目录/临时端口，不得碰真实 lease、真实游戏。

## 11. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `tree-start` 退出 3 `dev_active` | 有 dev lease | 确认是否真在跑；`mode status`；必要时 `force-tree` |
| `tree-start` 退出 3 `dev_protected` | protect 未到期 | 等 TTL 或 `protect off` |
| `tree-start` 退出 3 `tree_already_running` | 8766/8767 已监听 | 已有树；先 `control --op exit` |
| `force-*` 退出 4 `transition_busy` | 另一个切换在跑 | 等 deadline / `mode recover` |
| `status` 显示 `TRANSITION` 很久 | 切换进程崩溃 | `mode recover` |
| `status` 显示 lease 但 `pidAlive=false` | stale | `mode recover` |
| `heartbeat` 报 `not owner` / `fencing mismatch` | 被 force 接管 | 旧进程应退出，不要抢回 |
| `mode.json` 与 `status.state` 不一致 | mode.json 只是快照 | 以 `status` / lease 为准 |
| 直接 `node src/daemon.mjs` 退出 3 + `[tree-guard]` | src 入口 guard 检测到活跃 dev/pilot/mode lease | 正常拒绝。确认 dev 是否真在跑；需要起树先 `mode status`，必要时 Lead `force-tree` |
| 直接 `node src/daemon.mjs` 仍启动 | 无活跃 dev lease / lease 已过期或 PID 死 / 设置了 `TREE_ALLOW_DEV=1` / 跑的是旧代码 | 先确认以上；需要强制拦截时清 `TREE_ALLOW_DEV`。这不是 wrapper 的替代，仍应走 `tree-start` |
| 端口探测误报 | 本机其他进程占用 | 用 `PILOT_TREE_*_PORT` 指定测试端口 |

## 12. Token 预算与效率（docs/86 §11.4 / docs/84 §9）

试驾员必须把 token 当预算，不是免费资源。工具侧约束：

### 12.1 硬预算（每次 run 必须显式或默认）

```bash
node tools/pilot/pilot.mjs run --provider=openai \
  --steps=200 --minutes=20 --max-tokens=200000 ...
```

- `--steps` 默认 200；`--minutes` 默认 20；`--max-tokens` 默认 200000；
- 三者取先到：`max_steps` / `max_minutes` / `max_tokens`；
- 目标谓词达成（`target_reached`）或 LLM `stop` 立即停；
- 无预算长跑禁止。

### 12.2 manifest 指标

`runs/<runId>/manifest.json` 必须能回答“花了多少、重复多少”：

- `tokens`：provider 返回的 `usage.total_tokens` 累加（无 usage 时为 0）；
- `llmCalls`：实际调用 provider 的次数；
- `repeatedObservations`：与上一步观测哈希相同的次数；
- `steps` / `startedAt` / `endedAt` / `abortReason`；
- `observations.jsonl` 带 `hash` + `unchanged`，可用于复核重复率。

### 12.3 效率指标（用于后续优化，不作验收）

- **tokens / 有效观测**：有效观测 = 发生变化的观测；
- **LLM 调用数 / 有效决策**：能脚本做的不要交给 LLM；
- **重复观测率**：`repeatedObservations / steps`；
- **每步信息增益**：观测 diff 的字段数 / tokens；
- **目标达成所需 token**：`target_reached` 时的累计 tokens。

### 12.4 行为约束

- 确定性脚本/探针优先，LLM 只做判断/歧义；
- 观测单行/差分，禁止整页 map/help/长列表；
- 一次 Lua 批量取多字段，减少往返；
- 不重复读未变化状态；pilot 不写 summary、不回灌 trace；
- 达到目标 / 无新信息 / 卡死倾向立即停。

### 12.5 当前限制

- 只有 provider 返回 usage 才能统计 token；mock 为 0；
- `analyze-run.mjs` 可生成每次 run 的效率摘要（tokens/有效观测/重复率），但只作诊断，不作验收；
- 效率指标不得用来给 Track A 设“达标”，也不得从 Track B 反推树能力（docs/82）。

## 13. 升级 / 回滚

### 13.1 版本与兼容

- 工具版本写在 `mode.mjs` / `mode-selftest.mjs` 的 `VERSION`，本手册版本在页首。
- 状态文件 `version: 1`；lease 新增字段 `kind/fencing/protect` 为可选，旧 lease（无 `fencing`）按 legacy 处理。
- `run/mode.json` 不参与锁决策，升级不要求迁移它。

### 13.2 升级步骤

1. `node tools/mode.mjs status`，确认 `OFF` 或记录当前 `DEV/TREE`；
2. 若是 `DEV`：让 pilot 正常收口，或 `mode off --force`；
3. 若是 `TREE`：让树 `control --op exit` 优雅退出（不 taskkill）；
4. 备份 `runs/`、`run/mode.json`、`runs/.fencing`（可选，用于审计）；
5. 替换 `tools/` 下文件；
6. 跑 `node tools/pilot/mode-selftest.mjs`（应 10/10）；
7. 跑 `node tools/tree-start.mjs --dry-run`，确认干净状态放行；
8. 再启动 dev/树。

### 13.3 回滚步骤

1. 先停 dev/树（同上），确认无活跃 lease；
2. `node tools/mode.mjs off --force`，清 mode 状态；
3. 恢复旧版 `tools/`；
4. **不要删除** `runs/<runId>`、`archive/<runId>`、`logs/preemption.jsonl`（审计证据）；
5. 旧版若不认识 fencing 字段，先确认 `runs/.pilot-lock.json` 不存在再启动；
6. 跑旧版 recovery drill / preflight。

### 13.4 禁止

- 带活跃 lease 直接覆盖工具并启动树；
- 用删除 `runs/` 的方式“解决”锁冲突；
- 回滚时删除 `preemption.jsonl` 或 selftest 证据。

## 14. 测试与证据

```bash
node tools/pilot/mode-selftest.mjs
# 证据：logs/mode-selftest.json
node tools/pilot/tentacle-client-selftest.mjs
# 证据：logs/tentacle-client-selftest.json（12/12）
node tools/pilot/analyze-run-selftest.mjs
# 证据：logs/analyze-run-selftest.json（11/11）
node tools/pilot/devtool-selftest.mjs
# 证据：logs/devtool-selftest.json（10/10；临时目录/端口）
```

devtool 自测覆盖：prepare→lease 就绪→operator-brief→status→close；合成 run 的 analyze/pack；tree 活跃、已有 lease、goal 缺字段三类失败；真实 `runs/.pilot-lock.json`/`.fencing`/`run/mode.json` 未变；不使用 taskkill。

src 入口 guard 证据：`logs/src-guard-selftest.json`（G1–G6；伪造 lease 时 `node src/daemon.mjs` 退出 3；干净状态只做 `tree-start --dry-run`/端口检查，不启动 daemon）。

触手/分析器自测均使用临时目录与随机端口，**不连真实 8769、不读真实 runs/archive、不改 run**。

验收矩阵见 `tools/pilot/TESTPLAN.md`。自测不启动真实树、不连游戏、不 taskkill、不碰真实 lease（全部临时目录 + 模拟端口）。

## 15. 变更记录

- **2026-11-10.1**：MVP 实现 `mode.mjs` / `tree-start.mjs` / `mode-selftest.mjs`；lease fencing、protect、force、TRANSITION 超时回 OFF；pilot `run.mjs` 集成；明确 GM 未交付与 `src` hook 待 Lead 授权（该 hook 已在 .4 完成）。
- **2026-11-10.2**：纳入 docs/86 §11.4 / docs/84 §9 的 token 预算与效率指标；归档 manifest 补最终 `archivedAt/archiveDir` 副本。
- **2026-11-10.3**：收尾文档；明确 `force --yes` + runId 审计、GM/8770 未交付、`src` hook 绕过现象与临时纪律；补交付清单 `MVP-COMPLETE.md`；README/TESTPLAN 回填 10/10、9/9、21/21 与真实状态检查。
- **2026-11-10.4**：`src/daemon.mjs` 入口启动 guard 已完成：活跃 dev/pilot/mode lease 时直接启动 `exit 3`，`TREE_ALLOW_DEV=1` 紧急绕过，`TREE_GUARD_LOCK` 支持临时锁自测；更新 README/MAINTENANCE/TESTPLAN/MVP-COMPLETE，证据 `logs/src-guard-selftest.json`（G1–G6）；“直接 daemon 绕过 guard”条目从待办移除。
- **2026-11-10.5**：第二阶段非 GM 收尾：新增 `tentacle-client.mjs`（只读 8769、`tentacle_use.jsonl`、非权威标记、结构化失败）与 `analyze-run.mjs`（只读 run、`archive/<runId>/analysis.*`、默认不打印正文）；新增 2 个自测（触手 12/12、分析器 11/11；`logs/tentacle-client-selftest.json`、`logs/analyze-run-selftest.json`）；文档明确 GM 已构建但未安装/未重启、真实 LLM 待 endpoint/key、触手真实 8769 待验证。
- **2026-11-10.6**：docs/91 流水线：新增 `tools/devtool.mjs`（prepare/operator-brief/close/analyze/status）、`tools/templates/GOAL.md`、`tools/templates/roundtable-pack.md`；`mode.mjs` 的 `holdLease` 增加可选 `PILOT_HOLDER_STOP_FILE` 优雅停止（不 taskkill）；新增 `devtool-selftest.mjs`（10/10，`logs/devtool-selftest.json`）；README/MAINTENANCE 增加用法与隔离说明。仍不实现 GM/LLM。

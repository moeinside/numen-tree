# 134. 诊断工具：纯判定 + live probe

> 2026-11-12。P1.1 第一片只读诊断。

## 1. 纯判定

`src/diagnose.mjs`

输入：

```text
now / plan / current / actionLock / wait / progress / contradiction / stallMs
```

输出：

```text
progressing | waiting | stalled | contradiction | unknown
+ reason + evidence + suggested
```

规则：

```text
contradiction 最高
wait.active 且 reason 明确 → waiting
worldDelta 或 stepsDelta → progressing
actionLock → waiting
plan active 且无进展 ≥20s → stalled
其余 → unknown（不降级成 stalled）
```

自测：

```text
probe/diagnose-selftest.mjs
8/8 PASS
```

## 2. live probe

`tools/diagnose.mjs`

```text
读 8766 /status
8771 抓前后快照（窗口默认 5s）
算 stepsDelta + worldChanges
调 diagnose()
```

用法：

```text
GROUNDTRUTH_TOKEN=... node tools/diagnose.mjs --window-ms 3000
```

不派动作，只读；快照写入 groundtruth store，不写世界。

## 3. 真实输出（2026-11-12）

```text
plan=pl6
before/after status=suspended
stepsDelta=0
worldChanges=0
wait=field_guarded
verdict=waiting
suggested=continue_waiting
```

这是正确结果：当前是合法挂起，不是 stalled。

## 4. 当前限制

```text
窗口内只抓一次前后快照，不是 atom 边界自动快照
worldDelta 仅覆盖快照区域（默认同伴周围 ±2）
inventoryChanged 尚未接入
unknown 仍可能偏多
live probe 依赖 8766 + 8771 同时在线
```

## 5. 下一步

```text
把 diagnose 接入 status/CLI（只读字段）
自动 atom 前后快照
inventory delta
wait 证据结构化（对象/恢复条件/上限）
```

## 6. 状态/CLI 接入

CompanionState.snapshot() 新增只读字段：

    diagnosis: { verdict, reason, evidence, suggested }

node src/cli.mjs status 多一行诊断。

只依赖内部证据：plan.status / waitReason / paused / actionLock / lastActionAt。
真实 worldDelta 仍由 live probe 提供。

## 7. 下一步

    自动 atom 前后快照
    inventory delta
    wait 证据结构化（对象/恢复条件/上限）
    status 诊断与 live probe 合并
## 8. live probe 补强（inventory / wait）

    已加：
    - before/after inventory 对比 → inventoryChanges
    - wait 证据：reason / recoverable / until
    - diagnose evidence.wait 带 recoverable

    实测：
    stepsDelta=0
    worldChanges=0
    inventoryChanges=0
    plan active→suspended
    verdict=waiting
    reason=waiting: no_progress
    recoverable=true

    说明：
    “waiting: no_progress” 是树显式挂起后的等待语义，
    不是把未知当 stalled。
## 9. 自动 atom 前后快照（已接）

    src/groundtruth-client.mjs
    openAtomTx  → snapshot before
    finishAtomTx → snapshot after

    仅当 GROUNDTRUTH_TOKEN 设置时启用。
    fire-and-forget：不 await、不抛错、不参与决策。

    真实证据：
    lastAtomSnapshot = { atomId: atom.scan_container, phase: after, seq: 24 }
    manifest runId=tree-bigwhale calls=20 byKind={snapshot:20}

    注意：
    Track A 验收 run 不要设置 GROUNDTRUTH_TOKEN，
    否则 manifest calls>0，会正确判 Track A 失格。
## 10. status + live 合并

    diagnose.mjs 输出：
      diagnosis.live      —— 世界证据版
      diagnosis.internal  —— /status 内部证据版
      diagnosis.combined  —— 合并结论

    合并规则：
      显式 wait 压过 world-only stalled
      live unknown → internal
      internal contradiction → 优先
      live progressing 不被 internal unknown 覆盖

    验证：
      diagnose selftest 11/11 PASS
      真实 combined = waiting
## 11. 自动 contradiction

    新增规则：
      plan active
      + currentMissing
      + 无 wait
      + 无 actionLock
      + 已持续 >= 2s
      → contradiction

    不依赖调用方手工传 contradiction。
    legal wait 仍优先 → waiting，不会误判。

    验证：
      diagnose selftest 13/13 PASS
      replay 33/33、261/261 PASS
## 12. PM conditional 补件（2026-11-12）

    1) 受控 live contradiction
       probe/diagnose-live-selftest.mjs
       真实 HTTP probe + 真实 groundtruth 快照 + mock 树状态
       contradiction / waiting-lock / unknown-recent / out-of-scope
       4/4 PASS

    2) worldDeltaScope
       diagnose evidence 带 worldDeltaScope + worldDeltaOutOfScope
       越界 → unknown，不默认 progressing
       纯测试 + live out-of-scope 均覆盖

    3) wait 完整性
       wait 必须 reason + until/blockedBy 二选一，否则 unknown
       live wait 带 blockedBy

    4) 唯一验收口径
       P1.1 以 live probe 输出为准
       纯函数 selftest 只算契约层
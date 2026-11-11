# 98. P0-0b Phase B（第一刀）：真实 atom 边界接入

> 2026-11-10。PM 已确认可接 lane。本轮只接**抢占判定**与 trace，不改 Day1 口径、不改中断表。

## 已接入

`src/lane.mjs` 两处 `executeAtom`（tactic / strategy）：

```text
原子开始前
→ priorityPreempt(current=goal, incoming=interrupt)
→ canPreempt(..., atAtomBoundary=true)
→ 允许则返回 preempted；拒绝则继续
→ trace.info('priority_decision', ...)
```

映射：

```text
consequenceFromScore(priority)
  >=90 death_risk
  >=70 irreversible_loss
  else reversible_need
```

这是 Phase B 的兼容映射；后续动作应直接声明 consequence/reversal，不再依赖数字阈值。

## 验证

- `probe/priority-selftest.mjs`：19/19 PASS
- `probe/arbiter-selftest.mjs`：11/11 PASS
- `probe/replay.mjs`：21/21 场景、185/185 断言 PASS
- `src/lane.mjs` syntax PASS
- 未运行真实游戏；未接 GM/测试员；未改验收口径

## 第二轮：显式声明 + action-tx + 离线三场景

已补：

- `src/priority-declarations.mjs`：interrupt id → consequence/reversal 显式表；P0–P4 → consequence 表；
- `src/priority-preempt.mjs`：真实 atom 边界抢占判定 + `recordInterruption` 当前承诺记录；
- `src/action-tx.mjs`：`beginTx` 增加 consequence/reversal；`interruptTx` 记录 `interruptedBy` 与 `recovery=needs_settle|reconcile`；
- `lane.mjs` 改用 `decidePreemption`，不再用数字猜 consequence；
- `probe/priority-preempt-selftest.mjs`：allowed preempt / 不可逆拒抢 / keep + action-tx 中断记账，**7/7 PASS**；
- replay：**21/21 场景、185/185 断言 PASS**。

## 第三轮：action-tx 接 lane

已接：

- 每个 tactic/strategy goal 开始时 `openPriorityTx`：`beginTx` 记录 consequence/reversal；
- atom 抢占时对 `st.priorityTx` 调用 `interruptTx('preempted', { by, incomingConsequence })`；
- goal 收尾时 `closePriorityTx`：settle/postcheck；被中断事务保持 unknown，不携带 success；
- `recordInterruption` 仍记录进程内 promises，但 current 生命周期尚未完整（未做 pending_release/跨目标恢复）。

验证：

- lane syntax PASS
- priority-preempt 7/7
- replay 21/21、185/185

## 第四轮：incoming 字段 + 进程内 current 生命周期

- `decidePreemption` 返回 `incoming`，并在 decision/event 中显式带 `incomingConsequence/reversal`；
- lane 的 `interruptTx` 现在能拿到非空 incomingConsequence；
- `beginCommitment` / `markPendingRelease` / `settleCommitment`：
  - goal 开始 `active`；
  - 抢占 `pending_release`，记录 interruptedBy；
  - goal 收尾清空 current；
- 离线测试 11/11；replay 21/21、185/185。

## 第五轮：架构师结论落地

架构师指出的：
- 段 tx 只做承诺，不做恢复；原子 tx 另行（Phase C）；
- `beginCommitment` 不得覆盖旧 current；
- legacy 必须 fail-closed；
- reason 对账需 goal/atom/tx + incoming consequence。

已落地：

- `beginCommitment` 先归档旧 current（interrupted/lost），不静默覆盖；
- `settleCommitment` 保留 `finalStatus` 与 `pendingMs`，不靠覆盖；
- 抢占状态改叫 `preempted`，不再与 Phase A 的 `pending_release` 混名；
- `decidePreemption` 缺显式声明 → `legacy_undeclared`，不抢占，并计数；
- action-tx 已在 lane 真实 goal 路径打开/中断/收尾；
- 真实 lane 三场景夹具：
  - `priority_deny`：不可逆拒同后果抢占 → 5/5 PASS
  - `priority_keep`：死亡风险拒绝低后果 → 5/5 PASS
  - `tactic_preempt`：allowed preempt → 既有场景
- replay：**23/23 场景、195/195 断言 PASS**。

## 架构红线（Phase C 前必须堵）

1. **分母红线**：`preempted` 不得计入 capability_fail；抢占单独计数，不算本段失败。
2. **边界一致性**：`canPreempt` 判定与 atom `begin` 之间不得有异步缝；begin 时校验 tx generation/txId 未变，否则降级不可抢。
3. **恢复红线**：`interrupted/lost` 无世界 postcheck 前不得作为恢复依据；current 未跨重启持久化前，不承认“重启后续跑”。
4. **静默降级红线**：`legacy_undeclared` 必须计数/告警/设占比门槛；否则 fail-closed 会退化成“永不抢占”的静默 fail-open。
5. Phase C 接 `current_ineligible` 时，不得与“不抢占”共用返回码，否则绕开第 1 条。

## 第六轮：4 条架构红线

- **分母**：`preempted` 单独计数（`priorityStats.preempted`）；strategy 不再把 `preempted` 计入 `noteFailure`；
- **边界一致**：executeAtom 在 begin 后复核 `st.priorityTx` 与 tx 状态；`atom.settle` 豁免；不一致返回 `preempted/priority_tx_changed`；
- **恢复**：`interrupted/lost` 只归档，不作为 resume 依据；current 未跨重启前不承认重启续跑；
- **静默降级**：`legacy_undeclared` 不抢占并计入 `priorityStats.legacy`；真实 trace 前设占比门槛；
- `current_ineligible` 仍留在 Phase C，与 `preempted` 分开。

验证：

```text
priority 19/19
priority-preempt 15/15
replay 23/23 场景、195/195 断言
```

## 第七轮：reason 契约元数据

- `priority_decision` 事件增加 `goalId`、`atomId`、`txId`；
- 用于后续 decision / atom tx / world postcheck 三元组对账；
- replay 保持 23/23、195/195。

## 第八轮：atom 级 tx 三级关联

- `beginTx` 增加 `goalId/atomId/parentTxId`；
- lane 每个 `executeAtom` 创建独立 atom tx：
  - `goalId` = 当前 goal
  - `atomId` = 当前 atom
  - `parentTxId` = goal 级 tx
- atom 成功/失败 settle + postcheck；异常中断；
- `priority_decision` 已带 goal/atom/tx 元数据。

验证：

```text
priority 19/19
priority-preempt 16/16
replay 23/23 场景、195/195 断言
```

## 第九轮：Phase C 起点

- lane 增加真实 `current_ineligible` 路径：
  - goal.eligible 在 atom 边界失效 → 独立返回码 `current_ineligible`；
  - 不再与 `preempted` 混用；
  - `priorityStats.ineligible` 单独计数。
- 新增 `src/priority-store.mjs`：
  - schema/hash/world/companion/epoch 校验；
  - 原子写，无 tmp 残留；
  - `prioritySnapshot` 只存 current/统计，恢复仍须世界 postcheck。
- 新增 `probe/priority-store-selftest.mjs`：5/5 PASS。
- replay：**24/24 场景、200/200 断言 PASS**。

## 第十轮：状态快照暴露

`state.snapshot()` 增加只读字段：

- `priority`：current / lastDecision / interruptions / settled 计数；
- `priorityStats`：preempted / legacy / completed / interrupted / ineligible；
- `priorityTx`：goal 级 tx id/status；
- `priorityAtomTx`：atom 级 tx id/atomId/parentTxId/status。

只读观测，不参与决策；replay 仍 24/24、200/200。

## 第十一轮：Phase B 收口

- L0–L5 决策审计：6/6 PASS（**契约级合成输入**，不是 lane 真实路径；真实路径留 Phase C）；
- `priorityStats` 增加 `decisions/reasoned/sameAtomFailures`；
- reason 覆盖计数；
- 同 atom 重复抢占计数；
- 全套：

```text
priority：19/19
priority-preempt：17/17
priority-levels：6/6
priority-store：5/5
replay：24/24 场景、200/200 断言
```

## 第十二轮：架构审计修复

- legacy 链路 fail-closed：
  - `openPriorityTx` / atom tx / decidePreemption 缺声明统一 `undeclared`；
  - `canPreempt` 对 undeclared current/incoming 直接拒绝；
- `currentReleased` 不再无条件释放：
  - 不可逆 current 失效 → `irreversible_release_blocked`，等世界 postcheck；
- `priority-store` epoch mismatch 改 fail-closed；
- 测试：priority 20/20、preempt 17/17、levels 6/6、store 5/5、replay 24/24、200/200。

## 第十三轮：cross-restart store 接入

- lane 构造时读取 `cfg.priorityStore.file`：
  - 恢复 `priorityStats`（跨重启累计）；
  - `priority` current **不自动恢复**，标记 `awaiting_world_postcheck`；
  - store 缺失/损坏/epoch mismatch 只告警，不启动 current。
- 写入仍是可选：`state.priorityStorePath` 未配置时 no-op。
- replay 24/24、200/200；priority-store 5/5。

## 第十四轮：真实 trace smoke

- 树真实启动/退出成功，8766/8767 正常；
- 但本次是 plan/direct skill，未走 tactic/strategy 的 priority tx；
- priority-state 未生成，priority_decision=0；
- 结论：**Phase C 里程碑未达成**，需补 direct skill/plan 的 priority tx，或构造真实 tactic+interrupt 场景。

## 结论

Phase B **有条件通过（离线阶段）**，不作为优先度系统已可上线。
条件与 Phase C 硬门见 `docs/100-PhaseC-入场门.md`。

## PM 审核结论（2026-11-10）

- 可作为 **Phase B 中间件**接受，但不是完成；
- replay 21/21 未证明 preempt 分支真的被走到，需补离线三场景：allowed preempt / denied（不可逆拒抢）/ keep，并断言 trace 有 `priority_decision`；
- 下一步顺序固定：
  1. action-tx `reversal` 声明 + current 生命周期；
  2. 离线三场景回放；
  3. 短程真实 trace 对账（reason 必须对 world/postcheck）；
- 进入真实 trace 前必须替换 `consequenceFromScore` 临时映射：改为按 interrupt/tactic 的显式 consequence 表，或冻结映射并逐项评审。

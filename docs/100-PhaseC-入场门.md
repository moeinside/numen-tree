# 100. Phase C 入场门（PM 条件冻结）

> 2026-11-10。Phase B 为**有条件通过（离线阶段）**，不得宣称优先度系统已可上线。  
> 以下为 Phase C 硬门；未过不得宣称可用。

## 1. 真实 trace 对账

- 每条 `priority_decision` 的 reason 必须能对上 world/postcheck 事实；
- 三元组：decision / atom tx / world evidence；
- 判负：decision=preempted 且世界已变但无 tx 记录 → “未记账中断”；
- 真实 trace 不允许只有合成输入。

## 2. 跨重启 current 与抖动

- current 生命周期跨进程持久化；
- 同因 suspend→resume ≤ 2 次/里程碑窗口；
- suspend 占总时长 ≤ 20%；
- 17s 级抖动 = 0；
- 跨重启累计，不清零；
- 未持久化前不得宣称“重启后续跑”。

## 3. 不可逆中断后的世界恢复

- `interrupted/lost` 必须经过世界 postcheck 才能 resume；
- 无 postcheck 的恢复一律禁止；
- 不可逆段被 death 抢占后的恢复判定必须落 trace。

## 4. legacy 与分母口径

- Track A 真实路径的 `legacy_undeclared` 占比必须报告，并设硬阈值；
- `preempted` 从 capability_fail 分母剔除的口径随审计版本冻结；
- 否则 Day1 失败率不可比。

## 5. L0–L5 证据等级

- Phase B 的 L0–L5 是**契约级合成输入**；
- Phase C 若要保留“真实 decision”表述，必须为 L0–L5 各补一条 lane 回放断言；否则只能称契约级。

## 6. 审计补充（2026-11-10）

- **plan 层**：`preempted` 不得进入 capability 分母；需真实 trace 验证，不能只靠 strategy 侧豁免；
- **legacy current**：未声明 current 在 `canPreempt` 直接拒绝，不只是报告占比；
- **epoch mismatch**：`priority-store` 已改 fail-closed；
- **postcheck 证据**：当前 `closePriorityTx/finishAtomTx` 的 evidence 来自执行结果，Phase C 必须换成世界观测，禁止“动作 ok = 世界达成”；
- **decision 分母**：`priority_decision` 分母定义（每次边界检查 vs 每次抢占）必须冻结，否则 reason 覆盖率不可比；
- **跨重启夹具**：同因 suspend→resume 跨进程累计，不能重启清零。

## 7. 真实 trace smoke（2026-11-10）

- 树真实启动 8766/8767、加载 bigwhale、优雅退出：通过；
- 但本次运行走 plan/direct skill，没有走 tactic/strategy 的 priority tx；
- `runs/priority-state.json` 未生成，`priority_decision` 为 0；
- 结论：**Phase C 里程碑未达成**；不能拿启动 smoke 冒充真实 trace 对账。

## 8. 真实 trace smoke（第二次）

- 修复 `/goal` 的 tactic consequence 映射（`P3 → reversible_need`）；
- 下发了真实 `tactic.move_segment`，并用 GM 生成 husk / 压 HP 作 interrupt 夹具；
- 树被自身 safety_hold / 死亡恢复抢占，priority_decision 仍为 0；
- 结论：**仍未达成 Phase C 里程碑**；需要隔离树的自主策略或专门的 fixture 世界。

## 9. fixture arena 尝试（第三次）

- 在 y=100 空中用 GM 搭 13×13 石盒（只放不拆；`fill air` 被世界保护拒绝）；
- bigwhale 移入，下发 priority=95 的 tactic；
- 用 GM 生成 husk + instant_damage 触发 interrupt；
- 结果：`hostiles=0`、HP 仍 20、`priority_decision=0`；
- 结论：**仍未达成 Phase C 里程碑**；夹具注入后树/观测没有形成预期危险状态。
- fixture 盒仍在 y=100，待后续清理；GM 全部标 assisted，不进 Track A。

## 10. 封闭测试盒真实 trace（第四次）

- 玩家 `moeisnide` 与同伴一起移入 y=100 的 13×13 封闭石盒；
- 真实树运行，priority store 已生成；
- 真实 `priority_decision` = 56，reasoned = 56，preempted = 0；
- 决策全部是 `lower_consequence`（在途不可逆 goal 拒绝可逆 stuck）；
- 说明：真实路径、reason、txId 已能落账；但 **allowed preempt 未出现**，世界 postcheck 仍是执行器自报；
- 结论：**Phase C 里程碑仍未达成**；下一步要让 fixture 出现“tactic 在跑 + death 级中断”，并补外部 postcheck。

## 11. 封闭盒 + 敌对夹具结果

- 玩家 `moeisnide` 与 bigwhale 同处 y=100 封闭盒；
- 树真实运行，priority store 生成；
- `priority_decision=56`，reasoned=56，preempted=0；
- 全部 `lower_consequence`：在途不可逆 `safety_hold/escape_stuck` 拒绝可逆 `stuck`；
- 未出现 allowed preempt；
- world postcheck 仍是执行器自报；
- 结论：**Phase C 仍未达成**；真实决策链已走到，但缺 allowed preempt 与外部 postcheck。

```text
Phase B：有条件通过（离线阶段）
Phase C：进行中
优先度系统：不可宣称已可上线
```

## 13. 真实 trace 审计（2026-11-10）

脚本：`probe/priority-trace-audit.mjs`  
证据：`logs/priority-trace-audit.json`

```text
decisions=59
codes: preempt=3, lower_consequence=56
incoming: death_risk=2, irreversible_loss=1, reversible_need=56
reasonCoverage=1
missing reason/goalId/atomId/txId = 0
store: preempted=3, decisions=59, reasoned=59, legacy=0
```

通过：

- 真实 decision；
- 真实 allowed preempt；
- goal/atom/tx 元数据完整；
- reason 覆盖 100%；
- legacy=0。

仍缺：

- world postcheck 仍来自执行器（不是外部世界快照）；
- 跨重启抖动夹具；
- L0–L5 真实回放。

## 15. world postcheck 接入

- `lane.worldPostcheck()` 用触手 8769 读 `perception`，不再用执行器返回值；
- 抢占分支写 `priority_postcheck` trace；
- replay 24/24、200/200 仍通过；
- 但最近一次真实 fixture 跑出 0 decision，**没有真实 postcheck 证据**；
- 代码已接，真实验证仍未完成。
- 最新真实跑：`priority_decision` 已带 world 快照（pos/hp/hunger/hostileCount），但本次全是 `lower_consequence`，未触发 preempt，因此没有 `priority_postcheck`。

## 16. 2026-11-10 收口决策

- 点子王：选 B（fixture 配置关自动 need），认为注入 goal 未进 `#runTacticGoal`，且清 hostile 导致测量缺失；不允许改主干。
- 总控：选 C（停止 Phase C 真实 postcheck，降级契约级）；A 留明天限时一次；不允许改主干。
- 采纳总控 C：今晚停止真实 postcheck 追逐，Phase C 标“契约级/未完成真实硬门”。
- 空中盒 3 次 allowed preempt 仅作机制参考，不作证据。
- 主线待办：确认 priority 是否真正重算；白天处理，不在深夜打补丁。

## 17. PM 评估（2026-11-10）

- 裁决：**不通过 Phase C 完整阶段门**；
- 原因：真实 `priority_postcheck=0`，三元组只完成 decision + atom tx 两环；
- 可接受“Phase C 契约级”降级，但必须原话记录：真实 postcheck 未验证、L0–L5 真实回放未做；
- 不得宣称优先度系统可用，不得作为 Day1 通过理由；
- 暂不进入 PM 阶段验收；
- 继续 fixture 的停止条件：最多 3 次受控尝试或 2 个游戏日，先到者；每次冻结参数，run 中干预作废；3 次内仍无 postcheck 即停止。

## 18. 当前正式状态

```text
Phase B：有条件通过（离线阶段）
Phase C：契约级通过（真实 postcheck 未验证）
优先度系统：不可宣称可用
Day1：未启动
```


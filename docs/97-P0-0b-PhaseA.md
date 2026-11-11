# 97. P0-0b Phase A：优先度契约（交 PM 审核）

> 2026-11-10。仅新增 `src/priority.mjs` + `probe/priority-selftest.mjs`；未接 lane/arbiter，未改现有行为。

## 交付

- `src/priority.mjs`
  - `CONSEQUENCE`：`death_risk > irreversible_loss > reversible_need`
  - `REVERSAL`：`irreversible | compensable | resumable`
  - `canPreempt()`：只允许在 `atAtomBoundary=true`；按后果/priority 比较
  - `choosePriority()`：纯函数式决策，返回 `choice/previous/decision/evals`
  - `priorityEvent()`：可观测事件
- `probe/priority-selftest.mjs`：18/18 PASS
- 现有 `probe/arbiter-selftest.mjs`：11/11 回归 PASS

## PM 反馈修复（2026-11-10）

- `current` 每轮用本次候选集重新校验 eligible；
- **非原子边界**：不释放，返回 `pending_release`，choice/previous 都是原 current；
- **到原子边界**：释放并返回 `current_ineligible`，previous 指向被打断的 current；
- 缺失/非法 `consequence` **不再静默降级**：候选不可用并累计 `invalidConsequences`；
- `reversal=irreversible` 参与 canPreempt：仅死亡风险可在原子边界抢占；同后果拒抢；
- 新增对应回归测试（18/18）。

## 关键语义（待 PM 确认）

1. **不可逆损失**高于**可逆需求**；饥饿/资源不能抢在途不可逆段；
2. **死亡风险**在原子边界可抢不可逆段；非边界一律不抢；
3. 同后果层按 priority；同层低优先不抢；
4. 无候选 → `no_eligible`；当前仍最高 → `keep_current`；
5. 每次决策带 `code/reason/from/to/atAtomBoundary`，Phase B 接 trace。

## 未做（Phase B）

- 未接入 lane/arbiter 的候选生成与执行器；
- 未接 `reversal` 声明到实际原子动作；
- 未接抖动/段重启/理由覆盖率计数器；
- 未改 Day1 行为。

## 请 PM 审核

1. 批准 / 有条件批准 / 驳回 Phase A；
2. 是否确认“不可逆段在原子边界可被死亡风险抢占”；
3. Phase B 是否允许改 `lane.mjs` 的候选选择/抢占路径；
4. Phase B 的验收：至少 1 个死亡风险抢占 + 1 个不可逆段拒抢 + 1 个 keep_current，且现有 replay 不回归。

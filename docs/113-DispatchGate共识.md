# 113. Dispatch Gate 共识（点子王 × MC）

> 2026-11-11。两轮对抗后共识。  
> 触发：`task craft_tools + 3 husk` 5s 内没有 `exec_gate_plan`，plan active/steps=0，current=strategy:safety_hold。

## 1. 共识

### 1.1 唯一入口

`dispatchGate()` 必须放在**所有动作发起前的唯一入口**：

```text
plan
strategy
interrupt/reflex
```

全部经过它，且顺序必须在 `pendingInterrupt` 判定之前。  
`#planControl` 只是调用方之一，不是 gate 所在。

### 1.2 无条件心跳

每次调用都写 `gate_tick` / `exec_gate_heartbeat`：

```text
path = plan | strategy | interrupt
goalId
lockOwner
pendingInterrupt
gateReason
decision = allow | hold | yield | deferred
```

**无变化也要写**，否则“没记录”无法区分“没执行”和“执行了但没写”。

### 1.3 锁让路共用

- 锁不属于请求者：返回 `{deferred, owner}`，不静默 return；
- 请求方记 `gateReason=lock_held_by:<owner>`；
- 持锁方记 `contended_by`；
- actionLock 带 `{owner, since, ttlMs, reason}`；
- `pendingInterrupt` 同样带 TTL，超时清除并 trace。

### 1.4 僵尸态即失效

```text
planStatus=active && steps_done=0
```

允许最多 1 tick 过渡，且必须带 `gateReason`；  
第 2 个 tick 仍成立 → 标 `stalled`，写 trace，触发一次仲裁重排，不等 watchdog。

## 2. 双方让步

- 点子王：
  - 收回“存在单一 dispatch 点”；
  - 承认没有 per-tick 心跳时，gate 缺失无法判负。
- MC：
  - 放弃“plan suspended 可长期存在”；
  - 接受 `active+steps=0` 本身就是失效状态，不再用 watchdog 兜底解释。

## 3. 最小实施顺序

1. 建 `dispatchGate()` 唯一入口，plan/strategy/interrupt 共用；
2. 无条件 `gate_tick` 心跳，每 tick 至少一条；
3. actionLock / pendingInterrupt 带 owner+TTL；
4. `active+steps=0` 连续 2 tick → stalled + 重排。

## 4. 验收（可判负）

同一夹具 `task craft_tools + 3 只持续 husk`：

1. 1s 窗口内必须有 `gate_tick`；缺一条即判负；
2. 心跳时间戳必须早于任一动作下发，否则“gate 顺序错误”；
3. 任意窗口出现 `planStatus=active && steps_done=0` 连续 ≥2 tick，且 trace 中既无 `stalled` 也无 `deferred+gateReason` → 判负；
4. 打断后 `pendingInterrupt` 必须在 TTL 内清除，否则判负。

## 5. 结论

```text
问题不在 gate 判断错，而在 gate 不在所有动作的执行链上。
先统一入口 + 心跳，再谈 gate 逻辑。
```

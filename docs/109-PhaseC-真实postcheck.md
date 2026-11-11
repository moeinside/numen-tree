# Phase C 真实 postcheck 取证（2026-11-11）

> 夹具：玩家独立安全屋；测试场 home 锚点；树 pause→clear→tactic 150→3 husks+wither→resume。  
> GM 只作夹具，标 assisted。

## 决策

```text
code=preempt
from=goal:g25
to=interrupt:outnumbered
incomingConsequence=death_risk
atAtomBoundary=true
goalId=g25
atomId=atom.move_segment
txId=txmwb2j69c-103
```

## 外部 postcheck

触手 8769 `perception` 成功：

```text
world.ok=true
source=tentacle
terrain.below=minecraft:grass_block solid=true
self.hp=10
self.food=17
self.pos=121.5,67,187.58
```

这说明抢占后的世界证据不再来自执行器自报。

## 但暴露抖动

同一目标短时间：

```text
preempted=25
sameAtomFailures=17
lastPreemptKey=goal:g25:atom.scan_block
```

`outnumbered` 在相邻原子边界反复触发，tactic 被反复抢占/重试。  
这是新的真实问题：**postcheck 有了，但抢占抖动未收敛**。

## 结论

- 真实 decision + atom tx + world postcheck 三元组已走到；
- 不能判 Phase C 通过，因为抢占抖动严重；
- 下一步：同一 interrupt 的 preemption 退避/锁存，至少同一 goal/atom 不得连续重复抢占。

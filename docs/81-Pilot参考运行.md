# 81. Pilot 参考运行：Day1 的观测/纠错工具

> 2026-11-10。玩家澄清：LLM Pilot 的预期是“人工批准下，为功能/行为树开发提供可实时观测的实测参考”；  
> Day1 尤其需要游戏内同伴行为观测—纠错—LLM 操作记录作为参考。  
> 这是对 docs/80 的范围修订：**pilot 可作为 Day1 期间的参考工具，但不是验收路径。**

## 1. 定位

```text
Track A：Day1 acceptance
  - 树自己跑
  - 无 LLM、无 cheat
  - 唯一出线证据

Track B：LLM reference pilot
  - LLM 直连 numen MCP，人工批准
  - 实时观测/记录/分段
  - 只作参考，不作验收
```

Track B 的价值：

- 看真实游戏里“人/LLM 会怎么做”；
- 发现行为树缺的入口/谓词/恢复；
- 提供对照切片；
- 帮助纠错，不是替代树。

## 2. 允许 now

- LLM pilot（无 cheat）；
- 实时观测台：
  - 同伴状态/位置/HP/饥饿；
  - 当前动作/工具调用/结果；
  - 失败/unknown/postcheck；
  - 分段日志/时间线；
- 人工批准启动/暂停/中止；
- 分段摘要；
- 与 Track A 的切片对比。

## 3. 仍然不做

- cheat provider（另开 gate）；
- scanWorld / WorldHints 运行时；
- pilot 产物进验收/学习/树；
- 自动把 pilot 轨迹变成策略；
- 生产世界；
- 无人工批准的自动长跑。

## 4. 人工批准门

每次 Track B run 需要：

- 明确 runId/目的；
- 人工批准（start）；
- 时间/步数上限；
- kill switch；
- 结束 reason；
- 报告标注 `mode=reference-pilot`。

## 5. 隔离

- 独立世界/独立同伴/独立 places/goalstore/trace；
- 不与 Track A 同一进程/同一动作槽；
- 不共享 Facts；
- 不写生产状态；
- 日志独立 channel；
- Track B 失败不记为树失败，Track A 通过不依赖 B。

## 6. 怎么用记录

- 行为学家：看切换/失败/恢复；
- MC 专家：看机制错误/资源路线；
- 点子王：看脚本化/成本；
- 总控：看是否偏航；
- 树开发：把“参考行为”转成**谓词/入口/恢复规则**，不抄动作序列；
- PM：Track B 不进验收，Track A 单独判负。

## 7. 与 docs/80 的关系

- pilot **提前到 Day1 期间**，作为开发观测工具；
- cheat 仍延后；
- “一个产品族两个信任域”不变：
  - Track B pilot 属开发域；
  - Track A 属验收域；
  - cheat 属第三域，暂不建。

## 8. 一句话

> **LLM Pilot 是 Day1 的“参考驾驶员 + 实时观测台”，不是树的替代品，也不是验收证据；树跑 Track A，pilot 跑 Track B，两边分开记、分开判。**

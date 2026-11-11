# PROJECT ARCHITECTURE — numen-tree

> 一页架构地图。给总控/红队看“模块与能力”，不塞实现细节。

## 1. 分层

```text
身体/反射（numen）
  └ 自主反射、动作槽、死亡/重生、内置脑
感官（tentacle）
  └ 只读：实体/地形/水/昼夜/光照/地标
感知/事实（树）
  └ Observation → 三态 Fact（known/unknown/stale）
  └ 来源权威：触手 / numen body / interaction / postcheck
决策（树）
  ├ 本能/压力/注意（instinct/drives/attention）
  ├ Arbiter + 单意图/承诺/迟滞
  ├ GoalProfile + milestone（进度/验收/恢复）
  └ 失败三分/求助
方法（树）
  └ SOP / recipe / strategy / tactic / atom
执行（树）
  └ Executor：settle、postcheck、事务
记忆（树）
  └ places（命名点）/ worldmem（容器/资源）
  └ SpatialMemory（P1：资源/危险/地形/安全点）
观测/验收
  └ trace / treeview / audit / recorder
```

## 2. 当前模块

| 模块 | 职责 | 现状 |
|---|---|---|
| `src/lane.mjs` | 主循环/仲裁/计划/执行 | 大文件，P0 主战场 |
| `src/needs.mjs` | 需求板 | 单意图候选 |
| `src/drives.mjs` | 压力池 | hunger/fatigue/safety/resource |
| `src/attention.mjs` | 注意 | salience/focus |
| `src/instinct.mjs` | 本能硬信号 | 溺水/低血/威胁 |
| `src/strategy.mjs` | 战略注册/分发 | 已拆 strategies/* |
| `src/recipes.mjs` | SOP/配方 | 覆盖木/石/炉/火把，早期链不足 |
| `src/tactics.mjs`/`atoms.mjs` | 战术/原子 | 基础移动/采集/放置/战斗 |
| `src/perception.mjs` | 三态 FactStore | P0-0a 已落地 |
| `src/action-tx.mjs` | 动作事务 | P0-0a 已落地 |
| `src/goalstore.mjs` | GoalProfile 持久化 | P0-b 最小版 |
| `src/places.mjs` | 命名地点 | base/death/owner/poi |
| `src/worldmem.mjs` | 容器/资源点 | 无危险/地形 |
| `src/daemon.mjs`/`mcp` | 进程/API | 运行中 |

## 3. 目标 vs 当前

| 能力 | 目标 | 当前 |
|---|---|---|
| 感知眼睛 | 前/后置门、三态、现场校验 | P0-0a 部分 |
| 早期生存 | early_survival 北极星链 | 缺 |
| 长期任务 | profile/milestone/回退 | 最小 GoalStore，无语义 milestone |
| 多任务 | 单活跃+公平 | 未做 |
| 空间记忆 | places/resources/dangers/terrain | 前两项基础 |
| 学习 | 离线轨迹归纳 | 后置 |

## 4. 关键边界

- 单同伴、单动作槽；
- 反射优先于树；
- 触手只读、具身边界、禁止全知；
- 树不重写身体；
- LLM 只做高层顾问/离线归纳；
- 不做在线 RL/自编程。

## 5. 当前阶段

P0：感知/动作闭环 + 早期生存 + 一天/两夜验收。  
P1：SpatialMemory、profile/milestone、多任务。  
P2：学习/拟人/多同伴。

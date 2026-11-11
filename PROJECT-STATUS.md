# PROJECT STATUS — 2026-11-10 夜停

> 当前主线：`early_survival` 从 0 到第一夜。
> 结论：P0 未出线；停止开发，明天继续。

## 当前阶段

- P0-0a 感知/动作闭环：代码骨架已落地；
- P0-0b 行为最小：未完成；
- 一天观察：两次都不正常；
- 两夜：未跑。

## 最近证据

day1a：

- 30min，899 samples，2 夜，0 死亡；
- avgHP 8.3、最低 5、饥饿 4；
- water_stuck / no_food / craft_failed 反复。

day1b（避水后）：

- 30min，899 samples，2 夜，0 死亡；
- avgHP 5、最低 5、饥饿 4.6；
- 计划：bootstrap_kit / feed / craft_tools；
- 仍 water_stuck、no_food、safety_hold travel_failed。

## 关键 bug（明天先处理）

避水参数语法错误：

```text
numen.route.plan: bad_argument — avoid: 'minecraft:water' is not a cell type;
types are water, flowing_water, ...
```

`avoid = {"minecraft:water"}` 写错，导致 route.plan 失败、travel_failed。
正确应改用 cell type（如 `"water"`）或先回退该改动，再验证。

## 已完成能力

- FactStore 三态；
- 动作事务/unknown 生命周期；
- 触手主观测接入；
- 移动 postcheck；
- 真实水失败回归；
- 安全硬信号 OR；
- 失败 owner；
- dusk/疲劳 schedule；
- GoalStore/GoalResume/B 谓词；
- 回放 21/21、日程 44/44、感知/事务 16/16、水回归 4/4、kill 9/9。

## 未完成能力

- `early_survival` profile + 结果型 milestone；
- `from_zero` SOP；
- 食物保底/低血硬门；
- collect/open/place 世界复观测；
- milestone watchdog；
- 两夜验收。

## 运行状态

- 树已停（8766/8767 已释放）；
- treeview 8780 仍在（只读）；
- 游戏未主动重启；
- 观察器已结束；
- 日志保留在 `logs/p0-*`。

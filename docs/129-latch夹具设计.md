# 129. latch 夹具设计（MC 修正版）

> 2026-11-11。针对真实 latch 夹具总被游戏机制破坏的问题。

## 1. 之前为什么失败

```text
husk 用 NoAI 但仍受重力 → 掉出 16 格扫描
HP 压到 6–12 → 触发 field-guarded / retreat / escape
tactic 选 mine_nearby/dig → 长技能被 hostileNear 拦
```

## 2. 时间/天气

```text
time set noon
weather clear
```

固定白天正午：光照 15，自然不刷怪，怪数只由夹具控制。  
不用 gamerule 伪造夜间。

## 3. 怪

```text
minecraft:husk
NoAI:1b
NoGravity:1b       ← 关键
Invulnerable:1b
PersistenceRequired:1b
Silent:1b
CanPickUpLoot:0b
```

数量 5（断言用 ≥3，留掉数余量）。  
生成在实心地板上，房间 4 角+中点，距同伴 8–12 格。

## 4. HP

```text
必须 11–12，不是 6–12
```

原因：

```text
hpPct ≤50% → field-guarded
HP ≤8 → combat_basics 停手撤退
outnumbered 要求 ≤60%
```

11–12 是唯一安全带。  
先坠落压血，后建围栏；若双源 HP 都降不下去 → 夹具作废。

## 5. tactic

不能用 `mine_nearby/dig_*`（长技能会被 field-guard 拦）。  
用短技能 `place_block`：

```text
房间内 A/B 两个空位
每次放一块
交替 A/B
atom id 相同、参数不同
```

避免同参 ≤2 触发 `loop_exhausted`，又制造多次原子边界。

## 6. 防 safety/retreat 抢队列

```text
HP 11–12
in_water=false
on_ground=true
husks 距同伴 ≥8
```

被抢 ≥2 次 → 夹具失败，不加怪、不覆盖反射。

## 7. 成功/放弃

成功：

```text
首次 outnumbered preempt，preempted +1
hostileCount≥3 两次采样一致
第二次 priority_preempt_latched，preempted 前后相等
HP 11–12，同伴到中心 ≤5
```

放弃：

```text
hostileCount<3 连续两次
同伴 entity not found / hp≤0 / 位置骤回主人
HP 双源都 20，坠落也无效
被 retreat/escape 抢 ≥2 次
```

## 8. 清理

```text
Invulnerable 杀不掉
→ tp 全部 husk 到远处封闭石盒
→ 或整存档快照 restore
不要 taskkill 树
```

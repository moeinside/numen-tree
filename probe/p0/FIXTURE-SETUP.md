# P0 固定世界夹具：需要玩家配合的最小清单

> 目的：跑“无 LLM、两夜、玩家零干预”的 P0 验收。  
> 为什么需要你：树没有命令权限，不能自己造固定世界/地形/资源；当前自然世界无法保证可复现。

## 需要准备

1. **一个测试世界**（新建或复制当前存档；不要用主存档冒险）。
2. 一个平坦区域，作为基地，约 32×32。
3. 基地附近放置：
   - 1 棵橡树（16 格内）；
   - 3 个铁矿石（24 格内，暴露/可达）；
   - 1 个煤矿（24 格内，暴露/可达）。
4. 同伴初始背包：
   - 石镐 ×1；
   - 木镐 ×1（备用/对照）；
   - 面包 ×4。
5. 夜间：允许 1 只僵尸自然生成，或手动 `/summon minecraft:zombie` 一次。
6. 树进程运行、无 LLM 任务、玩家不干预。

## 请告诉我这些值

```json
{
  "worldName": "",
  "saveFolder": "",
  "base": { "x": 0, "y": 64, "z": 0 },
  "companion": "bigWhale",
  "companionId": "",
  "treeStartPos": { "x": 0, "y": 64, "z": 0 },
  "treePos": { "x": 0, "y": 64, "z": 0 },
  "ironPositions": [],
  "coalPositions": [],
  "notes": ""
}
```

填好坐标后，我会：

- 更新 `probe/p0/fixture-spec.json`；
- 用 recorder 记录两夜；
- 用 audit/report 计算：死亡、夜间隔、计划、resume、stale/unknown、GoalStore 恢复；
- 给出 P0 验收报告。

## 如果你能直接用命令

可以用相对坐标（站在基地中心执行）：

```mcfunction
# 先备份/确认周围没有重要建筑！
/fill ~-16 ~-1 ~-16 ~16 ~-1 ~16 minecraft:grass_block
/fill ~-16 ~ ~-16 ~16 ~2 ~16 minecraft:air

# 一棵树（简易：原木+树叶）
/setblock ~8 ~ ~ minecraft:oak_log
/setblock ~8 ~1 ~ minecraft:oak_log
/setblock ~8 ~2 ~ minecraft:oak_log

# 3 铁 + 1 煤（放在地面可见）
/setblock ~-8 ~ ~ minecraft:iron_ore
/setblock ~-8 ~ ~4 minecraft:iron_ore
/setblock ~-8 ~ ~8 minecraft:iron_ore
/setblock ~8 ~ ~-8 minecraft:coal_ore

# 给同伴初始物品（把 @p 换成同伴/自己）
/give @p minecraft:stone_pickaxe 1
/give @p minecraft:wooden_pickaxe 1
/give @p minecraft:bread 4
```

注意：不要清掉基地现有箱子/熔炉；测试世界最好独立。

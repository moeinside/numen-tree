# WORLD CONSTRAINTS — numen / 触手 / 项目边界

> 所有顾问必读。任何建议必须区分来源与边界；违反者视为无效建议。  
> 目的：防止“行为上合理、游戏里不可行”或“把触手当全知数据库”。

> ⚠ 2026-11-10 MC 专家源码审计修正：  
> - 触手 `landmarks/water` **确定无 LOS/FOV、会穿墙**，只能当候选，不能当权威；  
> - `self.food` 非 player 时为 null，树侧禁止 `Number(null)` 误读；  
> - `entities.category` 有系统误分类，威胁权威用 numen；  
> - 详见 `docs/69-边界审计-MC专家.md`。

## 1. 顾问建议必须带标签

```text
[V] vanilla 机制
[N] numen / MCP / Lua 能力
[T] 触手感知
[M] NeoForge/mod
[?] 需实测/不确定
```

没有标签、或标签与边界冲突的建议，产品经理/总控可直接退回。

## 2. numen MCP 能力

### 工具

- `list_companions`
- `create_companion(name)`
- `delete_companion(companion)`
- `get_events(companion)`
- `say(companion, text)`
- `lua(code, companion)`
- `skill(skill, companion)`
- `todo(items, companion)`
- `memory(command, companion)`

### 关键限制

- **单动作槽**：同一时间一个 Lua 程序/内置脑占用；被占时树只能让路/等。
- **无命令/传送/改时间/世界种子**：只能通过具身动作。
- **无结构化耐久/护甲/经验**：`status.self` 有 hp/hunger/hands/body_state；护甲只在 body_state 字符串里；耐久需按使用次数/降级判断。
- **scan 有限**：`scan.blocks(ids,{radius})` 返回簇，达到上限会截断；`scan.map` 是单层地面图，不是全图。
- **路线**：`move.to`/`route.plan` 支持 `avoid/costs`，但 `avoid` 用 **cell type**（`water/flowing_water`），不是 block id；路线可能游泳，避水对未观测的水无效。
- **挖掘限制**：`work.dig` 对流体/松散相邻方块有安全限制；`use.block` 只点一次，不走路。
- **容器**：技术上有 `scan.container` / `inv.fetch`，但项目边界禁止远程/未访问容器；必须到现场打开/确认。
- **无可靠 1×1 竖井上下**：不能依赖梯/水梯。

## 3. 触手 v0.3 能力

### 提供

- `self`：位置/朝向/hp/max_hp/food/dimension/light/day/day_time；
- `entities`：视锥内实体（数量/距离受限）；
- `landmarks`：地标候选；
- `water`：open/ice 计数、最近点；
- `terrain`：in_water/in_lava/on_ground/dirs/feet/head/above/below；
- `limits`：radius/vision_range/fov。

### 不提供

- 背包/手持/护甲；
- 容器内容/箱子坐标；
- `observed_at` / `confidence` / `source`；
- 听觉/记忆来源；
- 全图/穿墙实体/矿脉/结构。

### 已知边界缺陷

- `water`/`landmarks` 可能穿墙/未严格 FOV/LOS 过滤（v0.3 待补）；
- 水可能被地形/墙阻挡“看不到”；
- 冰面不等于水，避水不会自动避冰；
- HTTP 8769，2.5s 超时；列表/半径有限；
- 缺 `source/timestamp`，树侧必须自己补时效/证据。

## 4. 项目硬红线

- 不做全知/透视/远程确认；
- 不读未访问容器/其他背包/末影箱；
- 不用世界种子/刷怪计时/AI 内部状态；
- 不把“没观测到”当“不存在”；
- 不用 numen 技术能力绕过具身边界（技术可行 ≠ 项目允许）；
- 不使用命令/传送/改时间/和平模式过验收。

## 5. 每个顾问必须检查

1. 这条建议依赖哪个来源？（V/N/T/M/?）
2. 这个来源真的提供该信息/动作吗？
3. 是否越过触手/项目边界？
4. 如果来源不可用，降级/替代是什么？
5. 需要实测的点标 `[?]`，不准装懂。

## 6. MC 专家的额外要求

MC 专家必须同时掌握：

- vanilla 玩法/机制；
- numen 动作/扫描/路线限制；
- 触手能看见什么/看不见什么；
- 项目边界（哪些“技术上能做”但不允许）。

MC 专家给建议时，必须主动指出：

> “这一步 vanilla 可行，但 numen 做不到 / 触手看不见 / 需要玩家配合。”

## 7. 一句话

> **技术能力 ≠ 项目允许；触手是感官不是数据库；任何建议先标来源，再过边界。**

# numen Lua API 速查（觅食闭环 + 战斗评估）

> 环境：Minecraft 1.21.1 NeoForge + `numen-neoforge-1.21.1-0.1.4.1.jar`，numen MCP `http://127.0.0.1:8765/mcp`
> 记录时间：2026-11-07 晚（游戏运行中，活体探针）
> 来源标记：**实测** = 本轮活体 Lua 探针真跑出来的；**帮助文本** = `numen.api.help()` 原文；**源码** = `config/numen/lua/<id>/numen/*.lua` 或 jar 内 `modules/*.lua` 可读实现；**推断** = 由签名/源码用法推出、本轮未直接跑通。
> 探针脚本都在 `probe/p20*.lua ~ p3x*.lua`，复现命令见第 13 节。

---

## 0. 一分钟结论（觅食 + 战斗要用的 7 条）

| # | 结论 | 证据 |
|---|---|---|
| 1 | 被动生物过滤名就是 **`"passive"`**；`numen.scan.entities` 只接受 `hostile / passive / player / item / all` 五个值，`"animal" / "mob" / "cow"` 全部 `bad_argument` | 实测 |
| 2 | 不能按具体类型扫，必须拿 `passive` 列表后**在 Lua 里按 `e.type == "minecraft:cow"` 过滤** | 实测 |
| 3 | `numen.status.self()` **有手持物**：`.hands.mainhand = {item, count}`（空手时 nil）；**没有护甲数组、没有经验值**，护甲只能从 `.body_state` 字符串（mod 贡献的 `<worn>head: empty; …`）或 `numen.gear.wear/remove` 看出来 | 实测 + 帮助文本 |
| 4 | 开箱子拿食物的两条路：① 已知物品 id → `numen.inv.fetch(pos, "minecraft:bread", 2)`（走路+开箱+取出+关箱一次完成）；② 不知道里面有啥 → `numen.scan.container(cell).storage`（**不开箱**读内容）或 `numen.use.block(cell)` 拿 Window，`numen.gui.count(item)` 数容器侧、`w:take(item, count)` 取 | 帮助文本 + 源码 |
| 5 | 杀被动生物掉的肉**不会自动捡**：`numen.fight.attack` 的注释明说 "It does not pick up what the target drops"，要 `numen.work.collect()`（走进掉落物）或用 `numen.scan.entities("item")` + `numen.move.to(item.pos)` | 帮助文本（combat_basics SKILL）+ 源码 |
| 6 | 找容器方块：`numen.scan.blocks({"minecraft:chest","minecraft:barrel"}, {radius=32})` → `Cluster[]`，取 `cluster.nearest` 或 `cluster.blocks`。容器方块是普通方块，官方库 `inv.lua` 就靠 `scan.blocks("minecraft:crafting_table")` 找台子 ⇒ 对容器同样有效 | 源码（推断）；本轮半径 32 内确实没有容器，`n=0`（实测，属环境而非 API 限制） |
| 7 | 长任务进度：`numen.task.timer` **不能**用来上报（它是 URGENT 事件，会打断程序，2026-11-07 实测）；改用 `tree_status` 的已运行秒数 / 自报预算，或只读 `numen.task.status()` | 实测（回执原文见 §8） |

---

## 1. `numen.api.help(...)` 的正确用法

### 1.1 签名（实测）

```lua
numen.api.help(name: string): string
```

- **必须带参数**。`numen.api.help()` 直接报错（实测）：

  ```
  numen.api.help: bad_argument — argument 'name' is missing (or nil)
  usage: numen.api.help(name)
    e.g. print(numen.api.help("numen.work.dig"))
    e.g. print(numen.api.help("numen.move"))
  hint: print(num…
  ```

- 返回值是**一个字符串**（不是表）。
- 三种粒度（全部实测）：

| 调用 | 返回内容 |
|---|---|
| `numen.api.help("numen")` | 全部 18 个分组的总览：每组一行「组名 — 用途 …该组函数名列表」 |
| `numen.api.help("numen.scan")` | 该组每个函数的**类型签名**（`---@field entities fun(...): (Entity\|Item)[]`）+ 组内 `---@class` 定义（字段 + 中文/英文说明）+ 示例 + Notes |
| `numen.api.help("numen.work.dig")` | 单个函数全文：`function numen.work.dig(blocks, opts) end`、逐参数说明、返回值、`-- Examples:`、`-- Notes:`、`-- See also:` |

### 1.2 18 个分组名（实测 `help("numen")` 输出）

```
numen.api       numen.build     numen.creative  numen.fight
numen.gear      numen.gui       numen.inv       numen.locate
numen.mc        numen.module    numen.move      numen.route
numen.scan      numen.status    numen.task      numen.time
numen.use       numen.work
```

> 另有 **9 个 Lua 模块**（`numen/build,fight,gui,inv,move,scan,shape,time,work`），它们的函数**并入同名命名空间**（所以 `numen.inv.fetch` 是模块库函数、`numen.inv.items` 是内核 API）。`numen.shape` 只存在于模块里，不在 18 组中。`numen.module.list()` 列出模块与说明。
> 内核组本身的函数由 Java 注册，模块（可读 .lua）只做组合封装。

### 1.3 探针取帮助时怎么绕开长度截断（实测坑）

MCP `lua` 工具对**单个字符串截断约 200–300 字符**，对**整个返回截断约 6000 字符**。因此：

```lua
local function slices(s)            -- 每片 200 字符，返回数组
  s = tostring(s)
  local out, i = {}, 1
  while i <= #s do out[#out+1] = s:sub(i, i+199); i = i + 200 end
  return out
end
return { scan = slices(numen.api.help("numen.scan")) }
```

或者只取签名行（本文件大部分内容就是这么来的）：

```lua
local out = {}
for line in (numen.api.help(group) .. "\n"):gmatch("(.-)\n") do
  if line:find("^%-%-%-@field") or line:find("^%-%-%-@class") then out[#out+1] = line end
end
```

---

## 2. `numen.status.*` 全字段

### 2.1 `numen.status.self()` — 你的身体（帮助文本，字段名权威）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | integer | 自己的实体 id（战斗/`use.entity` 用得到） |
| `name` | string | |
| `game_mode` | string | `survival` / `creative` / `adventure` / `spectator` |
| `hp` / `max_hp` | number | |
| `hunger` | integer | 0–20（**20 是饱，不是满**） |
| `saturation` | number | 饱和度 |
| `pos` | Pos | `{x,y,z}` 小数坐标 |
| `dimension` | string | `minecraft:overworld` |
| `biome` | string | `minecraft:snowy_plains` |
| `structures` | string[] | 所站的结构 |
| `hands` | Hands | **手持物**：`{mainhand?: Held, offhand?: Held}`，`Held = {item: string, count: integer}` |
| `backpack_slots` | Slots | `{used: integer, total: integer}`（实测 total=41） |
| `on_ground` | boolean | |
| `in_water` | boolean | |
| `air` / `max_air` | integer | 氧气（tick） |
| `in_lava` | boolean | |
| `body_state` | string? | 穿在身上的东西 + 各 mod 上报的身体状态，**护甲只能从这里看** |

实测样本（`probe/p23-state.lua`，同伴空手、空背包、雪原）：

```
self: id=… ; name=tyrander ; game_mode=survival ; hp=… ; hunger=… ; saturation=…
      pos={x=…,y=…,z=…} ; dimension=overworld ; biome=minecraft:snowy_plains
      hands.mainhand=nil (空手)   hands.offhand=nil
      backpack_slots.used=0 total=41
      air=300 ; body_state="<worn>head: empty; chest: empty; legs: empty; feet: empty</worn>"
```

**回答三个具体问题：**

- **有手持物品**：`numen.status.self().hands.mainhand.item` / `.count`（空手时 `mainhand` 为 nil，实测）。
- **有护甲**：没有结构化护甲字段。`body_state` 是字符串（原版/各 mod 通过 `contributeBodyState` 塞进去的），实测格式 `<worn>head: empty; chest: empty; legs: empty; feet: empty</worn>`。要**穿**护甲用 `numen.gear.wear(item, {slot?})`，要**脱**用 `numen.gear.remove({slot?, item?})`。
- **有饱和度**：有，`saturation`（number）。
- **有经验**：**没有**（无 xp 字段）。

### 2.2 `numen.status.world()`（实测 + 帮助文本）

| 字段 | 类型 | 实测值示例 |
|---|---|---|
| `dimension` | string | `minecraft:overworld` |
| `game_time` | integer | `230468`（世界刻；20 刻 = 1 秒；**判断昼夜就用它**） |
| `is_bright_outside` | boolean | `false` |
| `is_dark_outside` | boolean | `true` |
| `weather` | string | `"clear"` \| `"rain"` \| `"thunder"` |

> 没有 `os` 库（`docs/02` 第 6 节实测），计时只能用 `numen.time.wait(秒)` 或 `game_time` 差值。

### 2.3 `numen.status.owner()`（帮助文本；实测有值）

`online: boolean`、`id?`、`name?`、`pos?`、`distance?`、`same_dimension?`、`dimension?`、`hp?`、`max_hp?`、`hunger?`、`saturation?`、`main_hand?`、`off_hand?`
（主人离线时**只有 `online=false`**，其余字段都没有。）

实测：`online=true name=moeisnide hp=20 hunger=20 distance=28.9 main_hand=minecraft:air`。

---

## 3. `numen.scan.*`

### 3.1 `numen.scan.entities(type_filter, opts)` ★ 觅食/战斗的核心

```lua
numen.scan.entities(type_filter?: "hostile"|"passive"|"player"|"item"|"all",
                    opts?: {radius?: number}): (Entity|Item)[]
```

**合法 filter 只有 5 个值（实测，硬枚举，其它值全报 `bad_argument`）：**

| filter | 含义 | 实测（半径 32，雪原） |
|---|---|---|
| `"hostile"` | 敌对生物 | 4（creeper 等） |
| `"passive"` | **被动生物（牛羊猪鸡鱼都在这里）** | 7（salmon…） |
| `"player"` | 玩家 | 1（主人） |
| `"item"` | 掉落物实体 | 0 |
| `"all"` | 全部 | 12 |

**不能按具体类型扫——实测报错原文：**

```
numen.scan.entities: bad_argument — argument 'type_filter': expected one of
hostile, passive, player, item, all; got "cow"
```

`"animal"`、`"mob"`、`"minecraft:cow"` 同样被拒（实测）。

**正确做法：拿 `"passive"` 列表，自己在 Lua 里按 `e.type` 过滤（推断但直接由上面的实测推得）：**

```lua
local MEAT = {
  ["minecraft:cow"] = "minecraft:raw_beef",
  ["minecraft:pig"] = "minecraft:raw_porkchop",
  ["minecraft:sheep"] = "minecraft:raw_mutton",
  ["minecraft:chicken"] = "minecraft:raw_chicken",
  ["minecraft:rabbit"] = "minecraft:raw_rabbit",
  ["minecraft:salmon"] = "minecraft:raw_salmon",
  ["minecraft:cod"] = "minecraft:raw_cod",
}
for _, e in ipairs(numen.scan.entities("passive", {radius = 48})) do
  if MEAT[e.type] then return e end        -- 最近优先（返回本来就是由近到远）
end
```

**Entity 字段（实测枚举）：**

| 字段 | 类型 | 实测 |
|---|---|---|
| `id` | integer | `12309` —— `numen.fight.attack` / `use.entity` 吃的就是这个 |
| `type` | string | `minecraft:creeper` / `minecraft:salmon` / `minecraft:player` |
| `category` | string | `hostile` / `passive` / `player` |
| `pos` | Pos | `{x,y,z}` |
| `distance` | number | `6.8`（离你的距离） |
| `hp` / `max_hp` | number | `20` / `20` —— **战斗评估可以直接用**（实测有这两个字段） |
| `name` | string? | 玩家名（`moeisnide`）、已命名生物 |

**Item 实体的额外字段（源码 `work.lua` 读取，实测 `item` 过滤可用）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `item` | string | 物品 id，如 `minecraft:raw_beef` |
| `count` | integer | 数量 |
| `pickup_delay` | integer | 还要等多少 tick 才能捡（刚掉落有冷却，>100 就是捡不了） |
| `id` / `pos` / `distance` | | 同上 |

### 3.2 `numen.scan.blocks(block_ids, opts)` — 找方块/容器

```lua
numen.scan.blocks(block_ids: string|string[], opts?: {radius?: integer}): Cluster[]
```

- 返回 **Cluster 列表，最近的在前**；同一簇 = 相连的同类方块。`opts.radius` 敌方块搜索半径（实测可传 32）。
- `Cluster` 字段：`blocks: Block[]`（簇内全部，最近在前）、`nearest: Block`、`count: integer`，方法 `cluster:filter(fn)`、`cluster:minus(other)`。
- `Block` 字段（帮助文本 `BlockInfo` + 源码用法）：`pos: Pos`（`inv.lua` 里 `at.pos or at`）、`name: string`（`shape.cell` 用 `{name=, pos=}` 造要放的方块）、`properties?`、`is_air`、`is_solid`、`is_liquid`、`hardness`、`unbreakable`、`needs_correct_tool`、`current_hand_correct_tool`、`estimated_mining_ticks?`、`distance`、`in_reach`。
- 找容器（推断，官方库同样用法）：

```lua
local found = numen.scan.blocks({"minecraft:chest", "minecraft:barrel", "minecraft:trapped_chest"}, {radius = 32})
if #found > 0 then local at = found[1].nearest.pos end   -- 然后 use.block / inv.fetch
```

**实测注意**：本轮在雪原半径 32 内 `chest / barrel / crafting_table` 都是 `n=0`——这是**环境没容器**，不是 API 不支持；`inv.lua` 的 `table_window()` 正是 `numen.scan.blocks("minecraft:crafting_table", {radius=16})` 再走过去开的，说明该 API 对功能性方块有效（推断，有官方库依赖作证）。

### 3.3 其它 scan 函数（帮助文本）

| 函数 | 返回 | 用途 |
|---|---|---|
| `numen.scan.block(cell: Pos): BlockInfo` | 单格详情（含 `in_reach`、`estimated_mining_ticks`） | 判断脚下/目标格能不能挖 |
| `numen.scan.container(cell: Pos): Storage` | `{block: Block, storage: string[]}`，**不开箱**读容器内容（物品/流体/能量，每槽一行） | 觅食前"扫箱子里面有什么"最便宜的办法 |
| `numen.scan.map(opts?: {radius?}): GroundMap` | `{rows: string[], center: Pos}` 俯视地形图（walk/step/drop/swim） | 找路、判断能不能下去 |
| `numen.scan.sight(target: Pos|Entity): Sight` | `{visible: boolean, distance, blocked_by?}` | 判断有没有遮挡 |
| `numen.scan.cluster(blocks: Block[]): Cluster` | 把 Block 列表包成 Cluster（模块函数） | 组合用 |

> 没有 `numen.scan.items`（实测 `p23` 名字枚举时不存在；掉落物一律走 `scan.entities("item")`）。

---

## 4. `numen.inv.*` 与 `numen.gear.*`

### 4.1 `numen.inv.items()` 元素字段（帮助文本）

```lua
numen.inv.items(): Stack[]     -- 背包里"每种物品一条"，Stack = {item: string, count: integer}
```

- **元素只有 `item` 和 `count` 两个字段**，没有 slot 号。`item` 是完整 id（`minecraft:cobblestone`）。
- 实测：背包空时返回 `{}`，`#items == 0`；`status.self().backpack_slots = {used=0, total=41}`。
- 物品总量：`#items` 是种类数，数量总和要自己加。

### 4.2 其余 inv 函数（帮助文本 + 源码）

| 函数 | 签名 | 返回 | 备注 |
|---|---|---|---|
| `count` | `count(item: string): integer` | 携带数量（全部堆叠合计） | 不用命名空间前缀也行（内部补 `minecraft:`） |
| `eat` | `eat(item: string): Ate` | `Ate = {item, hp, hunger}` | 从背包吃/喝 |
| `drop` | `drop(item: string, opts?: {count?}): Dropped` | `Dropped = {item, dropped, remaining_in_inventory}` | 掉在面前地上 |
| `craft` | `craft(recipe: string, opts?: {count?}): Crafted` | `Crafted = {crafted, carrying, used: string[], got_back: string[], more: boolean}` | 在手头打开的合成格里合成一次 |
| `craftable` | `craftable(): Recipe[]` | 现在就能合成的全部配方 | |
| `recipes` | `recipes(item: string): Recipe[]` | 某物品的所有做法（像 JEI） | |
| `make` | `make(item, count?): integer` | 做出来的数量（模块） | 自动选配方、找/开合成台 |
| `store` | `store(at, item, count?): integer` | 放进容器多少（模块） | 走路+开箱+放入+关箱 |
| `fetch` | `fetch(at, item, count?): integer` | 从容器取出多少（模块） | 走路+开箱+取出+关箱 ★觅食用 |
| `smelt` | `smelt(furnace, item, count?, opts?: {fuel?, timeout?}): integer` | 取出多少（模块） | 默认燃料 coal，每 8 个 1 煤，timeout 默认 12 秒/个 |
| `give` | `give(target, item, count?): integer` | 丢出多少（模块） | 走到 2 格内丢给对方 |

> **`inv` 里没有 equip/切换持有物**，那在 `numen.gear`。

### 4.3 `numen.gear.*`（帮助文本）

| 函数 | 签名 | 返回 |
|---|---|---|
| `hold` | `hold(item: string, opts?: {hand?: "main"\|"off"}): Change` | `Change = {item?, slot?, removed: string[], still_worn: string[]}` |
| `wear` | `wear(item: string, opts?: {slot?: string}): Change` | 穿护甲 / 戴 mod 配件 |
| `remove` | `remove(opts?: {slot?: string, item?: string}): Change` | 脱回背包；`still_worn` 是脱不下来的 |

> 战斗前"拿武器"= `numen.gear.hold("minecraft:iron_sword")`；但注意 `fight.attack` **自己会挑最强武器**，不要为了打架手动 hold（见 6.2）。

---

## 5. 容器交互：开箱子读内容、拿指定食物

### 5.1 Window 结构（`numen.gui.view()` / `numen.use.block(...)` 返回值）

| 字段 | 类型 | 说明 |
|---|---|---|
| `menu` | string | 自己的背包菜单时是 `InventoryMenu` |
| `slots` | WindowSlot[] | 每格一项（见下） |
| `cursor` | string? | 光标上拿着什么 |
| `data` | integer[] | 菜单同步数字：熔炉是 `{litTime, litDuration, cookProgress, cookTotal}`；其它机器含义自定义 |
| `block` | Block? | 点开的那个方块 |

`WindowSlot = { index: integer, side: "container"|"you"|"grid"|"result", item?: string, count?: integer, output?: boolean }`

- `index` 是 `gui.move` / `gui.quick` 吃的槽号；`side=="container"` 是箱子侧，`"you"` 是背包侧，`"grid"` 合成格，`"result"` 产物格。
- `output=true` 只能取不能放（熔炉产物）。

### 5.2 gui 函数（帮助文本）

| 函数 | 签名 | 说明 |
|---|---|---|
| `view` | `view(): Window` | 读当前打开的窗口；没开时返回自己的背包菜单 |
| `count` | `count(item: string): integer` | **容器侧**（不是背包）有多少个 item |
| `take` | `take(item: string, count?): integer` | 从窗口取出 item 到背包（不给 count = 全取） |
| `put` | `put(item: string, count?): integer` | 从背包放进窗口（菜单自动路由：熔炉原料→输入格、煤→燃料格） |
| `move` | `move(from: integer, to: integer, opts?: {count?})` | 精确挪到某格；空格→放入、同物→合并、异类→**交换** |
| `quick` | `quick(from: integer)` | 对某格 shift-click，整堆去对面（**也是"取合成产物"的动作**） |
| `close` | `close(): boolean` | 关窗；关过 true，本来没开 false |

Window 上的方法同义：`w:put / w:take / w:move / w:quick / w:close`（`w:take` 返回个数）。

### 5.3 开箱子并按 id 拿食物（最常用，两种写法）

**写法 A：已知物品 id，一次到位（模块 `inv.fetch`，源码 100% 可读）**

```lua
-- 走路到箱子 → 右键开箱 → take → 自动关箱；返回取出数量
local got = numen.inv.fetch({x = 120, y = 64, z = -35}, "minecraft:bread", 3)
```

**写法 B：不知道箱子有什么 / 要挑食物（开窗 + 读槽）**

```lua
local at = {x = 120, y = 64, z = -35}
numen.move.to(at, {arrive = "use"})          -- 走到"看得见且够得着"的位置（use.block 不走路！）
local w = numen.use.block(at)                -- 返回 Window；开不出窗口会 raise failed
if not w.slots then raise("failed", "这个方块没开窗口") end

for _, s in ipairs(w.slots) do               -- 看里面有什么
  if s.side == "container" and s.item then
    print(s.index, s.item, s.count)
  end
end

local FOODS = { "minecraft:cooked_beef", "minecraft:bread", "minecraft:baked_potato" }
for _, f in ipairs(FOODS) do
  if numen.gui.count(f) > 0 then
    local n = w:take(f)                      -- 取空这种食物
    break
  end
end
w:close()                                    -- 一定要关；走远了也会自动关
```

**写法 C：先不开箱偷看内容（最便宜，`scan.container`）**

```lua
local st = numen.scan.container({x = 120, y = 64, z = -35})   -- 不打开窗口
for _, line in ipairs(st.storage) do print(line) end           -- 每槽/每箱一行
```

> 说明：`scan.container` 是帮助文本明确写的 "read without opening it"，本轮附近无容器，未活体点验（标记：帮助文本 + 推断）；`gui.view` 的 `storage` 字段为空表示该方块不透出存储。

**gui.view 的槽号坑**：合成格布局是二维的，2×3 配方在 3×3 台子里**不占连续槽号**（`containers` SKILL 原话），手工合成时按 `view().slots` 的 2D 图对齐。

**熔炉状态**：`numen.use.block(furnace)` 后 `w.data = {litTime, litDuration, cookProgress, cookTotal}`，`litTime>0` 还在烧，`cookProgress/cookTotal` 是进度。

---

## 6. 杀被动生物取肉

### 6.1 `numen.fight.attack` 能不能打牛羊猪鸡

```lua
numen.fight.attack(entity: integer|Entity): Fought
```

- 参数是**运行时 entity id** 或 `scan.entities` 返回的 Entity，**一次一个**。
- 返回 `Fought = {fought: Foe[], strikes: integer}`，
  `Foe = {id: integer, status: string, strikes: integer}`，`status ∈ "defeated" | "lost" | "unreachable" | "refused: <why>" | "pending"`。
- **能打被动生物**：`combat_basics` SKILL 明说 "Players and mobs use the same id. Never guess ids and never attack an entity you did not pick"——接口本身不区分敌我，`fight.clear` 只是把 `hostile` 过滤后的列表循环了一遍（源码 `fight.lua` 可读）。
- 本体自己决定武器/射程/什么时候挥，**每 tick 重新锁定移动目标**；会追很远的怪、会搭/绕地形。
- 它**不捡掉落物**（见下）。

**打一只牛（推断写法，接口全部实锤过）**：

```lua
for _, e in ipairs(numen.scan.entities("passive", {radius = 32})) do
  if e.type == "minecraft:cow" then
    local r = numen.fight.attack(e.id)
    break
  end
end
```

> 注意 `fight.attack` 是"后台工作"，程序会等它结束再往下走（`docs/02` 6.1 实测：`move.go`/`dig`/`follow` 都是 blocking）。

### 6.2 掉肉怎么捡（**不会自动捡**）

`combat_basics` SKILL 原文："It does not pick up what the target drops: its result says where the drops lie, and `numen.work.collect()` walks onto them."

三条路（按推荐顺序）：

```lua
-- A. 通用：把附近掉落物（含肉、皮革、箭）全走一遍捡起来。默认半径 8，给 items 时 64
numen.work.collect()

-- B. 只捡这次掉的（把 dig/战斗结果里的 drops 传进去）
--    work.collect({items = drops})（源码：只有带 .id 的会被追踪）
numen.work.collect({items = myDrops})

-- C. 手动：扫掉落物 → 走过去 → 捡起（走到位就自动进背包）
for _, it in ipairs(numen.scan.entities("item", {radius = 8})) do
  if it.item == "minecraft:raw_beef" then
    numen.move.to(it.pos, {arrive = "near", range = 1})
  end
end
```

实现细节（`work.lua` 源码）：`collect` 会把 `pickup_delay > 0` 的物品反复走上去；`pickup_delay > 100` 直接 `failed`；走不进去的（`no_path`）会跳过后在结尾统一 `raise no_path`，`err.data.left` 是没捡到的清单；背包满 → `failed`。

`numen.work.dig` 的 `drops` 元素形如 `{item, count, fate, pos, by?, cause?, id?}`，`fate ∈ land/picked_up/destroyed/void/gone/moving`；`id` 就是掉落物实体的 id（可直接喂 `collect` 或 `scan.entities` 对比）。

### 6.3 生肉能不能直接 `numen.inv.eat`

- `numen.inv.eat(item: string): Ate`，`Ate = {item, hp, hunger}`——**只要有原版食物值就能吃**；`raw_beef`（生牛肉 3 饥饿）、`raw_porkchop`、`raw_mutton`、`raw_chicken`（30% 饥饿效果）、`raw_rabbit`、`raw_salmon/cod` 在原版都是 `Item#isEdible` 的食物 ⇒ **推断可以直接 eat**。
- **一个需要注意的发现**：jar 内有 `data/numen/tags/item/tame_foods.json`，该标签**只列了熟食和植物类**（apple / bread / cooked_beef / cooked_porkchop / cooked_mutton / cooked_chicken / cooked_cod / cooked_salmon / baked_potato …），**不含任何生肉**。这个标签从名字看是"驯服/投喂动物"用，不是"能否吃"的白名单；但如果 `inv.eat` 内部按该标签判定，生肉会被拒。**本轮受 Lua 槽位长期被占（树进程占槽）+ 禁止改状态，未能活体验证 eat** ⇒ 标为**待验证项**（见第 12 节）。稳妥做法：先打猎，`numen.inv.smelt(furnace, "minecraft:raw_beef")` 或烤架/营火烤熟再吃；或直接 `inv.eat` 试，失败会 `raise`（`Ate` 之外还能看 `err.kind`）。

---

## 7. `numen.work` / `numen.build` / `numen.move` / `numen.route` / `numen.use` / `numen.time`

### 7.1 work（帮助文本 + 源码）

| 函数 | 签名 | 返回 |
|---|---|---|
| `dig` | `dig(blocks: Pos\|Block\|(Pos\|Block)[], opts?: {count?}): Dug` | `Dug = {dug, left, out_of_reach, nearest?, drops: Drop[]}` |
| `fish` | `fish(): string[]` | 抛竿一次、等咬钩、收杆，返回钓到的物品 id |
| `collect` | `collect(opts?: table): integer` | 捡到的个数（模块） |
| `mine` | `mine(cluster: Cluster\|Cells): integer` | 挖完一整簇的个数（模块，自带"走近→挖→捡"循环） |

`Dug` 只挖**手够得着**的格子；`left/out_of_reach/nearest` 告诉你还差多少、最近的那格在哪。

### 7.2 build

| 函数 | 签名 | 返回 |
|---|---|---|
| `place` | `place(cells: Cells\|Blueprint, opts?): Placed` | `Placed = {left, settled_away…}`（源码里 `place(building).left == 0` 表示全放好） |
| `diff` | `diff(cells): {left, reach, dig: Pos[], next?, far, no_stock, unheld}` | 还差什么、手头能放几个、哪些要挖 |
| `blueprint` | `blueprint(path)` / 见 `help("numen.build.blueprint")` | 从文件读蓝图 |
| `raise` | `raise(building, opts?): integer` | 整栋建完（模块） |

放单方块（源码 `inv.lua` 原样）：

```lua
numen.build.place({{name = "minecraft:crafting_table", pos = {x = x, y = y, z = z}}})
```

### 7.3 move / route（帮助文本 + 源码）

| 函数 | 签名 | 返回/要点 |
|---|---|---|
| `move.to` | `to(target, spec?): Walked` | `Walked = {pos: Pos, distance_left: number}`；= `route.plan(spec+{to=target})` + `move.go`；**一次调用 = 一次完整走+脱困** |
| `move.flee` | `flee(from, opts?): Walked` | 走到离 from 至少 `opts.distance`（默认 8）格；内部 `arrive="away"` |
| `move.explore` | `explore(dir, {until_, seconds, hop}): any\|nil` | 朝 `north/south/east/west` 或某个 Pos 一跳一跳走，每跳后调 `until_()`；返回 `until_` 的真值或超时 nil。默认 seconds=60、hop=16。**这是"有预算的循环"的官方范例** |
| `move.follow` | `follow(entity?, opts?: {distance?, seconds?}): Followed` | 跟主人或指定实体一段时间 |
| `move.go` | `go(plan): Walked` | 走 `route.plan` 出的计划 |
| `move.dismount` | `dismount(): Dismounted` | 下船/下车/下坐骑 |
| `route.plan` | `plan(opts?): Plan` | 只规划不走；`Plan` 有 `ok/steps/seconds`，支持 `arrive / range / stops / mode / costs / avoid / materials / to` |

`arrive` 的取值（源码里实际用到的）：`"near"`（默认，`range` 格内）、`"use"`（站到能右键方块的位置）、`"dig"`（站到手够得着最多格子的位置）、`"place"`、`"away"`（逃跑）。

`costs` 例：`{dig = true, place = true}` 允许挖/垫过去；`{consent = false}` 不碰需要主人同意的格子。

### 7.4 use（帮助文本）

| 函数 | 签名 |
|---|---|
| `use.block` | `block(cell: Pos, opts?: {hold?: number, item?: string, sneak?: boolean}): Window\|Clicked` |
| `use.entity` | `entity(entity: integer\|Entity, opts?): EntityClicked`（`{button, entity_id, changes: string[]}`） |
| `use.hit` | `hit(target: Pos\|Entity): Clicked\|EntityClicked`（左键单次） |
| `use.item` | `item(opts?): Clicked`（对空右键，用手里东西，如吃东西/放船） |
| `use.sleep` | `sleep(opts?: {at?}): Slept`（`{bed: Pos, sleeping: boolean}`） |

`Clicked = {button: "left"|"right", aim?: Pos, block?: Block, changes: string[]}`；`changes` 空 = 这一下什么都没发生。

> **`use.block` 不走路**：先 `move.to(pos, {arrive="use"})`。开箱失败常见原因是准星被草挡住，重新选面或先 `work.dig` 挡路格。

### 7.5 time（帮助文本 + 源码）

| 函数 | 签名 | 说明 |
|---|---|---|
| `wait` | `wait(seconds): number` | 原地等，返回**实际**等了多久（最小 0.1 秒） |
| `wait_until` | `wait_until(ready: fun(): boolean, opts?: {every?, timeout?}): number` | 每 `every` 秒（默认 1）查一次，默认 60 秒超时后 `raise("timeout", …)`；返回等了多久（模块） |

> 没有 `os` 库、没有 `time.sleep`（实测 `numen.time.sleep` 不存在，`modules.json` 里留有历史报错记录）。

---

## 8. `numen.task.*`：任务与定时器（长任务进度上报）

```lua
numen.task.status(): Status
numen.task.stop(opts?: {task_id?: string}): Stopped
numen.task.timer(reason: string, opts?: {after?: integer}): Timer
```

- `Status = {task_id? , task?, state? ("running"|"queued"), elapsed_s?, budget_left_s?, timers: Timer[]}` —— **当前后台任务 + 全部待触发的定时器**，是最便宜的"我在干什么"数据源（`docs/02` 已实测过一次）。
- `Stopped = {task_id?, timer_id?}`；不带 `task_id` 的 `stop()` 停的是"后台任务"，能腾出身体。
- `Timer = {timer_id: string, remaining_s: integer, reason: string}`。

**timer 的硬约束（帮助文本原文）**：

- `after` 单位是**世界时间秒**，范围 **1–1200**（超界被 clamp），省略 = **60 秒**后提醒。
- **最多 8 个待触发**（同时存在的定时器）。
- **立即返回，不占身体**。
- 单机暂停时世界时间会停。
- ⚠️ **2026-11-07 21:00 实机更正：timer 触发的是 URGENT 事件，会打断正在跑的程序**，原文回执：
  `The script stopped at line 76 (numen.status.world) after 4 calls: an urgent timer event arrived. Nothing after that ran.`
  ⇒ **不要用 timer 做"长任务进度上报"**。它是给"主人稍后回来看一眼"的提醒，不是给程序内轮询用的。
  长任务的进度请用：① 树侧 `tree_status` 的"当前技能 / 已运行秒数 / 自报预算"；② 只读 lua `numen.task.status()`（不占动作槽时）；③ `task_finished` 事件。
- **触发时的事件 `kind="timer"`**：`containers` SKILL 原话 "When the `timer` event fires, come back and re-open the furnace"；事件流里长这样（`get_events` 实测格式）：

  ```xml
  <events>
  <event kind="reflex" day="9" t="03:19" reflex="flee">ran from a fight I could not take; …</event>
  </events>
  ```

  即 `<event kind="timer" …>reason 文本</event>`（kind 值取自文档，未活体验证，标**文档**）。
- 它**只是提醒**，不是"事情发生了"的证明（原文："the reminder is not proof the thing happened"）；真正派出去的工作会自己上报结束（程序等到返回值，或 `task_finished` 事件）。

**事件种类汇总（已见）**：`task_finished`（后台任务结束，带 `id` / `task` / `status`，`docs/02` 6.2 实测）、`reflex`（反射，实测）、`timer`（定时器，文档）。事件读取走 MCP `get_events`，**不需要 Lua 槽**（本轮槽被占时仍能读到，实测）⇒ 树在同伴干活期间可以自由观测。

---

## 9. 本地 Lua 源码与 jar 资源位置

### 9.1 模块缓存目录（可读源码）

```
E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\config\numen\lua\<id>\numen\*.lua
```

- 本轮实测只有一份缓存：`<id> = c93a3bad-1de3-3eb9-9e8a-4b8541edc6bb`，内有
  `build.lua fight.lua gui.lua inv.lua move.lua scan.lua shape.lua time.lua work.lua`（另有 `modules.json`）。
- **`<id>` 不是同伴 id**：本轮在线同伴是 `tyrander=9599abe5-8b2b-4470-8952-ee207e73664b`、`helper=a3e22b81-a6f3-48d4-8e7a-df9b4a2e526e`，与 `c93a3bad…` 都不匹配（推断：会话/世界级模块缓存 id，与具体同伴无关——这也解释了为什么只有一份）。
- 这些 `.lua` 是**可读实现**，不是二进制：`inv/move/work/build/gui/time/scan/fight/shape` 的库函数都在里面，命名空间与内核组同名（`numen.inv.fetch` 就在这里定义）。

### 9.2 `modules.json` 说明

```json
{
  "numen.inv": {
    "factory": "6531c7ad452e",
    "runs": 99, "ok": 64,
    "last_run": 1794044095418,
    "failed_line": 1,
    "failed_why": "no_function — there is no API function numen.inv.list …"
  }
}
```

- 每个模块一条：`factory` = 模块源码的工厂哈希（源码变了就换），`runs/ok` = 历史调用次数/成功数，`last_run` = 毫秒时间戳，`failed_line` + `failed_why` = **上次失败的报错原文**。
- 用途：模块按需重编译/热重载（改本地 `.lua` 后按 factory 变化重载，无需重启游戏——`docs/02` "MODULE_CACHE_BYTES 4MB" 是它的缓存上限）。
- 排查利器：**报错被它记住了**。比如 `numen.inv.list` 不存在、`unpack` 未定义、木镐需要 3×3 工作台，`failed_why` 里都是原话。

### 9.3 jar 里的 API 文档 / SKILL（只读解包看）

jar：`E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\mods\numen-neoforge-1.21.1-0.1.4.1.jar`
内嵌 api jar：`META-INF\jarjar\com.dwinovo.numen.api.numen_api-neoforge-1.21.1-0.1.4.1.jar`（只有 class 和 assets/lang、persona 文本，**没有 API markdown**）

解包命令（只读，解到 `$env:TEMP`）：

```powershell
$jar = 'E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\mods\numen-neoforge-1.21.1-0.1.4.1.jar'
$dst = "$env:TEMP\numen-jar-read"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($jar, $dst)
```

里面有价值的内容：

| 路径 | 内容 |
|---|---|
| `modules/*.lua` | 9 个模块的**出厂源码**（与 config 缓存对照，能看出是否被改过） |
| `skills/containers/SKILL.md` | **容器/合成/熔炼全流程**（开箱、put/take/quick/move、熔炉 data、错误恢复） |
| `skills/combat_basics/SKILL.md` | **战斗授权/选目标/战后捡东西/撤退规则**（HP≤8 停手撤退、打不过就报告 unreachable） |
| `skills/tier_progression`、`world_atlas`、`nether_entry`、`dragon_combat`、`blaze_rods`、`ender_pearls`、`stronghold_finding`、`end_game_overview`、`building_design` | 各阶段攻略（`building_design` 有 40+ 风格参考） |
| `data/numen/tags/item/tame_foods.json` | 熟食+植物列表（**不含生肉**，见 6.3） |
| `data/numen/tags/item/throwaway.json` | 可丢弃的建材（cobblestone/dirt/stone/snow_block…） |
| `data/numen/tags/block/safe_block_entity_data.json` | 牌子/旗帜（可安全读方块实体数据） |
| `plugins/{tlm,ysm,kaleidoscope,ftbquests}/skills/*/SKILL.md` | 插件技能包（女仆/皮肤/料理/任务） |

---

## 10. 觅食闭环：可用伪代码（只依赖本文实锤接口）

```lua
-- 目标：hunger 低 → 找食物 → 吃
local me = numen.status.self()

-- ① 背包里就有食物？
local FOODS = { "minecraft:cooked_beef", "minecraft:bread", "minecraft:baked_potato",
                "minecraft:cooked_porkchop", "minecraft:cooked_mutton", "minecraft:cooked_chicken",
                "minecraft:apple", "minecraft:carrot", "minecraft:potato" }   -- 见 tame_foods 标签
for _, f in ipairs(FOODS) do
  if numen.inv.count(f) > 0 then
    return numen.inv.eat(f)                       -- Ate{item, hp, hunger}
  end
end

-- ② 附近有容器？扫方块 → 到手边 → 开窗挑食物（详 5.3）
local boxes = numen.scan.blocks({"minecraft:chest", "minecraft:barrel"}, {radius = 32})
for _, c in ipairs(boxes) do
  local at = c.nearest.pos
  numen.move.to(at, {arrive = "use"})
  local w = numen.use.block(at)
  if w.slots then
    for _, f in ipairs(FOODS) do
      if numen.gui.count(f) > 0 then
        w:take(f)
        w:close()
        return numen.inv.eat(f)
      end
    end
    w:close()
  end
end

-- ③ 打被动生物取生肉（详 6.1 / 6.2）
local MEAT = { ["minecraft:cow"] = true, ["minecraft:pig"] = true,
               ["minecraft:sheep"] = true, ["minecraft:chicken"] = true }
for _, e in ipairs(numen.scan.entities("passive", {radius = 48})) do
  if MEAT[e.type] then
    local r = numen.fight.attack(e.id)            -- blocking，等打完
    numen.work.collect()                           -- ★ 必做：掉落物不会自己进包
    break
  end
end
local raw = { "minecraft:raw_beef", "minecraft:raw_porkchop", "minecraft:raw_mutton", "minecraft:raw_chicken" }
for _, f in ipairs(raw) do
  if numen.inv.count(f) > 0 then
    return numen.inv.eat(f)                        -- 生肉可吃性待验证（6.3）
  end
end

-- ④ 都没有：上报大脑（沿设计边界：报"没有食物来源"，不要自己乱跑）
raise("not_found", "no food in pack, containers within 32, or passive mobs within 48")
```

配套的"长任务进度"写法（第 8 节）：`numen.task.timer("forage: went to the chest", {after = 30})`，事件 `kind="timer"`。

---

## 11. 战斗评估：需要哪些字段、从哪来

| 评估项 | 数据来源 | 备注 |
|---|---|---|
| 自己血量 | `numen.status.self().hp / max_hp` | 有 |
| 饥饿/饱和度 | `.hunger` / `.saturation` | 有 |
| 手持武器 | `.hands.mainhand.item` | 有（空手 nil）；**无法看攻击力/耐久**，只能按物品 id 查表 |
| 护甲 | `.body_state` 字符串（`<worn>head: …`）或 `gear.wear/remove` 结果 | **没有结构化字段**，要用得自己解析字符串 |
| 敌人数 / 种类 / 距离 | `numen.scan.entities("hostile", {radius=32})` → `#list`、`e.type`、`e.distance` | 有 |
| 单个敌人血量 | `e.hp / e.max_hp` | **有**（实测），可以直接算"这只能不能打死" |
| 主人状态 | `numen.status.owner()`（hp/hunger/distance/same_dimension） | 有 |
| 昼夜 | `numen.status.world().is_dark_outside` / `game_time` | 有 |
| 能否打得到 | `numen.scan.sight(e)`（`visible/blocked_by`） | 有 |
| 逃跑 | `numen.move.flee(mob, {distance = 20})` | 有 |
| 撤退阈值 | `combat_basics` SKILL：**HP ≤ 8 → `numen.task.stop()`，撤 20+ 格，回血，重新扫描（运行时 id 会变）** | 文档 |

**推荐评估伪代码（对应 `docs/09` 第 7 节第二步）**：

```lua
local me = numen.status.self()
local hostiles = numen.scan.entities("hostile", {radius = 32})
local hp_ratio = me.hp / me.max_hp

-- 主手物品 id（空手时为 nil，见 12.4）
local held = me.hands and me.hands.mainhand and me.hands.mainhand.item or ""
local has_weapon = held:find("sword") ~= nil or held:find("axe") ~= nil or held:find("trident") ~= nil

if hp_ratio <= 0.4 or #hostiles >= 3 or not has_weapon then
  return "retreat"                                  -- 交给 move.flee / 树
end
-- 逐个评估：只打 hp 明显低于自己的、最近的
table.sort(hostiles, function(a, b) return a.distance < b.distance end)
local target = hostiles[1]
if target and target.hp <= me.hp * 0.5 then
  local r = numen.fight.attack(target.id)
  return r.fought[1] and r.fought[1].status or "unknown"   -- defeated/lost/unreachable/refused
end
return "wait"
```

> 注意：**战斗不能靠 `hp` 全知**——`fight.attack` 内部会自己换武器/切远程/避开爆炸怪；不要在外面替它决定武器，也没有参数可以指定武器（帮助文本明确："Do not try to specify a weapon — there is no parameter for it"）。

---

## 12. 坑与限制（本轮踩到/确认的）

| # | 坑 | 处理 |
|---|---|---|
| 1 | **`numen.api.help()` 必须带 name**，不带直接 `bad_argument` | 想列分组用 `help("numen")` |
| 2 | `scan.entities` 不支持 `"animal"/"mob"/具体类型`，只 5 个枚举 | 拿 `"passive"` 后按 `e.type` 自己过滤 |
| 3 | `status.self()` **没有护甲数组/经验**，护甲只在 `body_state` 字符串里 | 需要结构化就自己解析，或用 `gear.wear` 的返回值 |
| 4 | `status.self().hands.mainhand` 空手时是 **nil** 不是 `{item="air"}` | 判断要 `if me.hands and me.hands.mainhand then` |
| 5 | 掉肉**不自动捡**，`fight.attack` 只管打 | 打完必调 `numen.work.collect()`，否则打一只丢一只 |
| 6 | `work.collect` 默认只扫半径 8；给 `items` 才 64 | 打远处的怪后要给 `{items = drops, radius = 32}` 或先走近 |
| 7 | **生肉可吃性未验证**：jar 的 `numen:tame_foods` 标签不含生肉 | 先 `smelt` 烤熟最稳；或 `inv.eat` 试一次，失败看 `err.kind` |
| 8 | `use.block` **不走路** | 先 `move.to(pos, {arrive="use"})`，否则 `not_found`/够不着 |
| 9 | 容器附近没有时 `scan.blocks` 返回 0（实测） | 扩大 radius、换方块 id 列表（chest/barrel/trapped_chest/furnace）或换地方 |
| 10 | 单字符串截断 200–300、整体截断 6000 | 探针返回切片数组（≤200 字符/片），或只取签名行 |
| 11 | PowerShell 传 JSON 引号被吃 | 一律 `luafile` 或 `callfile probe\args-*.json`，不要 `call ... '{"a":"b"}'` |
| 12 | Lua 槽被树进程/内置脑占用，返回 `a program is already running …` | **等 5 秒重试**（本轮实测等 20–90 秒也会放出来）；不要为此改任何东西 |
| 13 | 槽被占时 `get_events` / `list_companions` / `say` 仍然可用（实测） | 观测走事件通道，不吃 Lua 槽 |
| 14 | 没有 `os` 库、没有 `numen.time.sleep` | 计时用 `time.wait` / `status.world().game_time` |
| 15 | `modules.json` 会记住上次失败原文（`failed_line/failed_why`） | 新函数调用失败先看它，能省一轮猜 |
| 16 | **单次程序有 200 次 Lua API 调用硬上限**（2026-11-07 实机）：`reached the limit of 200 calls per run` | 热循环里别反复调 `numen.*`；预算用"固定次数的小段循环"，不要墙钟轮询 |
| 17 | **`task.timer` 触发 URGENT 事件，会打断当前程序**（实测回执原文见 §8） | 不要拿 timer 做长任务进度上报；用 `tree_status`/`task.status()` |
| 18 | **僵尸锁的真凶是"客户端死在 lua 调用途中"**（taskkill / 超时重连）**以及死亡打断在途调用**（`abandoned calls=1`）；不是死亡本身 | 退出树进程用 `control --op exit`（等在途动作收敛）；**不要 taskkill**。退到主菜单**不能**清锁。`numenlockfix` 补丁 v2 已支持"死亡时定向清 + `/numenlockfix` 手动清"，但**改 jar 后要重启游戏**；旧版只在服务器启动时清表，所以同会话内的锁它管不到 |

**本轮因只读纪律未验证的项**（标"待验证"，实现时优先小成本补测）：

1. `numen.inv.eat("minecraft:raw_beef")` 是否接受生肉（6.3）。
2. `numen.scan.container(cell)` 对真实箱子的 `storage` 文本格式（5.3 写法 C）。
3. `timer` 事件的完整属性（`kind="timer"` 已由文档确认，但没活体验证 `<event …>` 的属性列表）。
4. `scan.blocks` 找到容器方块的正例（本轮半径 32 内确实没有容器）。

> **收尾说明（2026-11-07 晚）**：本轮探测末尾 `tyrander` 和 `helper` 的 Lua 槽都进入僵尸锁（一次超时程序被客户端遗弃所致，`docs/02` 第 5 节的已知现象），**需要主人重启 Minecraft 才能清**。因此上述 4 项留待重启后补测；本文其余内容在锁定前已全部取得（实测/帮助文本/源码）。锁定期间的观测结论也写进了第 8 节：**`get_events` / `list_companions` / `say` 不吃 Lua 槽，锁定时仍可用**。

---

## 13. 探针复现命令（只读）

```powershell
cd E:\game\HMCL\numen-tree

# 单条只读 lua（引号会被 PowerShell 吃，短语句可以，复杂的用文件）
node probe/mcp.mjs call lua '{"companion":"tyrander","code":"return numen.status.self()"}'

# 推荐：lua 文件（本轮全部帮助/字段数据都是这么取的）
$env:NUMEN_COMPANION='tyrander'
node probe/mcp.mjs luafile probe/p23-state.lua        # self/world/owner/task/inv 字段枚举
node probe/mcp.mjs luafile probe/p24-status-help.lua   # status 组签名（切片）
node probe/mcp.mjs luafile probe/p26-gear-fight-task.lua
node probe/mcp.mjs luafile probe/p27-gui-help.lua      # gui + task.timer 全文
node probe/mcp.mjs luafile probe/p28-scan.lua          # 过滤器枚举/实体字段/容器扫描
node probe/mcp.mjs luafile probe/p29-work-use.lua      # work + use 全文
node probe/mcp.mjs luafile probe/p30-sigs-a.lua        # scan/route/move 签名
node probe/mcp.mjs luafile probe/p31-fns.lua           # 各组函数签名（仅签名行）
node probe/mcp.mjs luafile probe/p32-entity-class.lua  # Entity/Item 类字段

# 事件（不吃 Lua 槽）
node probe/mcp.mjs callfile get_events probe/args-events-tyrander.json

# 树侧状态（只读）
node src/cli.mjs status
```

> 每个探针文件顶部都有中文注释说明它取什么；全部只做 `help / status / scan / inv.items / task.status`，不改游戏状态。

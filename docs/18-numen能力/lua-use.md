# numen.use

> Clicking the world like a player: right-click a block (opening its window) or an entity, use what you hold, hit something once, get into bed.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.use.block` | `fun(cell: Pos, opts?: {hold?: number, item?: string, sneak?: boolean}): Window\|Clicked Aim at a block, fluid or air cell within reach and right-click it: the full native click. When it opens a window (a chest, a furnace, a machine) it retu…` | Aim at a block, fluid or air cell within reach and right-click it: the full native click. When it opens a window (a chest, a furnace, a machine) it returns that Window. | ❓ | ❓ | ❓ | ❓ |
| `numen.use.entity` | `fun(entity: integer\|Entity, opts?: {hold?: number, item?: string, sneak?: boolean}): EntityClicked Right-click an entity within reach and in sight of where you stand.` | Right-click an entity within reach and in sight of where you stand. | ❓ | ❓ | ❓ | ❓ |
| `numen.use.hit` | `fun(target: Pos\|Entity): Clicked\|EntityClicked Left-click a cell or an entity within reach once, with what you hold.` | Left-click a cell or an entity within reach once, with what you hold. | ❓ | ❓ | ❓ | ❓ |
| `numen.use.item` | `fun(opts?: {hold?: number, item?: string, sneak?: boolean}): Clicked Right-click at nothing in particular: the held item acts straight ahead, where you face.` | Right-click at nothing in particular: the held item acts straight ahead, where you face. | ❓ | ❓ | ❓ | ❓ |
| `numen.use.sleep` | `fun(opts?: {at?: Pos}): Slept Get into a bed you are standing next to, and say whether you are actually asleep.` | Get into a bed you are standing next to, and say whether you are actually asleep. | ❓ | ❓ | ❓ | ❓ |
| `numen.use.put` | `fun(self: Window, item: string, count?: integer): integer Put items of one kind from your inventory into this window: all of them, or count.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.use.take` | `fun(self: Window, item: string, count?: integer): integer Take items of one kind out of this window into your inventory: all of them, or count.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.use.move` | `fun(self: Window, from: integer, to: integer, opts?: table): Move items from slot from to slot to of this window; opts.count moves part of the stack.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.use.quick` | `fun(self: Window, slot: integer): Shift-click a slot of this window: its whole stack goes to the other side.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.use.close` | `fun(self: Window): Close this window.` |  | ❓ | ❓ | ❓ | ⚠️ |

原始帮助：`docs/18-data/raw-help/numen-use.txt`（含完整说明，按需读）
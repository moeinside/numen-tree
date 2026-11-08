# numen.inv

> Your inventory: what you carry, recipes, crafting, eating, dropping.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.inv.count` | `fun(item: string): integer How many of one item you carry in your backpack.` | How many of one item you carry in your backpack. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.craft` | `fun(recipe: string, opts?: {count?: integer}): Crafted Craft once in the crafting grid you have open: lay one recipe into it and take the result.` | Craft once in the crafting grid you have open: lay one recipe into it and take the result. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.craftable` | `fun(): Recipe[] Every crafting recipe you can craft right now from what you carry.` | Every crafting recipe you can craft right now from what you carry. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.drop` | `fun(item: string, opts?: {count?: integer}): Dropped Drop items from your inventory on the ground in front of you.` | Drop items from your inventory on the ground in front of you. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.eat` | `fun(item: string): Ate Eat or drink something from your inventory.` | Eat or drink something from your inventory. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.items` | `fun(): Stack[] What you carry in your backpack, one entry per kind of item.` | What you carry in your backpack, one entry per kind of item. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.recipes` | `fun(item: string): Recipe[] How an item is made, like JEI: every recipe that outputs it, at every station.` | How an item is made, like JEI: every recipe that outputs it, at every station. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.make` | `fun(item: string, count?: integer): integer Make count of item (default 1): pick a crafting recipe you have the materials for (numen.inv.recipes), and craft it with numen.inv.craft until there are enough.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.inv.store` | `fun(at: Pos\|Block, item: string, count?: integer): integer Walk to a container (a chest, a barrel …), open it, put count of item in (all you carry by default) and close it.` | Walk to a container (a chest, a barrel …), open it, put count of item in (all you carry by default) and close it. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.fetch` | `fun(at: Pos\|Block, item: string, count?: integer): integer Walk to a container, open it, take count of item out (all it holds by default) and close it.` | Walk to a container, open it, take count of item out (all it holds by default) and close it. | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.smelt` | `fun(furnace: Pos\|Block, item: string, count?: integer, opts?: {fuel?: string, timeout?: number}): integer Smelt count of item (all you carry by default) in a furnace, blast furnace or smoker: walk to it, put the item in and opts.fuel (defa…` | Smelt count of item (all you carry by default) in a furnace, blast furnace or smoker: walk to it, put the item in | ❓ | ❓ | ❓ | ❓ |
| `numen.inv.give` | `fun(target: Entity\|Pos, item: string, count?: integer): integer Give count of item (all you carry by default) to a player or another entity: walk within 2 blocks of them (numen.move.to with arrive "near") and drop it there for them to pick…` | Give count of item (all you carry by default) to a player or another entity: walk within 2 blocks of them | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-inv.txt`（含完整说明，按需读）
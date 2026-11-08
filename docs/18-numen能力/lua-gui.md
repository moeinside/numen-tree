# numen.gui

> The window you have open (numen.use.block on a chest or a machine opens one): read it, put items in and take them out, move a stack, close it.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.gui.close` | `fun(self: Window): Close this window.` | Close the window you have open, once you have finished with it. Returns true when it closed one, false when none was open. | ❓ | ❓ | ❓ | ❓ |
| `numen.gui.move` | `fun(self: Window, from: integer, to: integer, opts?: table): Move items from slot from to slot to of this window; opts.count moves part of the stack.` | Move items from one slot of the window you have open to another: move, merge or swap. | ❓ | ❓ | ❓ | ❓ |
| `numen.gui.put` | `fun(self: Window, item: string, count?: integer): integer Put items of one kind from your inventory into this window: all of them, or count.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.gui.quick` | `fun(self: Window, slot: integer): Shift-click a slot of this window: its whole stack goes to the other side.` | Shift-click a slot of the window you have open: its whole stack goes to the other side. | ❓ | ❓ | ❓ | ❓ |
| `numen.gui.take` | `fun(self: Window, item: string, count?: integer): integer Take items of one kind out of this window into your inventory: all of them, or count.` | Take items of one kind out of the window you have open into your inventory: all of them, or count. | ❓ | ❓ | ❓ | ❓ |
| `numen.gui.view` | `fun(): Window Look at the window you have open, or at your own inventory menu when none is.` | Look at the window you have open, or at your own inventory menu when none is. | ❓ | ❓ | ❓ | ❓ |
| `numen.gui.count` | `fun(item: string): integer How many of item the window's own side holds (its container slots, not your inventory), counted in the open window now.` | How many of item the window's own side holds (its container slots, not your inventory), counted in the open | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-gui.txt`（含完整说明，按需读）
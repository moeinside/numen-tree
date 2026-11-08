# numen.move

> Moving: walk a plan from numen.route.plan, follow someone for a while, step off what you ride. numen.move.to (library) plans and walks to one place.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.move.dismount` | `fun(): Dismounted Step off the boat, minecart or mount you ride, as a player does with sneak.` | Step off the boat, minecart or mount you ride, as a player does with sneak. | ❓ | ❓ | ❓ | ❓ |
| `numen.move.follow` | `fun(entity?: integer\|Entity, opts?: {distance?: integer, seconds?: integer}): Followed Tag along with your owner, or with an entity you name, for a while.` | Tag along with your owner, or with an entity you name, for a while. | ❓ | ❓ | ❓ | ❓ |
| `numen.move.go` | `fun(plan: Plan): Walked Walk a plan from numen.route.plan, keeping to it.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.move.to` | `fun(target: Pos\|Block\|Entity\|table, spec?: table): {pos: Pos, distance_left: number} Walk to a place in one call: numen.route.plan with the description and to = target, then numen.move.go.` | Walk to a place in one call: numen.route.plan with the description and to = target, then numen.move.go. A walk that can't be | ❓ | ❓ | ❓ | ❓ |
| `numen.move.flee` | `fun(from: Pos\|Block\|Entity\|table, opts?: table): {pos: Pos, distance_left: number} Get away from something: walk until you are at least distance blocks from it (numen.route.plan with arrive "away").` | Get away from something: walk until you are at least distance blocks from it (numen.route.plan with arrive "away"). | ❓ | ❓ | ❓ | ❓ |
| `numen.move.explore` | `fun(dir: string\|Pos, opts: table): any Head out a hop at a time, calling until_ after each hop, until it returns something or about seconds of walking are used up.` | Head out a hop at a time, calling until_ after each hop, until it returns something or about seconds of walking are | ❓ | ❓ | ❓ | ❓ |
| `numen.move.filter` | `fun(self: Cluster, keep: fun(block: Block): ): Cluster The blocks of this cluster that keep(block) says yes to, as a cluster (nearest first, as before).` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.move.minus` | `fun(self: Cluster, other: Cells\|(Block\|Pos): []\|Pos\|Block): Cluster This cluster without the cells other has: Cells, a list of Blocks or Pos, or one Pos or Block.` |  | ❓ | ❓ | ❓ | ⚠️ |

原始帮助：`docs/18-data/raw-help/numen-move.txt`（含完整说明，按需读）
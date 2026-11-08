# numen.route

> Pathfinding: plan a walk from a description, without moving; numen.move.go walks the plan.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.route.plan` | `fun(opts?: numen.route.plan.opts): Plan Plan a walk from where you stand, without moving: each leg's way, the blocks it would break or place, and the cells it would ask your owner about.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.route.filter` | `fun(self: Cluster, keep: fun(block: Block): ): Cluster The blocks of this cluster that keep(block) says yes to, as a cluster (nearest first, as before).` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.route.minus` | `fun(self: Cluster, other: Cells\|(Block\|Pos): []\|Pos\|Block): Cluster This cluster without the cells other has: Cells, a list of Blocks or Pos, or one Pos or Block.` |  | ❓ | ❓ | ❓ | ⚠️ |

原始帮助：`docs/18-data/raw-help/numen-route.txt`（含完整说明，按需读）
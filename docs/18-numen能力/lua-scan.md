# numen.scan

> Look around you: the ground map, where blocks are, who is near, one block and what it holds, whether you can see something.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.scan.block` | `fun(cell: Pos): BlockInfo One block: its id and state, hardness, whether your held tool is right, dig time, whether it is in reach.` | One block: its id and state, hardness, whether your held tool is right, dig time, whether it is in reach. | ❓ | ❓ | ❓ | ❓ |
| `numen.scan.blocks` | `fun(block_ids: string\|string[], opts?: {radius?: integer}): Cluster[] Find blocks of the given types near you, as clusters of touching blocks, nearest first.` | Find blocks of the given types near you, as clusters of touching blocks, nearest first. | ❓ | ❓ | ❓ | ❓ |
| `numen.scan.container` | `fun(cell: Pos): Storage What a block holds — items, fluid, energy — read without opening it.` | What a block holds — items, fluid, energy — read without opening it. | ❓ | ❓ | ❓ | ❓ |
| `numen.scan.entities` | `fun(type_filter?: "hostile"\|"passive"\|"player"\|"item"\|"all", opts?: {radius?: number}): (Entity\|Item)[] List the entities near you, nearest first, with the ids other functions take.` | List the entities near you, nearest first, with the ids other functions take. | ❓ | ❓ | ❓ | ❓ |
| `numen.scan.map` | `fun(opts?: {radius?: integer}): GroundMap A top-down map of the ground around you: where you can walk, step, drop, swim.` | A top-down map of the ground around you: where you can walk, step, drop, swim. | ❓ | ❓ | ❓ | ❓ |
| `numen.scan.sight` | `fun(target: Pos\|Entity): Sight Whether you can see a cell or an entity from where you stand, and what is in the way when you cannot.` | Whether you can see a cell or an entity from where you stand, and what is in the way when you cannot. | ❓ | ❓ | ❓ | ❓ |
| `numen.scan.cluster` | `fun(blocks: Block[]): Cluster A Cluster of these blocks, nearest first as you give them: its nearest is the first, its count how many.` | A Cluster of these blocks, nearest first as you give them: its nearest is the first, its count how many. | ❓ | ❓ | ❓ | ❓ |
| `numen.scan.filter` | `fun(self: Cluster, keep: fun(block: Block): ): Cluster The blocks of this cluster that keep(block) says yes to, as a cluster (nearest first, as before).` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.scan.minus` | `fun(self: Cluster, other: Cells\|(Block\|Pos): []\|Pos\|Block): Cluster This cluster without the cells other has: Cells, a list of Blocks or Pos, or one Pos or Block.` |  | ❓ | ❓ | ❓ | ⚠️ |

原始帮助：`docs/18-data/raw-help/numen-scan.txt`（含完整说明，按需读）
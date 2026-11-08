# numen.shape

> Positions and shapes: Pos values that add and measure, shapes drawn as Cells, and Cells you can turn, move and combine.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.shape.pos` | `fun(x: number, y: number, z: number): Pos A Pos at x, y, z.` | A Pos at x, y, z. | ❓ | ❓ | ❓ | ❓ |
| `numen.shape.cells` | `fun(list: (Block\|Pos): []): Cells Cells from a list of Blocks (a block to put in each cell) or Pos (just the cells): a scan's blocks, numen.build.diff's result, your own list.` | Cells from a list of Blocks (a block to put in each cell) or Pos (just the cells): a scan's blocks, numen.build.diff's | ❓ | ❓ | ❓ | ❓ |
| `numen.shape.box` | `fun(from: Pos, to: Pos, block?: string, hollow?: boolean): Cells Every cell of the box between two corners, or only its faces when hollow.` | Every cell of the box between two corners, or only its faces when hollow. With block each cell is that Block (written | ❓ | ❓ | ❓ | ❓ |
| `numen.shape.line` | `fun(from: Pos, to: Pos, block?: string): Cells A line of cells from one point to another, diagonals included: beams, posts, ridges.` | A line of cells from one point to another, diagonals included: beams, posts, ridges. | ❓ | ❓ | ❓ | ❓ |
| `numen.shape.cylinder` | `fun(base: Pos, radius: integer, height: integer, block?: string, hollow?: boolean): Cells A cylinder standing on its bottom centre: towers, wells, round rooms; only its wall when hollow.` | A cylinder standing on its bottom centre: towers, wells, round rooms; only its wall when hollow. | ❓ | ❓ | ❓ | ❓ |
| `numen.shape.sphere` | `fun(center: Pos, radius: integer, block?: string, hollow?: boolean): Cells A sphere around its centre: domes, globes; only its shell when hollow.` | A sphere around its centre: domes, globes; only its shell when hollow. | ❓ | ❓ | ❓ | ❓ |
| `numen.shape.layer` | `fun(at: Pos, rows: string[], legend: table<string, string>): Cells One level drawn as a character grid: a floor, a wall ring, a roof course, a window pattern.` | One level drawn as a character grid: a floor, a wall ring, a roof course, a window pattern. Rows run +x from at, the | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-shape.txt`（含完整说明，按需读）
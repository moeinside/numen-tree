# numen.build

> Building: make the cells your hand reaches from where you stand look like Cells (numen.shape draws them) or a blueprint file. numen.build.raise (library) walks the site and builds all of it.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.build.blueprint` | `fun(name: string, origin: Pos, opts?: {rotation?: integer}): Blueprint A blueprint file placed at a spot: its size, cells and materials, for numen.build.place and numen.build.diff.` |  | ❓ | ❓ | ❓ | ⚠️ |
| `numen.build.diff` | `fun(design: Cells\|Blueprint): Diff What a spot still lacks to look like a design, seen from where you stand: how many cells are within reach to place, which must be dug out first, how many are out of reach and the lowest nearest of those.` | What a spot still lacks to look like a design, seen from where you stand: how many cells are within reach to place, which must be dug out first, how many are out of reach and the lowest nearest of th… | ❓ | ❓ | ❓ | ❓ |
| `numen.build.place` | `fun(design: Cells\|Blueprint): Placed Make the cells of a design that your hand reaches from where you stand look like it: each such cell gets its turn once.` | Make the cells of a design that your hand reaches from where you stand look like it: each such cell gets its turn once. | ❓ | ❓ | ❓ | ❓ |
| `numen.build.raise` | `fun(building: Cells\|Blueprint, opts?: table): integer Build Cells or a Blueprint (from numen.build.blueprint) until all of it went in.` | Build Cells or a Blueprint (from numen.build.blueprint) until all of it went in. Each round asks numen.build.diff what | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-build.txt`（含完整说明，按需读）
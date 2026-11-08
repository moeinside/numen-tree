# numen.work

> Gathering where you stand: digging blocks within reach, fishing. numen.work.collect (library) walks to the drops and picks them up.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.work.dig` | `fun(blocks: Pos\|Block\|(Pos\|Block): [], opts?: {count?: integer}): Dug Dig the given blocks that are within reach of where you stand.` | Dig the given blocks that are within reach of where you stand. | ❓ | ❓ | ❓ | ❓ |
| `numen.work.fish` | `fun(): string[] Cast a fishing rod once from where you stand, wait for a bite and reel it in.` | Cast a fishing rod once from where you stand, wait for a bite and reel it in. | ❓ | ❓ | ❓ | ❓ |
| `numen.work.collect` | `fun(opts?: table): integer Pick up the dropped items around you, nearest first, walking onto each with numen.move.to.` | Pick up the dropped items around you, nearest first, walking onto each with numen.move.to. Given items (the drops | ❓ | ❓ | ❓ | ❓ |
| `numen.work.mine` | `fun(cluster: Cluster\|Cells): integer Dig out one cluster, walking first: walk within reach of it (numen.move.to with arrive "dig": where your hand reaches the most of what is left of it, digging and pillaring on the way but keeping away fr…` | Dig out one cluster, walking first: walk within reach of it (numen.move.to with arrive "dig": where your hand reaches | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-work.txt`（含完整说明，按需读）
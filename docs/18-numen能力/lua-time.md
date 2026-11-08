# numen.time

> Pausing your program: waiting a while where you stand.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.time.wait` | `fun(seconds: number): number Stand where you are for a number of seconds, then go on.` | Stand where you are for a number of seconds, then go on. | ❓ | ❓ | ❓ | ❓ |
| `numen.time.wait_until` | `fun(ready: fun(): , opts?: {every?: number, timeout?: number}): number Wait until ready() returns true, checking every opts.every seconds (default 1).` | Wait until ready() returns true, checking every opts.every seconds (default 1). Raises timeout after opts.timeout | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-time.txt`（含完整说明，按需读）
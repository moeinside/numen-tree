# numen.task

> The background task and your pending timers.

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.task.status` | `fun(): Status What you have in flight: the background task and your pending timers.` | What you have in flight: the background task and your pending timers. | ❓ | ❓ | ❓ | ❓ |
| `numen.task.stop` | `fun(opts?: {task_id?: string}): Stopped Cancel the background task, or a task or timer by its id.` | Cancel the background task, or a task or timer by its id. | ❓ | ❓ | ❓ | ❓ |
| `numen.task.timer` | `fun(reason: string, opts?: {after?: integer}): Timer Set a one-shot reminder that fires after a delay in world time.` | Set a one-shot reminder that fires after a delay in world time. | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-task.txt`（含完整说明，按需读）
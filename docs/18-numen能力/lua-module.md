# numen.module

> Modules — functions written in Lua 5.2 that programs use by name, kept as files on your owner's computer (numen/work.lua is numen.work): the built-in ones, your own, and how the programs that used th…

| 函数 | 签名 | 摘要 | 原子 | 树角色 | 优先级 | 实测 |
|---|---|---|---|---|---|---|
| `numen.module.delete` | `fun(name: string): Delete a module. A built-in one stays deleted until you reset it.` | Delete a module. A built-in one stays deleted until you reset it. | ❓ | ❓ | ❓ | ❓ |
| `numen.module.list` | `fun(): ModuleInfo[] The modules: what each does, whose it is, how the programs that used it went.` | The modules: what each does, whose it is, how the programs that used it went. | ❓ | ❓ | ❓ | ❓ |
| `numen.module.reset` | `fun(name: string): Put a built-in module back as it shipped with this version: your changes go, a deleted one comes back.` | Put a built-in module back as it shipped with this version: your changes go, a deleted one comes back. | ❓ | ❓ | ❓ | ❓ |
| `numen.module.save` | `fun(code: string, opts?: {name?: string}): Saved Keep a module under a name: programs then use its functions by that name. Saving under a built-in module's name changes that module.` | Keep a module under a name: programs then use its functions by that name. Saving under a built-in module's name changes that module. | ❓ | ❓ | ❓ | ❓ |
| `numen.module.show` | `fun(name: string, opts?: {factory?: boolean}): Shown Show a module in full, with how the programs that used it went.` | Show a module in full, with how the programs that used it went. | ❓ | ❓ | ❓ | ❓ |

原始帮助：`docs/18-data/raw-help/numen-module.txt`（含完整说明，按需读）
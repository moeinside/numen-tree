# Numen Tree DevTools（dev-only GM portal）

> 2026-11-10。对应 docs/85（GM 通道设计）、docs/90 §1A（第二阶段 GM）。
> 状态：**源码、构建、mock 测试已完成；未安装进游戏、未重启、未对真实世界发过命令。**
> 实机验证（真实 NeoForge 加载 + 真实 `/tp`）需 Lead 明确授权，见文末。

## 1. 这是什么

一个**薄的命令入口**：开发工具通过 loopback HTTP 把一条 Minecraft 命令交给 mod，mod 做鉴权/白名单/世界/频率/审计后，调用服务器现成的 command dispatcher（权限 4，服务器线程）。它**不重写** tp/give/time/setblock，也不提供类型化 op。

```text
GMProvider (tools/pilot/gm-provider.mjs)
  -> POST http://127.0.0.1:8770/dev/v1/command
    -> numen_devtools (this mod)
      -> MinecraftServer command dispatcher (permission 4, server thread)
```

硬边界：

- 只绑定 `127.0.0.1:8770`，不监听公网；
- 默认 `enabled=false`，必须显式改配置才会启动；
- 只允许配置里的测试世界（默认 `numen-test`）；
- root 白名单 + `execute` 递归检查；
- 所有请求写 JSONL 审计；
- **GM 结果不作验收/学习正样本**，run 应标 `assisted/gm`；
- 生产构建不打包监听类（`-Production` 对应的产物已生成并验证）。

## 2. 构建（不安装）

```powershell
cd E:\game\HMCL\numen-tree
powershell -NoProfile -ExecutionPolicy Bypass -File .\devtools\build.ps1
```

产物（`devtools/build/`，已被 `.gitignore` 忽略）：

| 文件 | 说明 |
|---|---|
| `numen-devtools-0.1.0.jar` | dev 构建，包含 `numentree/devtools/portal` 监听实现 |
| `numen-devtools-0.1.0-prod.jar` | 生产构建，**不含** portal 类；即使 `enabled=true` 也只会打日志并保持空闲 |
| `selftest.json` | Java 42 项 policy/HTTP 自测证据 |
| `build-info.json` | jar 路径、大小、SHA-256、portal 类是否打包、测试计数 |

只跑测试、不产出 jar：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\devtools\build.ps1 -TestOnly
```

构建脚本只读 `.minecraft/libraries` 和版本 jar 作为 classpath，不改动它们，也不复制 jar 到 mods。

## 3. 配置与 token（运行时，不进仓库）

配置路径：`<gameDir>/config/numen-devtools.json`。首次加载会写一份 `enabled=false` 的默认配置。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 唯一的启用开关；`false` 时完全不监听 |
| `bindAddress` | `127.0.0.1` | 只接受 loopback，否则拒绝启动 |
| `port` | `8770` | 1..65535 |
| `tokenFile` | `config/numen-devtools.token` | 相对 gameDir；token 不写进配置/仓库 |
| `allowedWorlds` | `["numen-test"]` | 世界名白名单；空数组=全部拒绝 |
| `maxPerMinute` | `10` | 每分钟请求上限（滑动窗口，进程内） |
| `maxCommandLength` | `512` | 命令字符上限 |
| `maxBodyBytes` | `65536` | HTTP body 上限 |

示例见 [`examples/numen-devtools.json`](examples/numen-devtools.json)。

生成 token（32 随机字节，hex，>=32 字符）：

```powershell
$dir = Join-Path $env:APPDATA '.minecraft\config'   # 按实际 gameDir 调整
New-Item -ItemType Directory -Force $dir | Out-Null
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToHexString($bytes).ToLower() | Set-Content (Join-Path $dir 'numen-devtools.token') -NoNewline
```

建议用 NTFS ACL 把 token 限制到当前用户（示例，按需调整账户）：

```powershell
icacls "$dir\numen-devtools.token" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

**不要把 token 写进仓库、命令历史、日志或聊天记录。** mod 和 GMProvider 都不会输出 token。

## 4. HTTP API

### `POST /dev/v1/command`

```http
Authorization: Bearer <token>
Content-Type: application/json

{
  "runId": "pilot-2026-11-10-a",
  "command": "execute as @e[name=bigwhale,limit=1] at @s run tp @s 128.66 67 183.3",
  "reason": "stuck_water",
  "selfChallenge": ["真的无解吗", "最小操作是tp", "会标记assisted"]
}
```

成功：

```json
{"ok":true,"result":1,"output":[],"world":"numen-test"}
```

`output` 目前为空数组：当前实现用 `withSuppressedOutput()` 避免刷屏，只保留 dispatcher 的 result。需要文本输出是后续增强，不是本轮承诺。

失败统一为：

```json
{"ok":false,"error":{"code":"forbidden_root","message":"root command is forbidden: stop"}}
```

HTTP 状态：

| 状态 | 含义 |
|---|---|
| 200 | 命令被接受；`ok=false` 表示 dispatcher 拒绝/执行失败（`command_failed`） |
| 400 | 请求体/字段/命令语法/长度/控制字符问题 |
| 401 | 缺失/错误的 Bearer token |
| 403 | 非 loopback、root 不在白名单、禁命令、世界不允许 |
| 405 | 方法错误（命令端点只接受 POST） |
| 413 | body 超过 `maxBodyBytes` |
| 415 | `Content-Type` 不是 `application/json` |
| 429 | 超过 `maxPerMinute`，带 `Retry-After` |
| 503/504 | 服务器未就绪 / 服务器线程执行超时 |
| 500 | 内部/审计写入失败等 |

### `GET /health`

无 token，返回 `{"ok":true,"mod":"numen_devtools","version":"0.1.0","portal":"dev"}`。只用于确认 mod 已加载、监听已启动；不暴露世界或 token。

## 5. 命令白名单

允许 root：

```text
tp give time weather setblock fill summon effect gamemode xp execute
```

`execute` 必须含顶层 `run`，并递归检查子命令 root；嵌套 `execute` 同样递归。深度上限 8。

禁止 root（显式拒绝并记审计）：

```text
stop reload op deop ban whitelist
gamerule difficulty peaceful
kill clear data
```

其他 root 一律 `root_not_allowed`。命令长度、控制字符、未闭合引号也会被拒。带一个前导 `/` 会被规范化去掉。

## 6. 审计

默认：`<gameDir>/logs/numen-devtools-audit.jsonl`，一行一次请求决策，包含：

```text
ts, schema, event, remote, runId, command, reason, selfChallenge,
decision(allowed/denied/error), code, httpStatus, roots, world,
result, outputCount, durationMs
```

启动/停止也会写 `event=startup|shutdown`。审计**不包含 token**。审计写入失败时，允许执行的命令会在响应中返回 `audit_unavailable`（命令可能已执行，需看服务器日志）。

## 7. 测试

```powershell
# Java：42 项 allowlist / execute 递归 / 禁命令 / token / world / rate / audit / 请求边界
powershell -NoProfile -ExecutionPolicy Bypass -File .\devtools\build.ps1 -TestOnly

# Node：18 项 GMProvider mock HTTP / 结构化失败 / 必填字段 / gm.jsonl / 构建产物
node tools\pilot\gm-provider-selftest.mjs
```

合并证据：`logs/gm-portal-selftest.json`（`passed=true` 时 Java 与 Node 都通过）。
本轮结果：Java `42/42`，Node `18/18`，生产 jar 已验证不含 portal 类。

## 8. 未完成 / 待授权

- **未安装** `numen-devtools-0.1.0.jar` 到 `.minecraft/.../mods`；
- **未重启游戏**，因此没有真实 NeoForge 加载日志、没有真实 `/tp`；
- 真实世界名、真实 token、真实权限 4、真实 dispatcher `output` 行为未实机验证；
- GMProvider 尚未自动接入 `run.mjs`（本轮只交付 provider 与测试；接入需要 Lead 决定运行流程）；
- `output` 文本捕获未实现；
- 真实 `/health`/`POST` 需要用户手动重启游戏后才可验证。

实机验证的前置授权清单见 [`MAINTENANCE.md`](MAINTENANCE.md) §10。

## 9. 一句话

> **mod 只是受控的 `/command` 入口：loopback + token + root 白名单 + 测试世界 + 频率 + 审计；默认关闭，生产构建不打包监听。**

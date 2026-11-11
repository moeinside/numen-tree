# DevTools / GM portal 维护手册

> 版本：0.1.0（2026-11-10）
> 适用：`devtools/`（NeoForge mod）、`tools/pilot/gm-provider.mjs`、`tools/pilot/gm-provider-selftest.mjs`。
> 口径：docs/85、docs/90 §1A；不碰 `src/`、docs/78/86、验收口径、树行为。

## 0. 一句话

> 真相是 **配置 `enabled` + loopback + token + 白名单 + 测试世界 + 审计**；mod 只是 Minecraft command dispatcher 的受控入口，不是作弊功能重写。默认不监听，生产构建不打包监听类。

## 1. 交付范围与明确未交付

### 1.1 已交付

- NeoForge mod `numen_devtools` 0.1.0（`devtools/src`）；
- 构建脚本 `devtools/build.ps1`：javac → 纯逻辑/HTTP 自测 → dev jar + production jar + build-info；
- `POST /dev/v1/command` + `GET /health`，loopback 8770；
- Bearer token（从 `<gameDir>/config/numen-devtools.token` 读，>=32 字符，常量时间比较）；
- root 白名单 + `execute` 递归检查 + 禁命令；
- 测试世界白名单（默认 `numen-test`，空数组 fail closed）；
- 每分钟频率限制、命令长度、body 上限、Content-Type、方法限制；
- JSONL 审计（含启动/停止、允许/拒绝、耗时、world、roots）；
- 服务器线程执行，permission 4，`withSuppressedOutput()`；
- `tools/pilot/gm-provider.mjs`：必填字段本地校验、结构化失败、loopback 限制、可选 `gm.jsonl`；
- Java 42 项 + Node 18 项 mock 测试，合并证据 `logs/gm-portal-selftest.json`；
- production jar 不含 `numentree/devtools/portal`，通过反射加载失败后保持空闲。

### 1.2 明确未交付 / 未验证

- **未安装 jar、未重启游戏、未对真实世界发命令**；
- 真实 NeoForge 加载、真实 `/tp`、真实权限 4、真实 dispatcher 回调未实机验证；
- dispatcher 的输出文本未捕获（`output` 恒为空）；
- GMProvider 未自动接入 `run.mjs`（无自动 GM 决策/前后态采集）；
- token 轮换需要人工改文件 + 重启（无热加载）；
- 无 TLS（仅 loopback，符合设计）、无多 token/角色。

## 2. 架构

```text
tools/pilot/gm-provider.mjs
  - validate runId/reason/selfChallenge/command/length
  - loopback check
  - POST /dev/v1/command (Bearer)
  - structured result + optional gm.jsonl
        │
        ▼
numentree.devtools.DevToolsMod (NeoForge @Mod)
  - ServerStartedEvent: load config -> token -> reflectively load portal
  - ServerStoppingEvent: stop portal
        │
        ▼
numentree.devtools.portal.PortalService
  - ServerCommandSink: world check; MinecraftServer.execute(...)
  - createCommandSourceStack().withPermission(4).withSuppressedOutput().withCallback(...)
  - performPrefixedCommand(source, command)
        │
        ▼
numentree.devtools.portal.PortalCore (pure JDK)
  - loopback + auth + content-type + body limit
  - JSON parse + request fields
  - rate limit
  - CommandPolicy (allowlist/execute recursion)
  - AuditLog JSONL
  - JSON response
```

纯 JDK 分层是刻意的：`PortalCore` / `CommandPolicy` / `RateLimiter` / `TokenStore` / `AuditLog` 不依赖 Minecraft，测试不需要游戏进程。

## 3. 文件与职责

| 文件 | 职责 |
|---|---|
| `DevToolsMod.java` | mod 入口；配置/事件；反射加载 portal（生产构建安全降级） |
| `DevToolsConfig.java` | 配置 record、默认文件、校验、token 路径 |
| `CommandSink.java` / `CommandOutcome.java` | 传输无关的执行接口/结果 |
| `portal/PortalCore.java` | HTTP、鉴权、body、rate、policy、audit、响应 |
| `portal/PortalService.java` | Minecraft 适配：世界名、服务器线程、permission 4 |
| `security/CommandPolicy.java` | root 白名单、禁命令、execute 递归、世界白名单 |
| `security/TokenStore.java` | token 加载/常量时间比较/脱敏 |
| `security/RateLimiter.java` | 滑动窗口；可注入时钟 |
| `audit/AuditLog.java` | JSONL 追加 |
| `util/Json.java` | 最小 JSON 解析/序列化（无 Gson 依赖） |
| `tests/.../Selftest.java` | 42 项纯逻辑 + mock HTTP |
| `build.ps1` | 构建、测试、dev/prod jar、`build-info.json` |
| `tools/pilot/gm-provider.mjs` | 工具侧客户端 |
| `tools/pilot/gm-provider-selftest.mjs` | 18 项 mock HTTP + 证据合并 |

## 4. 端口与进程

| 端口 | 服务 | 谁持有 | 说明 |
|---|---|---|---|
| 8770 | GM portal | 游戏进程内的 `numen_devtools` | **默认不监听**；仅 dev 配置启用时 |
| 8765 | numen MCP | 游戏 | GM 不接管、不冲突 |
| 8766/8767 | 树 | 树 daemon | GM 无关 |

- 只绑定 `127.0.0.1`；请求端也检查 remote 是 loopback；
- 端口冲突：`HttpServer.create` 失败 → 打日志、写 startup audit、mod 继续运行但不监听；
- 不 taskkill、不静默重启游戏；停服只走 `ServerStoppingEvent`。

## 5. 配置字段

见 `DevToolsConfig` 与 `examples/numen-devtools.json`。校验规则：

- `bindAddress` ∈ {`127.0.0.1`, `::1`, `localhost`}，否则拒绝启动；
- `port` 1..65535；
- `allowedWorlds` 至少一项（空=拒绝一切）；
- `maxPerMinute` 1..600；
- `maxCommandLength` 16..4096；
- `maxBodyBytes` 1024..1048576。

token 文件：

- 相对路径按 gameDir 解析；
- 必须 ≥32 字符、无空白；
- 缺失/过短/空文件 → 不监听，startup audit `token_unavailable`；
- 首次只写默认配置，**不会自动生成 token**。

## 6. 安全不变量（不可破坏）

1. 只 loopback；不允许把 `bindAddress` 改成 `0.0.0.0` 并绕过校验。
2. `enabled=false` 时绝不监听。
3. token 不写仓库、不写日志、不出现在异常/审计/GMProvider 输出里。
4. 命令必须过 root 白名单；`execute` 递归，深度 ≤8。
5. 禁命令显式拒绝（`forbidden_root`），未知 root 拒绝（`root_not_allowed`）。
6. 只允许 `allowedWorlds` 中的世界；世界名从服务器 `WorldData.getLevelName()` 读取。
7. 频率限制在鉴权/字段校验之后、执行之前；每请求一次。
8. 所有决策写审计；审计失败不能静默当作成功。
9. 执行必须在服务器线程、permission 4；不伪装成同伴实体。
10. 生产 jar 不包含 `portal` 包；`enabled=true` 也只能记录 `portal_not_packaged` 并保持空闲。
11. GM 不写 Facts/学习/验收；run 标 `assisted/gm`（工具侧约定）。

## 7. 错误码

| code | HTTP | 触发 |
|---|---|---|
| `loopback_only` | 403 | remote 非 loopback（正常绑定下不会发生） |
| `unauthorized` | 401 | 缺失/错误 Bearer |
| `unsupported_media_type` | 415 | 非 application/json |
| `body_too_large` | 413 | 超过 maxBodyBytes |
| `invalid_json` | 400 | JSON 语法/根不是对象 |
| `invalid_run_id` / `invalid_command` / `invalid_reason` / `invalid_self_challenge` | 400 | 必填字段缺失/格式错 |
| `rate_limited` | 429 | 超过 maxPerMinute（带 Retry-After） |
| `empty_command` / `command_too_long` / `bad_characters` / `invalid_syntax` | 400 | 命令格式 |
| `forbidden_root` | 403 | 禁命令（含 execute 子命令） |
| `root_not_allowed` | 403 | 不在允许 root |
| `execute_without_run` / `execute_too_deep` | 403 | execute 结构 |
| `world_not_allowed` | 403 | 世界不在白名单 |
| `command_failed` | 200 + `ok=false` | dispatcher 拒绝（语法/selector/权限） |
| `server_not_ready` | 503 | `!server.isRunning()` |
| `timeout` | 504 | 服务器线程 5s 未完成 |
| `execution_failed` | 500 | 服务器线程调度/异常 |
| `audit_unavailable` | 500 | 审计写入失败（命令可能已执行） |
| `portal_not_packaged` | —（startup audit） | production jar 缺 portal 类 |

## 8. 审计

路径：`<gameDir>/logs/numen-devtools-audit.jsonl`，schema `numen-devtools-audit/1`。

- 每个请求一行：`event=command`；
- 启动/停止：`event=startup|shutdown`；
- 拒绝也会写（包括 401/400/403/429）；
- 不含 token、Authorization、body 原文之外的敏感信息（命令本身会记录）；
- 审计是 append-only；不要用删除日志来“清状态”。

> 已知取舍：拒绝路径目前先回 HTTP 再追加审计；正常客户端在响应结束前已落盘，但极端崩溃可能丢最后一条拒绝记录。允许执行的路径是先审计后响应。

## 9. 构建 / 升级 / 回滚

### 9.1 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\devtools\build.ps1
```

要求：

- JDK（脚本优先 `C:\Program Files\Microsoft\jdk-25.0.4.7-hotspot`，回退 `JAVA_HOME`）；
- `.minecraft/libraries` 中 NeoForge 21.1.265 / MC 1.21.1 client srg / brigadier / datafixerupper / mergetool-api / FML loader / event bus；
- 缺依赖时脚本明确报错，不会改游戏目录。

### 9.2 升级

1. 改 `DevToolsMod` 版本、`neoforge.mods.toml`；
2. 跑 `-TestOnly` 与完整构建；
3. 检查 `build-info.json`：`prodJar.portalClasses=false`、`tests.failed=0`；
4. 需要实机时由 Lead 授权后人工替换 jar、人工重启；
5. 更新 README/MAINTENANCE/TESTPLAN 和证据。

### 9.3 回滚

- 停服后删除 mods 里的 `numen-devtools-*.jar`，重启；
- 或将 `config/numen-devtools.json` 的 `enabled` 改回 `false`（下一次启动不监听）；
- 不删除审计/`gm.jsonl` 作为回滚手段；
- 回滚不需要改 `src/` 或树。

## 10. 实机验证（需 Lead 授权）

前置：

- [ ] Lead 明确授权“安装 + 重启 + 在测试世界执行一条 `tp`”；
- [ ] 确认当前世界名 = `allowedWorlds`（默认 `numen-test`）；
- [ ] 确认不是生产世界、不是验收 run；
- [ ] token 文件已创建且未进仓库；
- [ ] 用户在场，接受一次手动重启（**不静默重启**）。

验证步骤（授权后）：

1. 复制 **dev** jar 到 `.minecraft/versions/1.21.1-NeoForge/mods`；
2. 启动游戏/服务器，日志搜 `[numen_devtools]`，应看到 `listening on http://127.0.0.1:8770`；
3. `GET http://127.0.0.1:8770/health` → `ok=true`；
4. `POST /dev/v1/command`，先发一条无副作用命令（如 `time query daytime`——不在白名单，改用 `time set day` 会改世界；建议 `execute if entity @s run time query daytime` 也被 root 限制，实际用 `time set day` 需接受改时间）；
   - 最小实机验证建议：`tp @s <安全点>`，并在 `gm.jsonl` 标记 `assisted`；
5. 检查 `logs/numen-devtools-audit.jsonl` 有 `decision=allowed`、`world=numen-test`；
6. 检查拒绝样本：`stop` → 403 `forbidden_root`，且世界未受影响；
7. 记录证据到 `logs/gm-real-verification.json`（本轮不创建）。

回滚：停服删 jar / `enabled=false`，再启动。

## 11. 故障处理

| 现象 | 检查 | 处理 |
|---|---|---|
| 8770 不监听 | 配置 `enabled`；日志 `[numen_devtools]` | 改配置后需重启；看 startup audit |
| 日志 `disabled` | `config/numen-devtools.json` | 授权后才改 true |
| `token_unavailable` | token 路径/长度/空白 | 重新生成，>=32 字符 |
| `portal_not_packaged` | 是否误装 prod jar | 换 dev jar 或接受空闲 |
| 401 | token 是否一致、Bearer 格式 | 重新读取 token，不要打印到聊天 |
| 403 `world_not_allowed` | 实际世界名 vs allowedWorlds | 改配置或换测试世界 |
| 403 `forbidden_root` | 命令 root | 换允许的 root；不要扩大白名单除非 Lead 批准 |
| 429 | 频率 | 等窗口；不要提高上限绕过测试 |
| 504 | 服务器卡顿/命令阻塞 | 看服务器日志；不要自动重试轰炸 |
| `command_failed` | selector/语法/权限 | 先用服务器控制台验证同一条命令 |
| 审计文件增长 | 长期 dev | 轮转/归档由运维做；不要删当前审计 |

## 12. 已知限制

- `output` 恒空（`withSuppressedOutput`）；只有 `result`；
- dispatcher 回调未触发时按 `command_failed` 处理（实机需确认所有目标命令都会回调）；
- 频率限制是进程内滑动窗口，重启清零；
- 单 token；无热轮换；
- 世界名来自 `WorldData.getLevelName()`；集成服务器/专用服务器命名需实机核对；
- 配置只读一次（ServerStarted），改配置需重启；
- 无并发上限（只有每分钟数）；
- GMProvider 未接入 `run.mjs`，需要显式调用；
- 生产构建通过“缺类 + 反射失败”实现不打包监听，不是签名/发布流程。

## 13. 变更日志

- 2026-11-10：0.1.0。mod + GMProvider + 42 Java/18 Node mock 测试 + dev/prod jar + 文档；未安装、未重启。

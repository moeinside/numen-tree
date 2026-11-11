# Pilot GMProvider（dev-only，8770）

> 2026-11-10。对应 docs/85、docs/90 §1A、docs/84 §4。
> 状态：`tools/pilot/gm-provider.mjs` 已实现并通过 18 项 mock HTTP 自测；**8770 未监听、mod 未安装、游戏未重启、未对真实世界发过命令**。实机使用需 Lead 授权。

## 1. 定位

GMProvider 是 Pilot 侧的**薄客户端**：

```text
GMProvider
  -> POST http://127.0.0.1:8770/dev/v1/command
    -> numen_devtools
      -> Minecraft command dispatcher（permission 4）
```

它不做以下事：

- 不启动/停止/重启/杀游戏；
- 不安装 mod；
- 不绕过 mod 的白名单/世界/频率；
- 不把 GM 当验收/学习正样本；
- 不自动“卡住就 TP”。

## 2. 硬性请求字段

每次调用**必须**带：

```js
{
  runId: "pilot-2026-11-10-a",       // [A-Za-z0-9][A-Za-z0-9._:-]{0,95}
  command: "tp @s 128.66 67 183.3",  // 无前导斜杠也可，portal 会规范化
  reason: "stuck_water",             // 必填，<=300 字符
  selfChallenge: [                    // 非空数组，<=8 项，每项 <=300 字符
    "真的无解吗？有没有非 GM 方案？",
    "最小 GM 操作是什么？",
    "会不会让本次测试失效？如何标记？",
    "操作后如何验证/回滚？",
    "是否只需一次？"
  ]
}
```

缺少任一项时 GMProvider **本地拒绝**，不会发 HTTP。

可选：`before` / `after`（调用方采集的前后态），仅写入 `gm.jsonl`，不发给 mod。

## 3. 用法

```js
import { createGMProvider } from './tools/pilot/gm-provider.mjs';

const gm = createGMProvider({
  baseUrl: 'http://127.0.0.1:8770',       // 默认值；只允许 loopback
  token: process.env.NUMEN_GM_TOKEN,      // 或 GM_TOKEN；不要写死
  timeoutMs: 5000,
  journalPath: 'runs/<runId>/gm.jsonl',   // 可选
});

const before = { hp: 5, pos: [79.5, 63.0, 115.6] };
const r = await gm.command({
  runId: 'pilot-2026-11-10-a',
  command: 'tp @s 128.66 67 183.3',
  reason: 'stuck_water',
  selfChallenge: ['真的无解吗', '最小操作是tp', '会标记assisted'],
  before,
  after: { hp: 5, pos: [128.66, 67, 183.3] },
});

if (!r.ok) {
  console.error(r.error.code, r.error.message, r.httpStatus);
} else {
  // r.result / r.output / r.world
  // run 必须标记 assisted/gm；GM 结果不进验收/学习
}
```

健康检查（不发送命令）：

```js
const h = await gm.health();
// {ok:true, mod:'numen_devtools', version:'0.1.0', portal:'dev', httpStatus:200}
```

从环境变量创建：

```js
import { createGMProviderFromEnv } from './tools/pilot/gm-provider.mjs';
const gm = createGMProviderFromEnv({ journalPath: 'runs/<runId>/gm.jsonl' });
```

环境变量：

| 变量 | 说明 |
|---|---|
| `NUMEN_GM_TOKEN` / `GM_TOKEN` | Bearer token；不写仓库/日志 |
| `GM_BASE_URL` | 默认 `http://127.0.0.1:8770`；非 loopback 默认拒绝 |

## 4. 结构化失败

所有失败都返回 `{ok:false,error:{code,message,...}}`，**不抛 HTTP 异常**：

| code | 来源 | 处理 |
|---|---|---|
| `invalid_run_id` / `invalid_command` / `invalid_reason` / `invalid_self_challenge` | 本地校验 | 修请求；不要重试同一坏请求 |
| `missing_token` | 本地 | 配置 token |
| `network_error` | fetch/读取失败 | 确认游戏已启动、8770 监听、token 文件正确 |
| `timeout` | 本地超时 | 查服务器是否卡顿；不要连续轰炸 |
| `unauthorized` | portal 401 | token 不一致 |
| `forbidden_root` / `root_not_allowed` / `execute_*` | portal 403 | 换命令；不要为绕过改白名单 |
| `world_not_allowed` | portal 403 | 换测试世界或改配置（需 Lead） |
| `rate_limited` | portal 429 | 等 `retryAfter` |
| `command_failed` | portal 200 + `ok=false` | selector/语法/权限；先用服务器控制台验证 |
| `server_not_ready` / `timeout` / `execution_failed` | portal 503/504/500 | 查服务器日志 |
| `invalid_response` | 200 非 JSON | 对端不是 devtools/版本不匹配 |
| `http_<status>` | 其他非 2xx 且无错误体 | 看 raw |

> `httpStatus` 保留在返回对象上；429 还带 `retryAfter`。

## 5. gm.jsonl

传入 `journalPath` 时，每次调用追加一行：

```json
{
  "ts": "2026-11-10T...",
  "schema": "numen-gm/1",
  "source": "gm-provider",
  "assisted": true,
  "runId": "...",
  "reason": "stuck_water",
  "selfChallenge": ["..."],
  "command": "tp @s ...",
  "before": {...},
  "after": {...},
  "outcome": {"ok": true, "result": 1, "world": "numen-test"}
}
```

- 写入失败不会把成功变失败，但会返回 `journalError`，必须当异常处理；
- **不写 token**；
- GM run 仍应在 manifest/report 标 `assisted/gm`，且不作验收/学习正样本。

## 6. 安全

- provider 默认拒绝非 loopback `baseUrl`（防止误连远程/公网）；
- 只调用 `/dev/v1/command` / `/health`，没有“任意 URL”参数；
- 不读/不打印 token；
- 不修改世界前先自问并记录 `selfChallenge`；
- 一次只发一条命令；失败不要自动重试成高频轰炸；
- 测试永远用 mock server（见 §7），不碰真实 8770。

## 7. 自测（mock，不接游戏）

```powershell
cd E:\game\HMCL\numen-tree
node tools\pilot\gm-provider-selftest.mjs
```

- 启动临时 `127.0.0.1` mock server（随机端口，断言不是 8770），测完关闭；
- 18 项：必填字段、401/403/429、超时、网络错误、`command_failed`、非 JSON、gm.jsonl、loopback 限制、health、构建产物；
- 合并 Java 42 项证据，写 `logs/gm-portal-selftest.json`；
- 证据里 `safety.realGameContacted=false`、`port8770Contacted=false`。

如果 Java 证据缺失，合并结果为 `passed=false`（`java.present=false`）——先跑 `devtools/build.ps1`，不要跳过。

## 8. 实机使用授权（未完成）

本轮**未安装、未重启、未调用真实 8770**。要对真实游戏用 GM：

1. 由 Lead 明确授权安装 + 重启 + 在测试世界执行命令；
2. 按 `devtools/README.md` 配 `config/numen-devtools.json` 与 token；
3. 用户手动重启游戏（**不静默重启、不 taskkill**）；
4. 先 `health`，再发一条最小、可回滚的命令（如 `tp` 到安全点）；
5. 写 `gm.jsonl`（含 before/after、`assisted:true`），并记录到 run manifest；
6. 记录实机证据；GM 结果不进验收/学习。

## 9. 已知限制 / 待办

- 未自动接入 `run.mjs`；需要显式调用（是否接入由 Lead 决定）；
- `output` 目前为空数组（mod 侧 suppressed output），只有 `result`；
- `before`/`after` 由调用方提供，provider 不自动观测；
- token 轮换需改文件 + 重启 mod；
- 没有“GM 预算/次数”硬限制（只有 portal 侧每分钟 10 条）；接入 harness 时应加 run 级上限。

## 10. 关联

- [`devtools/README.md`](../../devtools/README.md)：构建、配置、API、白名单；
- [`devtools/MAINTENANCE.md`](../../devtools/MAINTENANCE.md)：架构、错误码、实机授权；
- [`devtools/TESTPLAN.md`](../../devtools/TESTPLAN.md)：J1–J42、N1–N18、RP1–RP6。

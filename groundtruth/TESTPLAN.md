# DevTools / GM portal 验收与测试计划

> 2026-11-10，0.1.0。
> 范围：docs/90 §1A 与 §4（GM mod / GMProvider 的本地可验证部分）。
> **本轮不包含实机验收**：未安装、未重启、未对真实世界发命令。

## 1. 验收映射

| docs/90 验收项 | 本计划 | 本轮结果 |
|---|---|---|
| GM mod：allowlist | J1–J6、J33 | PASS |
| GM mod：execute 递归 | J3、J4、J7–J10、J18、J34、J36 | PASS |
| GM mod：禁命令 | J5、J9、J33、J34 | PASS |
| GM mod：token | J19–J21、J29、J30 | PASS |
| GM mod：world | J17、J37 | PASS |
| GM mod：rate | J22、J42 | PASS |
| GM mod：audit | J23、J41 | PASS |
| GM mod：生产构建不含监听 | N18 + `build-info.json` + jar 列表 | PASS |
| GMProvider：缺 runId/reason/selfChallenge 即拒 | N2–N4、N17 | PASS |
| GMProvider：结构化失败 | N6–N12 | PASS |
| GMProvider：GM 前后态/assisted 记录 | N13 | PASS |
| 实机 `/tp` | RP1–RP6（待授权） | **未执行** |

## 2. 运行命令

```powershell
cd E:\game\HMCL\numen-tree

# Java 42 项（无游戏进程）
powershell -NoProfile -ExecutionPolicy Bypass -File .\devtools\build.ps1 -TestOnly

# 完整构建（同时跑 Java 测试并产出 dev/prod jar）
powershell -NoProfile -ExecutionPolicy Bypass -File .\devtools\build.ps1

# Node 18 项（mock HTTP）+ 合并证据
node tools\pilot\gm-provider-selftest.mjs
```

证据：

- `devtools/build/selftest.json`：Java 42 项；
- `devtools/build/build-info.json`：jar / SHA-256 / portal 类 / 测试计数；
- `logs/gm-portal-selftest.json`：合并结果（`passed` 需 Java + Node 都通过）。

## 3. Java 用例（J1–J42）

### 3.1 策略 / token / rate / audit / config

| ID | 用例 | 期望 |
|---|---|---|
| J1 | 简单 `tp` | 允许，root=`tp` |
| J2 | 全部允许 root | 11 个 root 均允许 |
| J3 | `execute ... run tp` | 允许，roots=`execute,tp` |
| J4 | 嵌套 `execute ... run execute ... run tp` | 允许，roots 记录全部 |
| J5 | 12 个禁 root | 全部 `forbidden_root` |
| J6 | 未知 root（`say`） | `root_not_allowed` |
| J7 | `execute` 无 `run` | `execute_without_run` |
| J8 | `execute ... run` 空子命令 | `execute_without_run` |
| J9 | `execute ... run stop` | `forbidden_root` |
| J10 | 嵌套子命令 `say` | `root_not_allowed` |
| J11 | 前导 `/` | 规范化去掉 |
| J12 | 超长命令 | `command_too_long` |
| J13 | 换行注入 | `bad_characters` |
| J14 | 未闭合引号 | `invalid_syntax` |
| J15 | 引号内空格参数 | 允许 |
| J16 | 引号包裹 root | `invalid_syntax` |
| J17 | 世界白名单 | 大小写不敏感；空/其他拒绝 |
| J18 | 9 层 execute | `execute_too_deep` |
| J19 | token 精确比较 | 对/错/空/null |
| J20 | 弱 token | <32 或含空白拒绝 |
| J21 | token 文件加载/脱敏 | 正常加载；`toString` 不含 secret |
| J22 | rate 3/min | 第 4 次拒绝，窗口后恢复 |
| J23 | audit JSONL | 可解析、含 ts/schema、不含 token |
| J24 | 默认配置 | `enabled=false`、`numen-test`、校验通过 |
| J25 | 首次加载 | 写默认文件；无 token 内容 |
| J26 | 不安全 bind/空世界 | 校验报错 |

### 3.2 Mock HTTP（`PortalCore` + fake sink）

| ID | 用例 | 期望 |
|---|---|---|
| J27 | `GET /health` 无 token | 200，`mod=numen_groundtruth` |
| J28 | `PUT /dev/v1/command` | 405 + `Allow: POST` |
| J29 | 无 token | 401，sink 不调用 |
| J30 | 错 token | 401 |
| J31 | 非法 JSON | 400 `invalid_json` |
| J32 | 缺 runId/reason/selfChallenge | 400 `invalid_*` |
| J33 | `stop` | 403 `forbidden_root`，sink 不调用 |
| J34 | `execute ... run stop` | 403 |
| J35 | 允许命令 + 前导 `/` | 200，sink 收到规范化命令 |
| J36 | 递归 execute | 200 |
| J37 | 世界不在白名单 | 403 `world_not_allowed` |
| J38 | dispatcher 拒绝 | 200 + `ok=false` + `command_failed` |
| J39 | `text/plain` | 415 |
| J40 | body 超限 | 413 |
| J41 | 审计 | 同时有 allowed/denied，且无 token |
| J42 | 2/min | 第 3 次 429 + `Retry-After` |

## 4. Node / GMProvider 用例（N1–N18）

| ID | 用例 | 期望 |
|---|---|---|
| N1 | 合法命令 | 200；POST body 含 runId/reason/selfChallenge/command；Bearer 正确 |
| N2 | 缺 runId | 本地拒绝，零 HTTP |
| N3 | 缺 reason | 本地拒绝 |
| N4 | 空 selfChallenge | 本地拒绝 |
| N5 | 无 token | `missing_token`，零 HTTP |
| N6 | 401 | 结构化 `unauthorized` |
| N7 | 403 | 保留 `forbidden_root` |
| N8 | 429 | 保留 `rate_limited` + `Retry-After` |
| N9 | 超时 | `timeout` |
| N10 | 连接失败 | `network_error` |
| N11 | 200 + `ok=false` | 保留 `command_failed` |
| N12 | 非 JSON 成功体 | `invalid_response` |
| N13 | `gm.jsonl` | `assisted=true`、selfChallenge、before/after、无 token |
| N14 | 非 loopback baseUrl | 默认拒绝构造 |
| N15 | health | ok |
| N16 | 超长命令 | 本地 `invalid_command` |
| N17 | selfChallenge 非数组 | 本地 `invalid_self_challenge` |
| N18 | 构建产物 | dev/prod jar 存在、SHA 匹配、prod 无 portal 类 |

## 5. 负样本重点

- `stop` / `reload` / `op` / `deop` / `ban` / `whitelist` / `gamerule` / `difficulty` / `peaceful` / `kill` / `clear` / `data`；
- `execute as @s run stop`；
- 不存在的 root；
- 换行/控制字符/未闭合引号/超长；
- 错误/缺失 token；
- 非测试世界；
- 超频；
- 超大 body / 错误 Content-Type / 错误方法；
- 生产 jar 中尝试启用 portal。

## 6. 证据判读

`logs/gm-portal-selftest.json`：

```json
{
  "passed": true,
  "counts": {"node": {"total": 18, "failed": 0}, "java": {"total": 42, "failed": 0}},
  "safety": {
    "realGameContacted": false,
    "realWorldCommandsSent": false,
    "installedIntoGame": false,
    "gameRestarted": false,
    "port8770Contacted": false
  }
}
```

若 `passed=false`：先看 `node.cases` / `java.cases` 的 `ok:false` 与 `detail`；不要通过跳过 Java 证据来“修绿”。

## 7. 实机待验（RP，需 Lead 授权，本轮未执行）

| ID | 步骤 | 期望 |
|---|---|---|
| RP1 | 安装 dev jar + 人工重启 | 日志出现 `[numen_groundtruth] ... listening` |
| RP2 | `GET /health` | `ok=true` |
| RP3 | 测试世界执行一次安全 `tp` | 200，`result>=1`，世界名匹配 |
| RP4 | 执行 `stop` | 403 `forbidden_root`，服务器未停 |
| RP5 | 审计 | 有 `allowed`/`denied`，无 token |
| RP6 | 删除 jar/关闭 enabled + 重启 | 8770 不再监听 |

前置条件与回滚见 `devtools/MAINTENANCE.md` §10。

## 8. 本轮结论

- Java：42/42 PASS；
- Node：18/18 PASS；
- dev jar 与 prod jar 构建成功；prod jar 已验证不含 `numentree/groundtruth/portal`；
- 未安装、未重启、未接触真实世界；RP1–RP6 待授权。

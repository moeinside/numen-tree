# 85. GM 通道：dev-only 命令入口（薄 portal）

> 2026-11-10 修订。  
> 不再重写 tp/give/time 等作弊功能；mod 只提供一个受控入口，调用 Minecraft 现成命令系统。

## 1. 核心

```text
numen-devtools（或 tentacle dev 子模块）
  只做一件事：
  把开发工具发来的“游戏内命令”交给 server command dispatcher
```

这样：

- 不用自己实现 tp/give/time/setblock；
- 直接复用原版/模组全部命令；
- 只需做：鉴权、白名单、审计、频率限制、世界限制。

## 2. API

```http
POST /dev/v1/command
Authorization: Bearer <token>
Content-Type: application/json

{
  "runId": "pilot-...",
  "command": "execute as @e[name=bigwhale,limit=1] at @s run tp @s 128.66 67 183.3",
  "reason": "stuck_water",
  "selfChallenge": ["真的无解吗", "最小操作是tp", "会标记assisted"]
}
```

返回：

```json
{"ok":true,"result":1,"output":["Teleported bigwhale to ..."]}
```

## 3. 执行方式

- 只绑 `127.0.0.1:8770`；
- 仅 dev 配置启用；
- token；
- 服务器线程执行：

```text
server.execute(() -> {
  CommandSourceStack source = server.createCommandSourceStack()
      .withPermission(4)
      .withSuppressedOutput();
  int result = server.getCommands().performPrefixedCommand(source, command);
});
```

- 需要实体上下文时，命令自己用 `execute as ... at @s run ...`；
- 不提供“把命令源伪装成同伴”的隐式行为，避免歧义。

## 4. 白名单（必须）

虽然命令是字符串，但**不允许任意 root**。

允许 root：

```text
tp give time weather setblock fill summon effect gamemode xp execute
```

`execute` 必须递归检查子命令的 root，只允许上述集合。

禁止：

```text
stop reload op deop ban whitelist
gamerule difficulty peaceful
kill clear data
```

理由：

- `stop/reload` 会杀服/打断在途 Lua；
- `gamerule/difficulty/peaceful` 会伪造夜间/生存验收；
- `kill/clear/data` 破坏性过大；
- `op/deop/ban` 权限面失控。

## 5. 安全

- 只允许测试世界（`allowedWorlds=["numen-test"]`）；
- 每分钟最多 N 条（默认 10）；
- 命令长度上限（如 512）；
- 请求体上限；
- 所有调用写 `logs/numen-devtools-audit.jsonl`；
- 开发工具侧再写 `gm.jsonl`（含自问/前后态）；
- 生产构建不打包，或 config 强制 off。

## 6. 开发工具侧

```text
GMProvider
  → POST 8770 /dev/v1/command
    → dev mod
      → server command dispatcher
```

约束：

- 只在 dev 模式；
- 每次必须带 runId/reason/selfChallenge；
- 执行前后记录状态；
- run 标 `assisted/gm`；
- GM 不作验收/学习正样本；
- 每次 GM 前自问，禁止“卡住就 TP”。

## 7. 与类型化 op 的关系

- **不做**类型化 op（那是重复实现）；
- 只做“命令 portal + 白名单”；
- 如果将来某类操作需要更严格参数校验，再对那个 root 加专用校验；
- 默认先用原版命令语义。

## 8. 最小 MVP

1. 8770 + token + loopback；
2. `POST /dev/v1/command`；
3. root 白名单 + `execute` 递归检查；
4. `allowedWorlds` + 频率限制；
5. 审计日志；
6. Pilot `GMProvider` 调用；
7. 重启游戏加载一次 mod。

## 9. 一句话

> **GM 入口不是“重写作弊”，而是“给开发工具一个受控的 /command 入口”：复用原版命令，只做鉴权、白名单、审计和频率限制。**

# mods/ —— 必需补丁：numenlockfix

> 以下说明由大肥鲸自动生成，可能与实际行为有出入，一切以源码为准。

本目录只放**一个必需文件**：

```
mods/numenlockfix-1.1.0.jar
```

它修的 bug 不是本项目的 bug，是 **numen 自己的**：同伴的程序锁会永久残留，导致同伴再也不听指挥。没有这个补丁，numen-tree 在"切存档 / 树被杀 / 同伴死亡"之后就会大面积失效。

---

## 1. 修的是什么问题

numen 用一张 JVM 静态表记录每个同伴当前跑的程序：

```java
// com.dwinovo.numen.program.ServerPrograms
private static final Map<UUID, ServerPrograms.Running> RUNNING;
```

静态字段活到 JVM 进程结束。只要某个程序没正常收尾，该同伴的 UUID 就永远留在表里，之后所有 Lua 调用都被拒绝：

```
a program is already running for this companion, or its built-in brain is acting
```

**会留锁的场景**：切存档/重进世界、客户端死在调用途中（树被杀、等回执超时）、同伴死亡打断在途调用。

## 2. 补丁做了什么（v1.1.0）

| # | 能力 |
|---|---|
| 1 | 服务器启动时清空整张表 |
| 2 | 同伴死亡时延迟 1 tick 清掉该 UUID |
| 3 | `/numenlockfix` 指令（权限 2）手动清空 |
| 4 | 本地控制端口 `127.0.0.1:8768`：`GET /status`、`POST /unlock?uuid=...`、`POST /unlock?all=1` |

端口可用 JVM 参数改：`-Dnumenlockfix.port=8768`。它只绑回环地址，不做鉴权，仅本机用。

**不改 numen 本体**：独立的 jar，删掉即完全回滚。

---

## 3. 安装

### 3.1 确认版本

| 项 | 要求 |
|---|---|
| Minecraft | 1.21.1 |
| NeoForge | 21.1.233 或更高（实测 21.1.265） |
| numen | 0.1.4.1（补丁只依赖它的 `ServerPrograms` 类，通过反射找；找不到会在日志里说明） |

### 3.2 放到 mods 目录

HMCL 开了版本隔离时，mods 目录在**版本目录下**，不是 `.minecraft\mods`：

```
E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\mods\numenlockfix-1.1.0.jar
```

```powershell
$mods = 'E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\mods'
Copy-Item 'E:\game\HMCL\numen-tree\mods\numenlockfix-1.1.0.jar' $mods
```

> ⚠️ **必须重启 Minecraft**：mod 只在 JVM 启动时加载，换 jar 不重启不生效。
> 升级时先删旧版（同 `modId` 同时存在会冲突），再放新版。

### 3.3 确认生效

1. 重启游戏进存档，看日志里有没有：
   ```
   [numenlockfix] v1.1.0 加载：目标=com.dwinovo.numen.program.ServerPrograms，外部清锁端口=127.0.0.1:8768
   [numenlockfix] 反射成功：loader=...
   [numenlockfix] server started: foundClass=true RUNNING=0
   ```
   `foundClass=false` 说明没找到 numen 的类，看日志里每个类加载器的尝试链。
2. 树侧查状态：
   ```powershell
   cd E:\game\HMCL\numen-tree
   node src/cli.mjs lock
   # 期望：{"patch":"1.1.0","foundClass":true,...}
   ```
3. 终极验收：故意制造一次锁（杀树、切存档），树连续 2 次被拒后会自动清锁，同伴不用重建。

## 4. 卸载

删掉 `mods\numenlockfix-1.1.0.jar`，重启游戏，即回到原生 numen。若此时树仍在运行，把 `tree.config.json` 里 `behavior.lockRecovery.enabled` 改成 `false`，否则它会一直尝试连一个不存在的端口。

## 5. 从源码重新构建（可选）

只有在你要改 Java 代码时才需要，日常直接用本目录的 jar。

```powershell
cd E:\game\HMCL\numen-tree\patcher
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
# 产物：patcher\build\numenlockfix-1.1.0.jar，复制到 mods/ 和游戏 mods 目录
```

依赖 JDK 21+ 和本机 NeoForge 1.21.1 库（构建脚本会自动找）。原理、反射细节、风险清单见 [../patcher/README.md](../patcher/README.md)。

---

## 6. 风险

- 只做三件事：清空静态 `RUNNING` 表 / 删除指定 UUID 条目 / 调 numen 的 `cutOff` 取消程序。
- `POST /unlock?all=1` 会 cancel 当前正在跑的动作，别在正常执行时用。
- 最坏情况（游戏起不来）：删掉 jar 即可恢复原状，不会损坏存档。

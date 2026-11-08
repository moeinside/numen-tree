# Windows PowerShell 踩坑总表（本机实测）

> 用途：在这台机器上用 PowerShell 驱动 `node`、读写文件、读游戏日志、调控制 API / MCP 时，
> 踩过的坑和**正确写法**。新会话先扫一眼，少浪费半小时。
> 环境：Windows + **Windows PowerShell 5.1**（`powershell.exe`，不是 pwsh 7）+ Node 24。
> 项目相关命令速查放在最后。

---

## 0. 三句话原则

1. **能交给 node 做的，就不要用 PowerShell 拼字符串**：传 JSON、写文件、读日志、发 HTTP，一律走项目里的小脚本（`probe/mcp.mjs`、`probe/tree-api.mjs`、`node -e`）。
2. **任何"中文 + 文件写入"都不要用 `Set-Content` / `Copy-Item` / `>`**：用编辑工具，或 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`。
3. **原生程序的参数用 `Start-Process -ArgumentList @(...)` 数组传**，别让 PowerShell 重新解析。

---

## 1. 传参 / JSON

### 1.1 把 JSON 当参数传给 node：引号会被吃

```powershell
# ❌ 实际跑到进程里变成 fetch(http://...)，JSON.parse 直接炸
node -e 'fetch("http://127.0.0.1:8766/task",{...})'

# ❌ probe/mcp.mjs call 的 JSON 参数同样会被吃
node probe/mcp.mjs call lua '{"companion":"tyrander","code":"return 1+1"}'
```

**正确**：写参数文件 + `callfile`，或者用项目里的小脚本：
```powershell
# 1) 用编辑工具写 probe\args-xxx.json（UTF-8 无 BOM）
# 2) 调
node probe/mcp.mjs callfile lua probe\args-lua-probe.json
node probe/tree-api.mjs /task probe\args-task-stockwood.json   # 控制 API
```

### 1.2 原生程序的 `-D...` / `-J-Duser...` 参数被拆坏

```powershell
# ❌ 报"无效的标记: .language=en"
& javac.exe -J-Duser.language=en ...
```

**正确**：
```powershell
$args = @('-J-Duser.language=en', '-encoding', 'UTF-8', '-cp', $CP, '-d', $Out) + $sources
Start-Process -FilePath $JAVAC -ArgumentList $args -Wait -PassThru -NoNewWindow
```

### 1.3 `ConvertTo-Json` 默认只序列化 2 层

```powershell
# ❌ 嵌套超过 2 层直接丢字段
$body = @{ params = @{ a = @{ b = 1 } } } | ConvertTo-Json
# ✅
$body = @{ params = @{ a = @{ b = 1 } } } | ConvertTo-Json -Depth 10 -Compress
```

### 1.4 `Invoke-WebRequest -Body` 发中文：编码

默认编码不保证 UTF-8，中文参数可能乱码或被服务端拒。

```powershell
$json = @{ companion='tyrander'; intent='把木头存了' } | ConvertTo-Json -Compress -Depth 10
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:8766/task `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
```

更省事：用 node 发（`probe/tree-api.mjs`），完全绕开编码问题。

---

## 2. 文件读写 / 编码

### 2.1 `Set-Content` / `>` / `Copy-Item` 会加 BOM

症状：node 读 JSON 报 `Unexpected token '﻿', "﻿{"compani"... is not valid JSON`。

```powershell
# ❌ BOM 或 ANSI
Get-Content a.json | Set-Content b.json
'...' > a.json

# ✅ 工具（推荐）：write/edit
# ✅ 必须用 PowerShell 时：
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

### 2.2 读 UTF-8 中文文件：`Get-Content` 默认编码

```powershell
# 显示乱码（"澶辫触"=GBK 解 UTF-8）
Get-Content logs\trace.jsonl

# ✅ 读 UTF-8
Get-Content logs\trace.jsonl -Encoding UTF8
Get-Content logs\trace.jsonl -Tail 20 -Encoding UTF8
```

### 2.3 读"别的程序吐出来的 GBK/控制台编码"输出

例如 javac 的中文报错：

```powershell
# ❌ Get-Content -Encoding 只接受枚举名，传 Encoding 对象会报参数绑定错
Get-Content build\log.txt -Encoding ([System.Text.Encoding]::GetEncoding(936))

# ✅
[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::GetEncoding(936))
```

### 2.4 `2>&1` 会把 stderr 混进 stdout，解析 JSON 必炸

node 的 `[server] ...` 走 stderr、PowerShell 的 `CategoryInfo` 也会混进来。

```powershell
# ❌ 输出里夹着 CategoryInfo/所在位置，JSON 解析失败
node probe/mcp.mjs call lua ... 2>&1 | ConvertFrom-Json

# ✅ 过滤已知噪音行
node probe/mcp.mjs call list_companions 2>&1 |
  Select-String -NotMatch 'CategoryInfo|FullyQualified|所在位置|^\+|^\[server\]'
```

### 2.5 用 PowerShell 5.1 跑 `.ps1`：文件按 ANSI 解码

Windows PowerShell 5.1 **默认按 ANSI 读脚本文件**。UTF-8 无 BOM 的中文注释可能把后面的解析带歪（本机实际表现：`$CP` 变量莫名失效，javac 报"程序包 net.minecraft.commands 不存在"）。

**规则**：`.ps1` 要么 **ASCII-only**，要么保存为 **UTF-8 with BOM**。项目里的 `patcher/build.ps1` 已改成 ASCII-only。

### 2.6 用 node 改/校验文本更稳

```powershell
node --check src\lane.mjs
node -e "JSON.parse(require('fs').readFileSync('tree.config.json','utf8'));console.log('ok')"
```

---

## 3. 输出 / 显示

### 3.1 `Format-Table -AutoSize` 截断长字段

`note`、`message`、JSON 长行会被截成 `...`，看起来像"字段丢了"。

```powershell
# ✅ 单条看细节
... | Format-List
# ✅ 或者直接丢给 node 的 JSON.parse 处理
```

### 3.2 `Select-Object -First N` 截断 JSON 文本

`tree_status` / `tree_task` 返回的是**一整个 JSON 文本**，`-First` 只拿到前 N 行 → 解析失败。要么全量 `Out-String`，要么让 node 解析。

### 3.3 `Measure-Command` 会吞输出

`Measure-Command { node ... }` 只返回耗时，命令本身的输出看不到；要计时就把输出重定向到文件再读。

### 3.4 控制台编码（只管显示，不管读文件）

```powershell
chcp 65001            # 当前控制台 UTF-8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
```

---

## 4. 进程 / 端口 / 本项目特有

### 4.1 查端口和进程

```powershell
Get-NetTCPConnection -LocalPort 8765,8766,8767 -State Listen |
  Select-Object LocalPort,OwningProcess
Get-Process node,java | Select-Object Id,StartTime,Responding
```

### 4.2 杀树进程 = 大概率留僵尸锁

```powershell
# ❌ 正在飞 lua 调用时 taskkill → 游戏侧程序没人收结果 → 槽位永久占用
taskkill /F /PID <node pid>

# ✅ 优雅退出（先停派发，等在途动作收敛）
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:8766/control `
  -ContentType 'application/json' -Body '{"op":"exit"}'
node src/cli.mjs control --op exit
```

⚠️ **优雅退出也不是万无一失**：如果退出那一刻某个技能已经 detach 出后台任务（`move.go` 还在跑），
程序侧仍可能留锁。实测 2026-11-07 22:36：tyrander 正在 `go_to`（detached move.go）时 exit，
helper 的槽空了、tyrander 的锁了。兜底：`delete_companion` + `create_companion` 重建（10 秒）。

### 4.3 脚本里 `$env:XXX` 只在本进程生效

```powershell
# 同一条命令里设置并调用（每次 pwsh 调用都是新进程）
$env:MCP_URL='http://127.0.0.1:8767/mcp'; node probe/mcp.mjs tools
```

### 4.4 带空格/中文的路径

```powershell
$jdk = 'C:\Program Files\Microsoft\jdk-25.0.4.7-hotspot\bin'
& (Join-Path $jdk 'javac.exe') @args          # 用变量 + Join-Path，不要手拼引号
```

### 4.5 别给自动变量赋值

`$HOME`、`$PID`、`$args`（脚本参数）等都是只读/自动变量，大小写不敏感。自定义变量换名字。

---

## 5. 本项目标准操作（复制即用）

```powershell
cd E:\game\HMCL\numen-tree

# 状态 / 收件箱
node src/cli.mjs status
node src/cli.mjs inbox --brain

# 下计划任务（中文意图走 args 文件，避免引号问题）
node probe/tree-api.mjs /task probe\args-task-stockwood.json

# 看配方/中断
node probe/tree-api.mjs /recipes
node probe/tree-api.mjs "/task?companion=tyrander"

# 地点簿
node src/cli.mjs place list
node src/cli.mjs place find --query 基地

# 起/停树（停用 exit，不要 taskkill）
node src/daemon.mjs
node src/cli.mjs control --op exit

# 热重载技能卡
node src/cli.mjs control --op reload-skills

# 离线回放测试
node probe/replay.mjs

# 读游戏日志里的 numen 行（UTF-8）
$f='E:\game\HMCL\.minecraft\versions\1.21.1-NeoForge\logs\latest.log'
Select-String -Path $f -Pattern 'numen-program|numenlockfix' | Select-Object -Last 10 |
  ForEach-Object { $_.Line.Substring(0,[Math]::Min(160,$_.Line.Length)) }
```

---

## 6. 一句话速查表

| 症状 | 原因 | 解法 |
|---|---|---|
| `Unexpected token '﻿'` | 文件被写了 BOM | 编辑工具 / `UTF8Encoding($false)` |
| `Expected property name` / JSON 解析失败 | PowerShell 吃了 JSON 引号 | args 文件 + `callfile` / `tree-api.mjs` |
| 中文变"澶辫触" | 按 GBK 读 UTF-8 | `-Encoding UTF8` |
| `-Encoding` 参数绑定失败 | PS5.1 只收枚举名 | `[IO.File]::ReadAllText(...,GetEncoding(936))` |
| `-J-D...` 参数报"无效的标记" | PS 拆分原生参数 | `Start-Process -ArgumentList @(...)` |
| javac 报"程序包 net.minecraft 不存在" | .ps1 被按 ANSI 读、CP 变量没生效 / classpath 缺 jar | .ps1 用 ASCII-only；CP 里加 client-srg + brigadier |
| 输出里夹 `CategoryInfo` | `2>&1` 混流 | `Select-String -NotMatch ...` 过滤 |
| 字段看起来"丢了" | `Format-Table -AutoSize` 截断 | `Format-List` / 交给 node 解析 |
| 树进程被杀后游戏里一直"a program is already running" | 在途 lua 被遗弃 | `control --op exit`；已留锁则重建同伴或 `/numenlockfix` |

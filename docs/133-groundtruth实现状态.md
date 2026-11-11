# 133. groundtruth 实现状态（P1.0 第一片）

> 2026-11-11。观测地基第一片。

## 已实现

```text
modId: numen_groundtruth
默认端口: 8771
默认 disabled
```

### ObserveStore

```text
事件 seq 单调
gameTick / dayTime / frozen / pendingSteps
since(seq, limit)
freeze / step / setDayTime
```

### HTTP

```text
GET  /dev/v1/events?since=&limit=
GET  /dev/v1/clock
POST /dev/v1/clock
GET  /dev/v1/snapshot?seq=
GET  /dev/v1/snapshot/list?limit=
POST /dev/v1/snapshot
GET  /dev/v1/snapshot/diff?from=&to=
GET  /dev/v1/block?x=&y=&z=
GET  /dev/v1/scan?x=&y=&z=&rx=&ry=&rz=
GET  /dev/v1/entities?x=&y=&z=&rx=&ry=&rz=
GET  /dev/v1/light?x=&y=&z=
GET  /dev/v1/manifest?runId=
POST /dev/v1/state
```

快照：

```text
region {x,y,z,rx,ry,rz}
最大 33^3，半径 <=16
存储 block key -> block id
SHA-256 hash
before/after diff
list/retention（最多 64 张）
```

快照闭环：

```text
抓取 → hash → list → diff
```

## 状态

```text
快照层完成
已安装到版本 mods
8771 已真实启动
numen-test 冒烟通过
```

冒烟证据：

```text
logs/groundtruth-smoke.json
health / clock / blockAt / events / snapshot / manifest

logs/groundtruth-clock-smoke.json
真实 freeze/step：
冻结 3s dayTime 不动
step 20 精确 +20
解冻后恢复
```

时钟写入：

```text
runId + reason 必填
写 audit
同时追加事件：
  clock_freeze
  clock_step
  clock_set
```

### 真实事件源

```text
block_break
block_place
entity_join
entity_leave
entity_death
damage
container_open
container_close
item_pickup
```

### 时钟

```text
server tick 推进 observer 时钟
freeze：真实复位 server dayTime（世界时间停住）
step：放行 n 个 server tick 后重新冻结
```

## 验证

```text
53/53 PASS
jar: groundtruth/build/numen-groundtruth-0.1.0.jar
```

新增测试：

```text
O1 事件游标单调、可 replay
O2 时钟冻结/单步
O3 快照 hash 稳定、diff 正确
O4 快照区域上限
O5 RunLedger 标记 Track A 失格
O6 快照列表有界且顺序正确
J43 时钟写入缺 selfChallenge → 400
J44 时钟写入审计、manifest 计数
J45 状态写入缺 selfChallenge → 400
J46 状态写入审计并实际调用 sink
```

## 审计最小集

```text
写操作：token + runId + reason + selfChallenge
audit 先写，失败则拒绝改动
audit.jsonl
RunLedger：
  calls / byKind / clockFrozen / lastCallAt
GET /dev/v1/manifest?runId=
Track A 只要 calls>0 或 clockFrozen=true → 失格
```

## Track A 验收器

```text
node tools/groundtruth-accept.mjs --run-id <id> --from-http
node tools/groundtruth-accept.mjs --run-id <id> --manifest <file>
```

退出码：

```text
0 = track_a_eligible
1 = track_a_ineligible
2 = 工具/网络错误
```

selftest：

```text
3/3 PASS（clean / called / frozen）
```

## 快照回滚

```text
tools/groundtruth-save.mjs snapshot --world <dir> --out <dir>
tools/groundtruth-save.mjs verify --snapshot <dir>
tools/groundtruth-save.mjs restore --snapshot <dir> --world <dir> [--apply]
```

安全规则：

```text
默认 dry-run
apply 前检查 tree 控制端口，活着就拒绝（--no-tree-check 仅测试）
restore 前备份 world 为 .before-restore-*
先整目录替换，失败自动回滚备份
manifest + sha256 校验
```

selftest：

```text
7/7 PASS（snapshot/verify/restore/dry-run/内容/tamper）
```

## 未完成

```text
真实游戏内安装/8771 启动
```

## Track A 流水线

```text
devtool close 会尝试读取 groundtruth manifest
写回 manifest.groundtruth
eligible=false → conclusion 直接判 Track A 失格
缺少 GROUNDTRUTH_TOKEN 时标记 unchecked，不阻塞 close
```

## 状态注入

```text
POST /dev/v1/state
action: set_health / set_food / damage / kill_tag / teleport
runId + reason + selfChallenge 必填
audit 先写，失败不改状态
按 allowedWorlds 限制
```

## 状态

```text
未装进游戏
8771 未启动
写入能力默认 disabled
```

## 下一步

```text
动作前后快照 + 区域 hash/diff
```

然后查询，再接审计最小集。

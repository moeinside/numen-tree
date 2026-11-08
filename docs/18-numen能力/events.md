# 事件清单（numen `get_events`）

> 状态：**待实测补全**。这里是已知项 + 采集方法；实验完成后回填表格。
> 事件通道不占 Lua 槽，是"肾上腺素/报警"最可能的来源。

## 已见事件（来自树 trace 与文档）

| kind | 含义 | payload | 能否触发肾上腺素 |
|---|---|---|---|
| `reflex` | mod 自带反射（如"打不过，跑了"） | 文本说明 | ✅ 强候选（mod 内部已有威胁判断） |
| `hungry` | 饥饿告警 | 饥饿值 | ✅ P0（吃） |
| `death` | 同伴死亡/复活 | 死亡信息 | ✅ P0 |
| `owner_query` | 主人说话 | 文本 | 信息类 |
| `task_finished` / `task_failed` | 任务状态 | taskId/原因 | 观测类 |
| `leash` | 牵引绳触发 | 距离/锚点 | 策略类 |

## 待确认（实验）

- 受击（hurt/damage）事件？
- 血量骤降/threshold 事件？
- 敌对接近（hostile_near）事件？
- 夜间/天气变化事件？
- 主人受伤/死亡事件？
- 方块/物品相关事件（拾取/掉落）？
- 任务卡住/超时事件？

## 采集方法

```js
// 伪代码：用 numen get_events 长轮询 5~10 分钟，记录所有 kind
while (t < end) {
  const r = await numen.callTool('get_events', { companion, wait_seconds: 2 });
  for (const e of parseEvents(r)) record(e.kind, e.payload);
}
```

注意：事件**读后即消耗**，采集时别让树同时在跑（否则抢事件）；开发期可停树、独占采集。

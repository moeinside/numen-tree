# 台词库（utterance library）

树在游戏里说话用的**数据**。这里只放文本，不放逻辑；树运行时只做"查表 + 冷却 + 权重 + 填槽"。

> 语言由人写或离线生成；选择是机械的；对话仍然归 LLM。
> 这条边界不能破，否则树就开始"组织语言"了。

---

## 1. 文件格式

```
lines/
├─ default.json      ← 默认预设（必读）
├─ 团子.json          ← 可选：人设覆盖（同名 id 覆盖 default，新 id 追加）
└─ 小焰.json
```

```json
{
  "persona": "default",
  "entries": [
    {
      "id": "arrived",
      "when": "arrived",
      "text": ["到了", "我回来了", "到啦"],
      "slots": [],
      "cooldownSeconds": 45,
      "weight": 2
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一。人设文件里同 id 会**覆盖**默认条目 |
| `when` | 事件名，见下表 |
| `text` | 字符串或字符串数组（随机挑一条） |
| `slots` | 可插入的槽，写在文本里如 `{dist}` |
| `cooldownSeconds` | 这条多少秒内不重复 |
| `weight` | 同事件下多条候选的权重 |

## 2. 事件名（当前支持）

| `when` | 什么时候 |
|---|---|
| `arrived` | `go_to` 成功到达 |
| `arrived_far` | 预留给"走了很远才到"（还没接） |
| `leash_return` | 牵引绳触发（离主人太远，准备回去） |
| `task_failed` | 技能失败，槽 `{reason}` 是失败原因的中文（过不去/够不着/找不到…） |
| `hungry` | 收到 mod 的饿事件 |
| `fled` | mod 的逃跑反射触发 |
| `death` | 死亡事件 |
| `companion_missing` | 换档后找不到同伴 |
| `task_start` | 计划/任务开始（槽 `{title}`） |
| `tactic_done` | 战术包成功（内容未打磨） |
| `low_hp` | HP ≤6 首次提醒（槽 `{hp}`；回 >10 重新武装） |
| `danger` | 执行档位进入 field-guarded（发现风险） |
| `craft_done` | **预留**：合成/熔炼完成（暂无触发点） |
| `milestone` | **预留**：阶段完成（暂无触发点） |
| `found_new` | **预留**：图鉴发现新物品（默认不接，避免刷屏） |

## 2.1 触发规则（契约）

- 所有触发统一走 `#speak(when, slots)`；**不在这里组织语言**；
- 触发点只报告"事件 + 槽"，文案由 `lines/*.json` 决定；
- 没有对应 `when` 条目时静默（`pick` 返回 null），所以**可以先留接口后补文案**；
- 冷却/权重/最小间隔由 `LineBank` 统一处理（见 §3）；
- 新增触发点的位置约定：计划开始 → `task_start`；战术结束 → `tactic_done`/`task_failed`；威胁/降档 → `danger`；低血 → `low_hp`。

## 3. 运行时规则

1. 全局最小间隔：`tree.config.json` 的 `lines.minGapSeconds`（默认 8 秒）；
2. 单条冷却：`cooldownSeconds`；
3. 同一事件下最近说过的 3 条不再重复（`recentSize`）；
4. 按 `weight` 加权随机；
5. `{slot}` 用事件带来的值填充，找不到就原样保留。

## 4. 怎么切人设

1. 复制 `default.json` → `lines/<人设名>.json`，改成那个人设的语气；
2. 改 `tree.config.json`：

```json
"lines": { "enabled": true, "dir": "lines", "persona": "团子", "minGapSeconds": 8 }
```

3. 重启树。启动日志会显示"台词库: N 条（人设 团子）"。
4. 查看：`node src/cli.mjs lines`

> 目前 `persona` 是**手动指定**的。树的 MVP 不读 numen 的人设文件——自动关联留到后面。

## 5. 刻意没做的部分（以后单独弄）

- **生成/更新管线**：由一个一次性子 agent 读人设文档、产出新台词、校验后落库。
- **人设自动识别**：现在要手动改配置。
- **多语言 / 语气标签**：`tone` 字段还没用上。
- **台词质量评估**：AI 味、重复度、长度分布。
- **事件目录自动扩展**：新技能上线时需要手工加 `when`。

## 6. 已知风险

- **AI 味**：生成器容易写得太完整、太礼貌。建议人写几条当锚点，让生成器模仿。
- **重复感**：一个情境建议 3–5 条，别写通用寒暄。
- **和 LLM 打架**：模板台词只用于机械播报，**不要**用来对话——否则会像两个人说话。

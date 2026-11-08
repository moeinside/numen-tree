# treeview 维护文档（交接用）

> 给"下一个维护者"（子智能体 / 新会话的人）看的。先读本文，再读 `docs/16-实时树图可视化-提案.md`。
> treeview 是**独立只读工具**：它依赖树，树不依赖它。删掉 `tools/treeview/` 不影响树。

---

## 1. 这是什么

3D 实时"树监控"：读取 numen-tree 的行为树定义 + 运行态，渲染整棵树，并实时高亮：
- 当前计划步 / 当前技能（光柱+大环+节点提亮）
- 最近 N 个节点的执行路径（色温：越新越热，N=3~8 可调）
- 失败标记（所有 fail 留红色渐隐标记，节点下次激活才清除）
- 多同伴路径（彩虹色分配）
- 边界端口（tree MCP 8767 / control 8766 / numen MCP 8765）和核心链路（lane/planner/arbiter/executor/observer）

**明确不做**：不控制树/同伴、不发 goal、不改树状态。纯只读。

---

## 2. 目录与文件职责

```
tools/treeview/
  MAINTENANCE.md        # 本文
  README.md             # 快速使用
  server.mjs            # HTTP 服务（8780）：/api/model /api/state /api/trace /api/health + 静态文件
  model.mjs             # 适配层：import 树定义 → 图 JSON（nodes/edges/counts）
  public/index.html     # 页面骨架 + HUD/CSS + importmap
  public/app.mjs        # three.js 渲染、布局、轮询、路径/失败标记、交互
  vendor/three/three.module.js    # three.js r160 自包含单文件（别换成分包版！）
  vendor/three/OrbitControls.js   # three 0.160 examples 控件
```

**分层意图**：
- `model.mjs` 是 **numen-tree adapter**：树特定知识（读哪些文件、字段映射、端口/核心节点常量）都在这。
- `server.mjs` / `public/*` 是**通用 core**：只认"模型 + 状态 + 事件"JSON 契约，不含游戏/树专属逻辑。
- 以后接别的游戏/别的树：复制 core + 新 adapter（实现同样的 model/state 契约），不要改 core 里的这些文件。

---

## 3. 数据来源与时序

```
浏览器(8780) ──1s 轮询──▶ server.mjs /api/state
                             ├─ 动态 import ../../src/*.mjs （model.mjs，/api/model 时）
                             ├─ GET http://127.0.0.1:8766/status （树控制 API，含 modelVersion）
                             └─ 读 ../../logs/trace-*.jsonl 尾部（最近 400 行/512KB）
```

| 数据 | 来源 | 说明 |
|---|---|---|
| 静态结构 | `src/recipes.mjs`、`interrupts.mjs`、`schedule.mjs`、`crafttree.mjs`、`skills/index.mjs` | 动态 import，带 `?tv=timestamp` 破缓存；树 `reload-skills` 后 `modelVersion`+1，前端重新拉 `/api/model` |
| 运行态 | `GET 8766/status` | `companions[].plan/goals/current/lastAction/schedule/paused/slotBlocked/...` |
| 事件 | `logs/trace-*.jsonl`（最新文件尾部） | server 归一化成 `activity`（dispatch/done/fail/plan_step/plan_start/...），前端用它推进路径与失败标记 |
| 模型版本信号 | `status.modelVersion` | 树侧 `daemon.mjs`：`statusPayload()` 字段 + `reload-skills` 时 `modelVersion += 1`（只读，不影响行为） |

**注意**：modelVersion 目前只在 `reload-skills` 时变；如果只改 `tree.config.json`（不 reload），图不会自动刷新——需要重启树或手动 `reload-skills`（配置未热加载时）或刷新页面重拉模型。

---

## 4. JSON 契约（改之前先看这里）

### 4.1 `/api/model`（由 `model.mjs` 生成）

```jsonc
{
  "adapter": "numen-tree",
  "generatedAt": "...",
  "counts": { "recipes":13, "steps":70, "skills":25, "interrupts":8, "schedules":3, "craft":11, "nodes":138, "edges":302 },
  "nodeTypes": ["recipe","step","skill","interrupt","schedule","craft","port","core"],
  "recipes": [ { "id":"...", "title":"...", "source":"auto|llm", "match":[] } ],
  "nodes": [
    { "id":"r:gather_wood", "type":"recipe", "label":"gather_wood", "title":"...", "desc":"...", "recipeId":"gather_wood", "source":"...", "order":0, "steps":7 },
    { "id":"r:gather_wood:step:chop", "type":"step", "label":"chop", "title":"gather_wood / chop", "desc":"技能: mine_nearby · 参数: {...} · onFail: {...}", "recipeId":"gather_wood", "stepIndex":0, "stepsTotal":7, "skill":"mine_nearby", "params":{}, "next":"collect", "onFail":{}, "requires":null },
    { "id":"k:mine_nearby", "type":"skill", "label":"mine_nearby", "title":"...", "desc":"...", "params":{}, "meta":{} },
    { "id":"i:near_death", "type":"interrupt", "label":"near_death", "priority":95, "resume":"resume", "halt":false, ... },
    { "id":"sc:day", "type":"schedule", "label":"day", "order":2, "leash":{}, "allow":{}, "work":[], "guard":null, "patrol":null },
    { "id":"c:minecraft:stick", "type":"craft", "label":"stick", "item":"minecraft:stick", "yields":4, "table":false },
    { "id":"port:tree_mcp", "type":"port", "label":"tree MCP 8767", "title":"LLM 输入口（tree MCP）", "desc":"..." },
    { "id":"core:lane", "type":"core", "label":"lane 主循环", "title":"...", "desc":"..." }
  ],
  "edges": [ { "from":"r:gather_wood:step:chop", "to":"r:gather_wood:step:collect", "type":"next", "label":"next" } ]
}
```

**节点 id 命名（前端按这些前缀找节点，别乱改）**：
`r:<recipeId>`、`r:<recipeId>:step:<as>`、`k:<skillId>`、`i:<interruptId>`、`sc:<scheduleId>`、`c:<item>`、`port:<name>`、`core:<name>`

**边 type**（决定颜色）：`start/step/next/onFail/match/uses/interrupt/interrupt_plan/schedule_work/schedule_skill/craft/plans/exec/interrupt_check/schedule/port_in/port_out/core`

### 4.2 `/api/state`

```jsonc
{ "mode":"live|offline|mock", "ts":"...", "tree":"http://127.0.0.1:8766",
  "modelVersion":1, "traceFile":"trace-20261108.jsonl",
  "status": { /* 8766 /status 原样：{startedAt,modelVersion,numen,companions:[...],inboxSeq} */ },
  "events": [ /* normalizeEvent 后的数组，最多 300 条 */ ] }
```

`events[]` 归一化字段：
```jsonc
{ "t":"ISO", "kind":"dispatch|done|failed|plan_step|plan_start|plan_end|goal_added|auto_action|...",
  "companion":"bigWhale", "level":"info|warn",
  "activity":"dispatch|done|fail|plan_step|plan_start|plan_end|goal_added|auto|interrupt|other",
  "skill":"mine_nearby|null", "goalId":"g1|null",
  "recipeId":"gather_wood|null", "step":"chop|null",
  "ok": true/false/null, "failKind":"no_path|null", "note":"原始 note" }
```

`companions[]` 关键字段（来自树 state.snapshot）：`name/id/pos/hp/hunger/schedule/plan{recipeId,cursor,status,steps_done,steps_total}/goals[]/current{skill}/lastAction{skill,ok}`。

---

## 5. 前端实现要点（`public/app.mjs`）

- **布局**：`layout(model)` 确定性计算一次（不随机、不每帧重排）。配方=半径 36 的环；步骤沿配方射线向外；技能/中断/日程=外圈；合成=下方方阵；端口=左右两端（±132）；核心=中间。
- **渲染**：three.js r160；节点发光 sprite + 类型几何体 + 标签 sprite；边=二次贝塞尔曲线 `Line`。
- **语义缩放**：`applyLabelVisibility()` 按相机距离隐藏步骤/技能等标签（远看整体、近看细节）。
- **路径**：`state.companions: name -> {history[], markers:Map, color, group}`；`processEvents()` 处理归一化事件推进 history/markers；`renderCompanions()` 每次轮询重建每个同伴的 group（先 `clearGroup` 释放 GPU 资源）。
  - 最近 N 个节点：`TubeGeometry` 发光管（半径 0.42~0.55）+ 节点光球 + 大环；当前节点额外光柱/底环/材质提亮（`emissiveIntensity=2.2`、scale 1.35）。
  - 失败标记：`✕ kind ×n` 标签 + 双红环 + 红柱 + 光晕；alpha 下限 0.55；节点再次激活（done/step ok）时 `clearMarker`。
- **事件去重**：`state.lastEventAt` 按同伴记最后事件时间，避免重复处理。
- **模型重建**：`poll()` 发现 `data.modelVersion !== state.modelVersion`（或首次）→ `/api/model?force=1&v=...` → `buildScene()`。
- **错误提示**：`index.html` 里全局 `error`/`unhandledrejection` 会把错误显示在顶部 banner 和加载提示里（不要再让页面白屏无提示）。
- **HUD 布局（别写死偏移）**：顶栏 `.top` 允许换行（窄视口不会被挤压变形）；`app.mjs` 的 `syncHudMetrics()` 用 `ResizeObserver` 把顶栏/图例实际高度写进 CSS 变量 `--top-h` / `--legend-h`，`.left`/`.right` 的 `top`/`bottom` 由它们驱动。**不要再给左右面板写死 `top:56px`**，否则窄视口顶栏换行后（2~3 行）面板会盖住顶栏。
- **同伴卡（`renderCards()`）**：增量更新——卡片 DOM 只创建一次，之后只改文本/属性；因此队列滚动位置、折叠状态在 1s 轮询间不会丢。
  - 卡头（`.card-head`）点击折叠/展开，状态存 `state.cardCollapsed`；同伴数 > `CARD_AUTO_COLLAPSE_OVER`（3）时新卡片默认折叠；`.left` 自身纵向滚动，同伴再多也只是左栏滚动。
  - 队列有界：`queueItems()` 最多渲染 `CARD_QUEUE_RENDER_MAX`（60）条（超量 = 40 条队首 + "… 省略 N 项 …" + 12 条队尾），`.q-list{max-height:112px}` 内部滚动；**滚动容器是 flex 列时子项必须 `flex:0 0 auto`**，否则会被压缩成 0 高（表现为队列一片空白）。

---

## 6. 本地运行与验收

```powershell
cd E:\game\HMCL\numen-tree

# 演示（不需要游戏/树）
node tools/treeview/server.mjs --mock
# 实时（需要树已启动：node src/daemon.mjs）
node tools/treeview/server.mjs
# 或双击 启动树监控.bat（自动起服务+开浏览器；--mock 演示）
```

**改完代码的最小验收清单**：
1. `node --check tools/treeview/server.mjs`、`model.mjs`、`public/app.mjs`
2. `GET /api/health` 返回 `{ok:true}`
3. `GET /api/model`：nodes/edges 数合理、无 500
4. `GET /api/state`：`mode=live` 时有 companions/events；`mode=offline` 时不报错
5. 页面：Ctrl+F5 后无 banner 错误；加载提示会消失；能看到整树 + 端口；当前节点有光柱/红标记（mock 模式可造）
6. 窄视口（拖窄窗口或 DevTools 手机尺寸，如 540×960 / 400px）：顶栏不被左右面板遮挡；左右面板不互相覆盖；队列高度 ≤ 约 112px 且可滚动；同伴 >3 时折叠、点卡头能展开
7. 树侧联动：树 `reload-skills` 后 `modelVersion` +1，页面模型自动重拉

**已知现象**：
- 页面首次打开若树没跑：显示静态图 + OFFLINE，正常。
- `GET /api/state` 里 events 来自 trace 尾部，只保留最近 300 条；更早的路径历史在浏览器内存里累积（刷新丢失，符合"监控"预期）。

---

## 7. 常见维护任务

| 任务 | 怎么做 |
|---|---|
| 树加了新配方/步骤/技能/中断 | **不用改 treeview**（自动 import 生成）；重启树→`reload-skills`→刷新页面即可 |
| 树改了字段名（如 plan.cursor） | 改 `public/app.mjs` 的 `currentActivityId()`/`renderCards()`；改 `server.mjs` 若事件 note 变了；同步本文 §4 |
| 新增节点类型 | `model.mjs`：加节点/边 + `NODE_TYPES`；`app.mjs`：`TYPE_COLOR/TYPE_SIZE/EDGE_COLOR`、`geoFor()`、`layout()`；`index.html` 图例 |
| 调整颜色/大小/发光 | `app.mjs` 顶部 `TYPE_COLOR/TYPE_SIZE`、`glowSprite()` 参数、`renderCompanions()` 里的半径/透明度 |
| 调整布局 | `layout()`（确定性坐标；改完需要 force 刷新模型或重启 server 以重建） |
| 加"聚焦模式"（非路径压暗） | `renderCompanions()` 后统一遍历 `state.nodeById`，把不在当前路径的 mesh/glow opacity 降低；建议加开关按钮 |
| 升级 three.js | 必须用**自包含单文件构建**（不能只拷 `three.module.js` 而缺 `three.core.js`，否则白屏）；同时更新 `OrbitControls.js` 且版本匹配；改 `index.html` importmap 路径不变 |
| 加 P2"为什么"层 | 前端把 events 里 `interrupt/plan_step fail/auto` 映射到节点上的小徽标；后端可能要补 normalize（如仲裁日志） |
| 加回放/时间轴 | 新增 `GET /api/trace?since=`；前端用历史 events 时间轴重放（当前 events 记忆只在内存） |
| 面板挡住顶栏 / 队列无限拉长 | 顶栏高度走 `--top-h`（`syncHudMetrics()`，别写死 `top`）；队列上限改 `app.mjs` 的 `CARD_QUEUE_RENDER_MAX / CARD_QUEUE_HEAD / CARD_QUEUE_TAIL`，可视高度改 `index.html` 的 `.q-list{max-height}` |
| 同伴很多 / 卡片太长 | 卡头点击折叠（`state.cardCollapsed`，>3 默认折叠）；左栏 `.left` 自身滚动；给卡片加字段要加进 `renderCards()` 的增量更新（别退回整卡 `innerHTML`） |
| 换游戏/换树 | 新建 `adapters/<name>/model.mjs` 实现同契约，core 不动 |

---

## 8. 坑（踩过的）

1. **three 拆分构建**：新版 three 发布 `three.module.js` + `three.core.js` 两个文件；只下前者 → 浏览器报模块解析错误、页面白屏。本工具固定 r160 单文件；升级时必须验证 `grep three.core` 为空。
2. **importmap**：`index.html` 里 `three` → `/vendor/three/three.module.js`，`three/addons/controls/OrbitControls.js` → `/vendor/three/OrbitControls.js`；OrbitControls 内部 `from 'three'` 依赖 importmap 映射。
3. **别用 `LineBasicMaterial` 画路径**：线宽在 WebGL 无效（永远 1px），看起来"灰/不显眼"；用 `TubeGeometry`。
4. **覆盖层要 `depthTest:false`**：路径/失败标记/标签会被节点遮挡，需关闭深度测试并设 `renderOrder`。
5. **每次轮询重建同伴 group 必须 `clearGroup` 释放 geometry/material/texture**，否则显存泄漏。
6. **模型缓存**：`server.mjs` 里模型缓存 3s；改 `model.mjs` 后要重启 server 才生效（静态 app.mjs 不用重启）。
7. **树侧只读依赖**：不要在 treeview 里 import 树的行为代码/写状态；也不要让树 import treeview。
8. **配置文件改动不触发 modelVersion**（只有 reload-skills 触发）；页面没变化时先确认树是否 reload。
9. **端口冲突**：8780 被占则 bat 直接开页面；手动起服务前先 `netstat` 查。
10. **trace 半行**：读取尾部时最后一行可能正在写，`JSON.parse` 失败要忽略（server 已处理）。
11. **面板不要写死 `top`**：顶栏在窄视口会换行变高（`≤760px` 有媒体查询把左右面板改半宽），高度由 `ResizeObserver` 写进 `--top-h`；写死 `top:56px` 会让面板盖住顶栏（本工具踩过）。
12. **滚动容器里的 flex 子项要 `flex:0 0 auto`**：`.q-list` 与 `.left`/`.right` 都是 `display:flex; flex-direction:column; max-height/固定高度 + overflow:auto`，子项默认 `flex-shrink:1` 会被压扁——`.q-item` 被压成 0 高（队列一片空白、只剩"省略 N 项"），`.left` 里的 `.card` 被压到容器高度（同伴一多内容被裁掉且不能滚动）。`.left>.card`/`.right>.card` 已固定 `flex:0 0 auto`。
13. **1s 轮询别用 `innerHTML` 重建整卡**：会丢队列滚动位置和折叠状态；`renderCards()` 是增量更新（DOM 只建一次），改卡片字段时沿用这个模式。
14. **`clearGroup()` 释放资源时注意作用域**：曾把 `m.dispose?.()` 写在 `for (const m of mats)` 循环外 → 每 1s 轮询都抛 `m is not defined`，页面只更新一次、看起来像"卡住/离线"。改动后跑一次页面 Console 确认无 `[treeview] poll failed`。

---

## 9. 当前限制 / 待做（P2/P3）

- 多同伴路径**重叠时颜色叠加**（未做平行偏移彩带）
- "为什么"层未画：仲裁命中规则、中断预占、日程段、失败 kind 分布、降级阶梯级别、任务变换目标替换（等双策略/任务变换落地再补）
- 失败标记"渐隐到底"的阈值/时长可配未做
- 无回放/时间轴；events 只留最近 300 条
- 当前节点材质高亮在多同伴时取最后处理的同伴（路径色仍各自正确）
- 3D 视觉：无 bloom/后处理（如需可下载 three 的 EffectComposer/UnrealBloomPass，别手写）
- `modelVersion` 只跟 reload-skills；改 `tree.config.json` 不触发
- 无自动化 UI 测试（目前靠 mock 模式肉眼验收）

---

## 10. 交接 checklist（下一个维护者按这个来）

1. 读本文 + `docs/16`；确认没动 `src/`（treeview 只读）。
2. `node --check` 三个文件；起 `--mock` 看页面是否有整树/端口/失败标记。
3. 起真实树（`启动树进程.bat`）→ 起 live treeview → 刷新页面看 mode=live、路径亮。
4. 若报错：看页面 banner、`/api/health`、`/api/state`、浏览器 Console。
5. 改任何树字段/日志格式：同步 §4 契约 + `app.mjs` 解析 + 本文。
6. 改完跑 §6 验收清单；更新 `docs/16 §11` 的"实现状态"与本文"已知限制"。

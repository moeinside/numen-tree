# treeview · 树监控（独立工具）

> 独立进程 + 独立浏览器页面，**只读**读取树的结构与运行态；不是树的组件，树不依赖它。
> 需求与设计记录：`docs/16-实时树图可视化-提案.md`。
> **维护/交接请先读 [`MAINTENANCE.md`](./MAINTENANCE.md)**（架构、JSON 契约、常见任务、坑、验收清单）。

## 启动

```powershell
cd E:\game\HMCL\numen-tree
node tools/treeview/server.mjs          # http://127.0.0.1:8780
node tools/treeview/server.mjs --mock   # 无游戏/无树也能演示（模拟运行态）
```

或者双击仓库根目录的 **`启动树监控.bat`**（自动起服务 + 打开浏览器；`启动树监控.bat --mock` 为演示模式）。

开树后刷新页面即可实时高亮；树没开时显示静态结构与"离线"提示。

## 数据来源（全部只读）

| 数据 | 来源 |
|---|---|
| 静态结构 | `../../src/recipes.mjs` / `interrupts.mjs` / `schedule.mjs` / `crafttree.mjs` / `skills/*`（动态 import，树 reload 后自动更新） |
| 运行态 | `GET http://127.0.0.1:8766/status`（含 `modelVersion`） |
| 失败/步骤事件 | `../../logs/trace-*.jsonl` 尾部 |

## 接口

- `GET /api/model`：图模型（节点/边/计数）
- `GET /api/state`：运行态 + 归一化事件 + `modelVersion`
- `GET /api/trace`：trace 尾部原始事件
- `GET /api/health`：自身状态

## 功能（P0/P1）

- 3D 整树：配方/步骤/技能/中断/日程/合成树 + **边界端口/核心链路**（tree MCP 8767、control 8766、numen MCP 8765、lane/planner/arbiter/executor/observer）六类节点，曲线边，发光节点；
- 实时高亮：当前计划步 + 最近 N 个节点路径（色温：越新越热，N 默认 3 可调 3~8）；
- 多同伴：彩虹色分配 + 各自路径高亮（重叠时目前颜色叠加，未做平行偏移彩带）；
- 失败标记：所有 fail 在节点上留红色渐隐标记，**节点再次激活时清除**；
- 缩放：远看整树流向，近看节点说明/参数（右侧详情面板）；
- 只读：不提供任何控制操作。

## 外部库（vendor，不手写）

- `vendor/three/three.module.js`：**three.js r160 自包含构建**（新版 three 拆成 `three.module.js` + `three.core.js`，只拷前者会报模块解析错误 → 已固定用 0.160.0 单文件版）
- `vendor/three/OrbitControls.js`：three 0.160 examples 版本

# DECISIONS

## 2026-11-10 Lead 开发边界禁令

- **Lead 只开发树工具**（`src/`、行为/架构、树验收/回放/审计、树文档）。
- **旁支工具只讨论需求/边界/验收，不直接实现、不直接修 bug**。
- 旁支工具一律交独立工具子体实现；必须交 README + MAINTENANCE + TESTPLAN。
- 工具维护由独立维护子体负责；Lead 不兼任。
- 旁支不阻塞主线；当前旁支开发暂停，树主任务优先。

## 2026-11-10 Pilot MVP 实现完成（docs/83、tools/pilot）

- **lock/unlock/handoff/恢复演练**：9/9 通过；真实树 handoff 已验证；锁无残留。
- **run 循环**：观测→LLM→批准→执行→JSONL/manifest/report 已通；mock dry-run、真实 Lua 单步、target 退出均通过。
- **防上下文爆炸三层**：LLM `stop` + target 谓词（`--target-file`）+ 步数/时间/token caps/Ctrl-C；观测裁剪 + history 窗口。
- **preflight**：numen MCP 9 工具、树 8767、锁状态只读检查；无锁残留。
- **cheat**：仅 fixture 阶段、仅 `creative.give`；RUNNING 零 cheat；未实机验证（需创造模式/世界 cheats）。
- **待验证**：真实 OpenAI-compatible LLM 端到端；树重新出现 abort；recover-stale 后树重启/Track A。

## 2026-11-10 开发工具详细设计（docs/83）

- **pilot 独占 numen MCP 8765**；树活着时 pilot 不启动；只连 8765，不连树 8767。
- **全局 lease + OS lock + heartbeat**；`pilot lock/unlock` 状态机；树用 `control --op exit` 优雅退出，禁止 taskkill。
- **解锁**：停手→等收敛→lock --all（必要时 reset-brain）→删 lease→可选重启树。
- **numen MCP 无通用 command**；唯一近似作弊码是 `numen.creative.give`，**Creative mode only**。
- 世界 cheats 关闭时 `creative.give` 失败，报 `cheats_disabled`，不绕过；开作弊需测试世界建时允许/ LAN 允许，或 dev 命令桥另开 gate。
- **cheat 仅 FIXTURE 阶段**；RUNNING 零 cheat；禁止 effect/gamerule/difficulty/kill/clear/fill/clone/scanWorld。
- **MVP**：lock/unlock+preflight、MCP 单步循环、JSONL+只读观测台、人工批准+caps、settle/unlock、可选 CreativeGiveProvider。
- 暂不做 CommandProvider/RCON/scanWorld/自动长跑/自动恢复树。

## 2026-11-10 Pilot 双轨共识（docs/82）

- **Track A 唯一证据；Track B 只是探针**，不是第二主线/并行驾驶。
- **同世界同同伴同动作槽禁止并行**；B 跑时树退出或只读挂起；优先串行（A→恢复→B）。
- **B 产物只允许三类**：缺失谓词/前置、恢复点/失败分类、机制事实；禁止动作序列/阈值/调参目标。
- **B 不设达标**；只能由 A 缺口触发；每条设计候选绑定 A 失败 trace/负样本。
- **隔离**：独立世界/同伴/目录/端口；只读观测；fencing + 外部 kill + 步数/墙钟/成本上限。
- **MVP 四件**：单步 MCP、JSONL、只读观测台、手动 stop + manifest；砍 segmenter/review pack/自动长跑/cheat。
- **顺序**：冻结 Track A 规格/审计 → B harness → A 先跑 → B 按缺口串行。
- **不能从 B 得出**：自主生存、Day1 通过、树上限/基准、无干预。

## 2026-11-10 Pilot 参考运行修订（docs/81）

- **pilot 提前到 Day1 期间**：作为 Track B 参考运行，人工批准、实时观测/纠错，不作验收。
- **Day1 双轨**：Track A 树自己跑（唯一出线证据）；Track B LLM pilot（参考）。
- **隔离**：独立世界/同伴/状态目录/日志；不共享 Facts/动作槽；pilot 失败不算树失败。
- **仍不做**：cheat provider、scanWorld/WorldHints 运行时、pilot 产物进验收/学习/树。
- **人工批准门**：runId/目的/时间步数上限/kill switch/结束 reason/标记 `mode=reference-pilot`。

## 2026-11-10 开发工具共识（Pilot/Recorder/Cheat 延后）

- **方向可行，当前不做**：Day1 出线前不建 LLM pilot/cheat provider。
- **一个产品族，两个信任域**：pilot+recorder 可同工具；cheat 独立进程/构建/世界。
- **单机无 RCON**：RCON 仅专用服且另开 gate；单机用 mod HTTP/离线 oracle。
- **cheat 仅 fixture 期**：run 中零 cheat；禁止 effect/gamerule/difficulty/kill/clear/fill/clone/forceload/data merge。
- **证据隔离**：cheat 事件独立 channel；不进 facts/决策/学习/验收；manifest+构建+配置扫描可反证“无作弊”。
- **pilot 只作上限对照**，不进树/验收/学习；输出只产事实/回归/假设。
- **删除“为未来功能留捷径”定性**；每项 cheat 能力重新提案。
- **顺序**：Day1 出线 → recorder+stop+backup/restore+审计 → pilot → fixture cheat → scanWorld/WorldHints。

## 2026-11-10 Day1 最终共识（PM 有条件批准）

- **Day1 定性**：夹具能力验收，不证明自主/泛化。
- **通过条件**：M1 原木≥6（只算原木）+ M2 工作台现场可交互 + M3 `tool_held_attempt` + M4 `night_no_damage` + `food_ok`。
- **food_ok**：至少一次进食证据，或入夜前食物存量≥2；饥饿≥14 只作安全条件，不能单独满足。
- **M3**：改名 `tool_held_attempt`，不宣称工具有效；空手砍树不得通过；证据必须 attempt 绑定 + 前后双观测。
- **火把路径删除**：从零需要熔炉/木炭，Day1 不保证。
- **失败分类**：capability_fail / material_unavailable / unknown；后两者必须 oracle/审计证明，unknown 超限作废。
- **不做**：WorldHints 运行时、多同伴、SpatialMemory、新包、石/炉/床/木屋、斜坡挖/竖井、写死 S0–S7、调阈值。
- **架构留桩**：WorldHints(off)、结果型 GoalProfile/依赖/回退、SpatialMemory、溯源、观察预算、快照恢复、多同伴 sender。
- **冻结后跑 Day1**；只认非 oracle 版本。

## 2026-11-10 圆桌共识：Day1 从 0 到求生

- **有条件共识，可开工**：六位顾问全部“有条件同意”。
- **运行时作弊扫描一致否决**：只允许离线/测试 oracle，不进 Facts/Planner/目标选择；trace 出现 oracle 即判负。
- **断点不在感知不足**：在结果型 milestone、前置回补、未知下入口策略、食物/低血硬门、候选可达性。
- **“无脑撸树”不是固定第一步/milestone**：建模成默认起始倾向/未知下低风险换信息的入口策略。
- **Day1 基准**：固定夹具、0 资源、无 LLM、零干预、day0 黎明→day2 清晨；发现→采集→工作台+木工具→一项夜间保底；death=0、无死循环/假成功。
- **不做**：运行时扫描、多同伴、SpatialMemory、新包（from_zero 除外）、硬编码 S0–S7、调阈值过验收。
- **第一版 Day1 不要求**：石工具、熔炉、床、木屋。
- **Day1 通过只证明该夹具可过**，不证明泛化。

## 2026-11-10 边界审计（MC 专家）

- **触手 v0.3 的 landmarks/water 确定穿墙（无 LOS/FOV）**：降级为候选，不做权威；使用前现场校验，不用于战斗/容器/避水权威。
- **威胁权威 = numen `scan.entities("hostile")`**；触手只做近身辅助。
- **食物权威 = numen status/inv**；触手 `self.food=null` 时禁止 `Number(null)` 误读为 0。
- **待修**：树侧 null 误读；v0.4 给 landmarks/water 加 LOS/FOV，或降为已探索记忆。
- **需活体实测**：food null、夜间视距、category 抽样、avoid 全值表、scan 上限、events 不吃槽、生肉可吃性。

## 2026-11-10 MC 专家首轮结论（影响 early_survival）

- **MC 没有口渴机制**：行为链里的“找水/喝水”是错的，删；水只与钓鱼/种田/灭火/风险有关。
- **饥饿 <18 没有自然回血**：HP5 不是“待恢复”，是食物硬门失败；必须做食物存量硬门。
- **木工具是过渡，不是终点**：木镐耐久 59，必须加“木→石”升级；否则两天内必坏。
- **地表 scan stone 常为 0**：圆石应找裸露岩壁或向下挖，不能写死地表 stone 扫描。
- **树种写死 oak/spruce/birch**：樱花/黑森林/雨林/红树林会 100% 失败，要 tag 或全树种。
- **火把只认 coal**：从零照明的正确路线是木炭，必须支持 charcoal。
- **夜间不一定建屋**：火把+洞/封门即可；床是更便宜选项，需定义允不允许。
- **避水 `avoid` 用 cell type `water/flowing_water`**，不是 block id；且避水看不见未观测的水。
- **需实测**：出生 biome/32 格资源普查、生肉可吃性、scan tag、向下挖后出坑、avoid 语法。

## 2026-11-10 总控愿景级重评

- **北极星**：`NORTH-STAR.md` 为总控必读；每次先答“抬头三问”。
- **early_survival 是验证场景，不是能力/任务清单**：不要写死 S0–S7 profile；要补它下面的通用机制——结果型 milestone、前置条件回补、失败归因。
- **milestone 语义债是最大系统性风险**：plan 当 milestone 会让 GoalStore→planner→失败归因→恢复→审计全链污染。
- **明天方向**：收口冻结口径；补通用环；用一次可判负的一天观察过阶段门。
- **不做**：新增战术/战略包、扩感知、SpatialMemory、多同伴、硬编码生存链、调阈值过验收。

## 2026-11-10 夜停

- **停止开发，不跑两夜**：一天观察不达标（avgHP 5/饥饿 4.6/water_stuck/no_food），继续跑没有意义。
- **主线改为 `early_survival`**：不是继续追 water bug；水/饥饿是症状，缺的是从 0 到第一夜的结果链。
- **保留已达成共识**：P0-0a 感知/事务、P0-0b 最小眼、GoalStore/谓词不推翻。
- **避水改动标记为待修**：`avoid = {"minecraft:water"}` 是错误 cell type，导致 route.plan bad_argument；明天先回退/修正。
- **明天第一件事**：2h 内落 `early_survival`（3~4 结果型 milestone + `from_zero` SOP + 食物/低血硬门），冻结验收，再跑一天。
- **阶段门**：一天不达标即停线补能力，不加观察轮次、不跑两夜、不扩感知。

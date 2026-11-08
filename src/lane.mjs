import { getSkill } from './skills/index.mjs';
import { GoalStatus, makeGoal } from './state.mjs';
import { KIND_WORDS } from './lines.mjs';
import { pickInterrupt } from './interrupts.mjs';
import { buildAtom } from './atoms.mjs';
import { runTactic, runSettle, needsSettle } from './tactic-runner.mjs';
import {
  EXEC_DEFAULTS,
  createExecState,
  describeExec,
  evaluateMode,
  noteInterrupt,
  noteObservation,
  noteRisk,
  postflight,
  preflight,
} from './exec-policy.mjs';
import { OFF_SEGMENT, allow, hasTool, patrolTarget, pickSegment } from './schedule.mjs';
import {
  PlanStatus,
  decideAfterStep,
  currentStep,
  finishPlan,
  planAlive,
  planView,
  resumePlan,
  suspendPlan,
} from './plan.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 快观测：只采"危险相关"的高频字段（1~1.5 秒一次），慢变量另走慢观测。
const OBSERVE_FAST_LUA = `
local me = numen.status.self()
local w = numen.status.world()
local t = numen.task.status()
local o = numen.status.owner()
local hs = numen.scan.entities("hostile", { radius = 16 }) or {}
local hd = nil
for _, e in ipairs(hs) do
  local d = e.distance or 999
  if hd == nil or d < hd then hd = d end
end
local dark = false
if w.is_dark_outside ~= nil then dark = w.is_dark_outside end
local function N(v) return tostring(math.floor((tonumber(v) or 0) * 100 + 0.5) / 100) end
local function S(v) local s = tostring(v or ""):gsub('"', "'") return '"' .. s .. '"' end
local function O(v) if v == nil then return 'null' end return '"' .. tostring(v) .. '"' end
local parts = {
  '{"hp":' .. N(me.hp),
  ',"hunger":' .. N(me.hunger),
  ',"x":' .. N(me.pos.x),
  ',"y":' .. N(me.pos.y),
  ',"z":' .. N(me.pos.z),
  ',"dim":' .. S(me.dimension),
  ',"game_time":' .. N(w.game_time),
  ',"task_id":' .. O(t.task_id),
  ',"task":' .. O(t.task),
  ',"task_state":' .. O(t.state),
  ',"elapsed_s":' .. O(t.elapsed_s),
  ',"budget_left_s":' .. O(t.budget_left_s),
  ',"owner_online":' .. (o.online and 'true' or 'false'),
  ',"owner_dist":' .. N(o.distance),
  ',"owner_x":' .. N(o.pos and o.pos.x or 0),
  ',"owner_y":' .. N(o.pos and o.pos.y or 0),
  ',"owner_z":' .. N(o.pos and o.pos.z or 0),
  ',"hostile_n":' .. N(#hs),
  ',"hostile_d":' .. (hd and N(hd) or 'null'),
  ',"dark":' .. (dark and 'true' or 'false'),
}
return table.concat(parts) .. '}'
`;

// 一次只读观测：坐标/血/饿 + 背包食物 + 武器 + 附近猎物 + 敌对 + 主人。
// 只读不占任务槽；返回紧凑 JSON 字符串（树侧只认这个格式）。
const OBSERVE_LUA = `
local me = numen.status.self()
local w = numen.status.world()
local t = numen.task.status()
local o = numen.status.owner()

local function S(v) local s = tostring(v or ""):gsub('"', "'") return '"' .. s .. '"' end
local function N(v) return tostring(math.floor((tonumber(v) or 0) * 100 + 0.5) / 100) end
local function O(v) if v == nil then return 'null' end return '"' .. tostring(v) .. '"' end

-- 敌对
local hs = numen.scan.entities("hostile", { radius = 16 }) or {}
local hd = nil
for _, e in ipairs(hs) do
  local d = e.distance or 999
  if hd == nil or d < hd then hd = d end
end
local dark = false
if w.is_dark_outside ~= nil then dark = w.is_dark_outside end

-- 背包：可吃的 + 最好的武器
local FOODS = {
  bread = 1, apple = 1, carrot = 1, potato = 1, baked_potato = 1, beetroot = 1,
  beetroot_soup = 1, mushroom_stew = 1, rabbit_stew = 1, melon_slice = 1,
  sweet_berries = 1, glow_berries = 1, pumpkin_pie = 1, cookie = 1,
  golden_apple = 1, enchanted_golden_apple = 1, dried_kelp = 1, honey_bottle = 1,
  cooked_beef = 1, cooked_porkchop = 1, cooked_chicken = 1, cooked_mutton = 1,
  cooked_rabbit = 1, cooked_cod = 1, cooked_salmon = 1,
  beef = 1, porkchop = 1, chicken = 1, mutton = 1, rabbit = 1, cod = 1, salmon = 1,
  rotten_flesh = 1,
}
local TIER = { wooden = 1, stone = 2, iron = 3, golden = 1, diamond = 4, netherite = 5 }
local food, kinds, weapon, wscore = 0, 0, nil, 0
local invList = {}
local INV_MAX = 24
for _, it in ipairs(numen.inv.items() or {}) do
  local name = tostring(it.item or it.id or it.name or "")
  local short = name:match("([%w_]+)$") or name
  local n = tonumber(it.count or it.n) or 1
  if name ~= "" and n > 0 and #invList < INV_MAX then
    invList[#invList + 1] = '["' .. name .. '",' .. N(n) .. ']'
  end
  if FOODS[short] then
    food = food + n
    kinds = kinds + 1
  end
  local mat = short:match("^(%a+)_sword$") or short:match("^(%a+)_axe$")
  if mat and (TIER[mat] or 0) > wscore then
    wscore = TIER[mat] or 0
    weapon = name
  end
end
-- 手持物（比翻背包更准；空手时 mainhand 是 nil）
local held = nil
if me.hands and me.hands.mainhand then held = me.hands.mainhand.item end
if held then
  local short = tostring(held):match("([%w_]+)$") or tostring(held)
  local mat = short:match("^(%a+)_sword$") or short:match("^(%a+)_axe$")
  if mat and (TIER[mat] or 0) > wscore then
    wscore = TIER[mat] or 0
    weapon = held
  end
end

-- 附近能吃的被动生物（牛/猪/羊/鸡/兔）；过滤名不确定，用 pcall 兜底
local EDIBLE = { cow = 1, pig = 1, sheep = 1, chicken = 1, rabbit = 1 }
local function scanKind(k, r)
  local ok, list = pcall(numen.scan.entities, k, { radius = r })
  if ok and type(list) == "table" then return list end
  return nil
end
local an = scanKind("passive", 32) or scanKind("animal", 32) or {}
local ac, ad, at = 0, nil, nil
for _, e in ipairs(an) do
  local ty = tostring(e.type or e.kind or "")
  local short = ty:match("([%w_]+)$") or ty
  if EDIBLE[short] then
    ac = ac + 1
    local d = e.distance or 999
    if ad == nil or d < ad then ad = d; at = ty end
  end
end

local parts = {
  '{"hp":' .. N(me.hp),
  ',"hunger":' .. N(me.hunger),
  ',"x":' .. N(me.pos.x),
  ',"y":' .. N(me.pos.y),
  ',"z":' .. N(me.pos.z),
  ',"dim":' .. S(me.dimension),
  ',"game_time":' .. N(w.game_time),
  ',"task_id":' .. O(t.task_id),
  ',"task":' .. O(t.task),
  ',"task_state":' .. O(t.state),
  ',"elapsed_s":' .. O(t.elapsed_s),
  ',"budget_left_s":' .. O(t.budget_left_s),
  ',"owner_online":' .. (o.online and 'true' or 'false'),
  ',"owner_dist":' .. N(o.distance),
  ',"owner_x":' .. N(o.pos and o.pos.x or 0),
  ',"owner_y":' .. N(o.pos and o.pos.y or 0),
  ',"owner_z":' .. N(o.pos and o.pos.z or 0),
  ',"hostile_n":' .. N(#hs),
  ',"hostile_d":' .. (hd and N(hd) or 'null'),
  ',"dark":' .. (dark and 'true' or 'false'),
  ',"food":' .. N(food),
  ',"food_kinds":' .. N(kinds),
  ',"weapon":' .. O(weapon),
  ',"weapon_score":' .. N(wscore),
  ',"held":' .. O(held),
  ',"animal_n":' .. N(ac),
  ',"animal_d":' .. (ad and N(ad) or 'null'),
  ',"animal_t":' .. O(at),
  ',"inv":[' .. table.concat(invList, ',') .. ']',
}
return table.concat(parts) .. '}'
`;

/**
 * 一个同伴的"执行通道"。
 *
 * 职责边界（严格）：
 *  - 只做：取目标 → 找技能 → 下发 → 收结果 → 记账 → 该上报的上报
 *  - 不做：价值判断、组织语言、自己发明目标
 */
export class Lane {
  #stopped = false;
  #lastObserveAt = 0;
  #lastFastObserveAt = 0;
  #lastSessionGeneration = null;
  #lastResyncAt = 0;
  #lastErrLogAt = 0;
  #lastSpeakAt = 0;
  #lastScheduleId = null;
  #lastUnlockAt = 0; // 外部清锁最小间隔（防止补丁不在线时每 tick 重试）
  seg = OFF_SEGMENT; // 当前日程段（schedule.mjs 的数据；每 tick 由 #updateSchedule 刷新）

  /**
   * @param numen       动作客户端（会占用 Lua 槽）
   * @param eventsClient 事件客户端（**独立 MCP 会话**，长轮询会独占会话，绝不能和动作共用）
   */
  constructor({ state, numen, eventsClient, trace, inbox, cfg, lines, places, planner, worldmem, lockfix }) {
    this.state = state;
    this.numen = numen;
    this.eventsClient = eventsClient || numen;
    this.trace = trace;
    this.inbox = inbox;
    this.cfg = cfg;
    this.lines = lines || null;
    this.places = places || null; // 地点簿（死亡点自动记录、配方里的 place 解析）
    this.planner = planner || null; // 计划层（matching 配方）
    this.worldmem = worldmem || null; // 世界记忆（容器/资源点，记录用）
    this.lockfix = lockfix || null; // 僵尸锁外部清理（补丁 v3 的 127.0.0.1:8768）
    // 执行策略层（docs/20 §10）：safe-batch / field-guarded；"安全"看行为证据，不看位置
    this.exec = createExecState();
    const ep = cfg.behavior?.execPolicy || {};
    this.execPolicy = {
      ...EXEC_DEFAULTS,
      ...ep,
      preflight: { ...EXEC_DEFAULTS.preflight, ...(ep.preflight || {}) },
    };
    // 初始模式来自配置；之后可由 tree_control / CLI 按同伴覆盖
    this.state.mode = cfg.behavior?.mode ?? this.state.mode ?? 'survival';
  }

  start() {
    this.trace.info('lane_start', { companion: this.state.name });
    this.#actionLoop();
    this.#eventLoop();
  }

  stop() {
    this.#stopped = true;
  }

  // ── 动作循环 ──────────────────────────────────────────────
  async #actionLoop() {
    while (!this.#stopped) {
      try {
        await this.#tick();
      } catch (e) {
        this.trace.error('tick_error', { companion: this.state.name, note: String(e) });
      }
      await sleep(this.cfg.loop.tickMs);
    }
  }

  async #tick() {
    const st = this.state;
    st.lastTickAt = Date.now();

    // 执行策略层：根据行为证据（reflex/敌对/受伤/主人危险）决定 safe-batch 还是 field-guarded
    const modeBefore = this.exec.mode;
    evaluateMode(this.exec, st, Date.now(), this.execPolicy);
    st.execMode = this.exec.mode;
    st.execReason = this.exec.reason;
    st.execSince = this.exec.since;
    if (modeBefore !== this.exec.mode) {
      this.trace.info('exec_mode', {
        companion: st.name,
        note: `${modeBefore} -> ${this.exec.mode}（${this.exec.reason}）`,
      });
      if (this.exec.mode === 'field-guarded') st.execDowngradeAt = Date.now();
    }

    // 本能让路：numen 核心反射（逃/防御/脱困/MLG/溺水）正在占用同伴时，树不抢槽、不派动作。
    // 由 reflex 事件（#handleEvent）或"补丁 count=0 但槽被拒"（#maybeObserve）设置。
    if (Date.now() < (st.instinctBusyUntil || 0)) {
      st.instinctYields = (st.instinctYields || 0) + 1;
      return;
    }

    // MCP 会话换了 = 游戏重启过 / 换过档：上一局的状态全部作废
    const gen = this.numen.sessionGeneration;
    if (this.#lastSessionGeneration === null) {
      this.#lastSessionGeneration = gen;
    } else if (gen !== this.#lastSessionGeneration) {
      this.#lastSessionGeneration = gen;
      // 防抖：15 秒内只重置一次
      if (Date.now() - this.#lastResyncAt > 15000) {
        this.#lastResyncAt = Date.now();
        this.#resync('session_reset', { note: `MCP 会话重建（第 ${gen} 次）` });
        return;
      }
    }

    if (st.paused || st.actionLock) return;

    // 自止：必须先于目标执行检查（否则队列一直非空，永远到不了检查点）
    if (this.#maybeSelfStop()) return;

    // 0) 清掉过期的手下目标（LLM 下的、排队太久没轮到）：别让旧指令在队列里躺着
    this.#expireStaleGoals();

    // 1) 观测（快/慢分层；动作刚结束时强制刷新一次）
    await this.#maybeObserveFast();
    await this.#maybeObserve();

    // 1.5) 日程：按"天黑/天亮 + 有没有记家"选当前时段段（纯查表，供中断表与仲裁用）
    this.#updateSchedule();

    // 2) 中断/抢占：**先于下一个动作**执行，这样分片之间能及时响应
    if (this.#maybeInterrupt()) return;

    // 3) 队列里已有目标（中断目标 / LLM 指令 / 计划步骤）：执行
    const goal = st.nextGoal();
    if (goal) {
      await this.#runGoal(goal);
      return;
    }

    // 4) 计划死线
    if (planAlive(st.plan) && st.plan.deadlineAt && Date.now() > st.plan.deadlineAt) {
      this.trace.warn('plan_deadline', { companion: st.name, note: `${st.plan.id} 超时` });
      this.#finishPlan(st.plan, PlanStatus.FAILED, 'deadline');
      return;
    }

    // 5) 计划推进（派下一步 / 处理 report 步 / 恢复挂起）
    if (this.#planControl()) return;

    // 6) 空闲：仲裁（可能开自动计划）→ 牵引绳 → 待命
    //    LLM 有指令排队/在跑时，树的自动行为先让路（LLM 是外层大脑，别跟它抢）
    const llmBusy = st.goals.some(
      (g) => (g.status === 'pending' || g.status === 'running') && g.note === 'mcp',
    );
    // 接管宽限期：LLM 刚活动过（宽限期内）即使队列暂时空着，也别让自动行为抢方向盘
    const graceMs = Number(this.cfg.drive?.autoGraceSeconds ?? 20) * 1000;
    const llmRecent = !!st.lastLlmGoalAt && Date.now() - st.lastLlmGoalAt < graceMs;
    if (!llmBusy && !llmRecent) {
      if (!planAlive(st.plan)) await this.#arbitrate();
      if (!st.nextGoal() && !planAlive(st.plan)) await this.#maybeLeash();
      if (!st.nextGoal() && !planAlive(st.plan)) await this.#maybeIdle();
    }
  }

  /** 清掉排队太久还没轮到的手下目标（LLM 的），避免旧指令躺在队列里像"卡住"。 */
  #expireStaleGoals() {
    const st = this.state;
    const now = Date.now();
    // LLM 目标经常要排在长动作后面，排队上限放宽；作废时叫醒大脑（不能静默丢命令）
    const staleMs = Number(this.cfg.loop?.mcpGoalStaleSeconds ?? 300) * 1000;
    for (const g of st.goals) {
      if (g.status !== GoalStatus.PENDING) continue;
      if (typeof g.note !== 'string' || g.note !== 'mcp') continue;
      const created = Date.parse(g.createdAt);
      if (!Number.isFinite(created) || now - created < staleMs) continue;
      g.status = GoalStatus.CANCELLED;
      g.endedAt = new Date().toISOString();
      g.lastResult = { reason: 'expired' };
      this.trace.warn('goal_expired', {
        companion: st.name,
        note: `${g.id} ${g.skill} 排队 ${Math.round((now - created) / 1000)}s 未执行，已作废`,
      });
      this.inbox.push({
        kind: 'goal_expired',
        companion: st.name,
        goalId: g.id,
        skill: g.skill,
        needsBrain: true, // 这是"指令没执行就被丢了"，必须叫醒大脑知道
        detail: {
          message: `目标 ${g.id}（${g.skill}）排队超过 ${Math.round(staleMs / 1000)} 秒没轮到，已作废。`,
          hint: '树一个同伴同一时间只做一件事。要看它在忙什么用 tree_status；确认可丢弃就用新目标重下。',
        },
      });
    }
  }

  // ── 计划层控制 ────────────────────────────────────────────

  // ── LLM 接管预算（自止）────────────────────────────────────

  /** LLM 每下一条指令（tree_goal / tree_task）就刷新一次接管窗口。 */
  noteLlmActivity() {
    const st = this.state;
    const now = Date.now();
    if (!st.driveStartedAt) {
      st.driveStartedAt = now;
      st.driveGoals = 0;
      st.driveStopReason = null;
    }
    st.driveGoals += 1;
    st.lastLlmGoalAt = now;

    // 方向盘归 LLM：中止正在跑的自动计划，并清掉排队中的自动目标（在途动作会自然结束）
    if (st.plan && st.plan.source === 'auto') {
      this.trace.warn('auto_plan_yield', {
        companion: st.name,
        note: `${st.plan.id} ${st.plan.recipeId} 让位给 LLM，已中止`,
      });
      this.#finishPlan(st.plan, PlanStatus.ABANDONED, 'llm_takeover', { silent: true });
    }
    let cancelled = 0;
    for (const g of st.goals) {
      if (g.status !== GoalStatus.PENDING) continue;
      if (typeof g.note === 'string' && g.note.startsWith('auto:')) {
        g.status = GoalStatus.CANCELLED;
        g.endedAt = new Date().toISOString();
        g.lastResult = { reason: 'llm_takeover' };
        cancelled += 1;
      }
    }
    if (cancelled) {
      this.trace.info('auto_goals_yield', {
        companion: st.name,
        note: `LLM 接管，取消 ${cancelled} 个排队的自动目标`,
      });
    }
  }

  /** 清空接管预算（resume / stop / 新任务时用）。 */
  #resetDrive() {
    const st = this.state;
    st.driveStartedAt = null;
    st.driveGoals = 0;
    st.driveStopReason = null;
    st.lastLlmGoalAt = 0;
  }

  /**
   * 自止：LLM 连续驱动超过预算（时间或目标数）就自动停手，不做无限自动操作。
   * - 停手 = pause + 取消所有待执行 LLM 目标 + 中止 LLM 计划
   * - 上报 drive_stopped（needsBrain），写明用了多少秒/多少个目标
   * - 恢复：tree_control resume（重置预算）或 tree_task 重新下任务（新任务重置预算）
   */
  #maybeSelfStop() {
    const st = this.state;
    if (!st.driveStartedAt) return false;
    const d = this.cfg.drive || {};
    const elapsed = Date.now() - st.driveStartedAt;
    const maxMs = Number(d.maxSeconds ?? 150) * 1000;
    const maxGoals = Number(d.maxGoals ?? 10);
    const llmWork =
      st.goals.some(
        (g) => (g.status === 'pending' || g.status === 'running') && g.note === 'mcp',
      ) || (planAlive(st.plan) && st.plan.source === 'llm');

    // 没有活干并且安静够久 = 接管结束，回自动模式
    if (!llmWork) {
      if (Date.now() - (st.lastLlmGoalAt || 0) > Number(d.idleStopSeconds ?? 60) * 1000) {
        this.trace.info('drive_idle_end', {
          companion: st.name,
          note: `LLM 接管安静 ${Number(d.idleStopSeconds ?? 60)}s，结束接管会话`,
        });
        this.#resetDrive();
      }
      return false;
    }

    if (elapsed <= maxMs && st.driveGoals <= maxGoals) return false;

    // 超预算 → 自止
    st.paused = true;
    st.driveStopReason = `budget: ${Math.round(elapsed / 1000)}s / ${st.driveGoals} goals`;
    let cancelled = 0;
    for (const g of st.goals) {
      if ((g.status === 'pending' || g.status === 'running') && g.note === 'mcp') {
        g.status = GoalStatus.CANCELLED;
        g.endedAt = new Date().toISOString();
        g.lastResult = { reason: 'drive_budget' };
        cancelled += 1;
      }
    }
    if (planAlive(st.plan) && st.plan.source === 'llm') {
      this.#finishPlan(st.plan, PlanStatus.ABANDONED, 'drive_budget', { silent: true });
    }
    this.trace.warn('drive_stopped', {
      companion: st.name,
      note: `LLM 接管超预算（${Math.round(elapsed / 1000)}s / ${st.driveGoals} 个目标），已自动停手，取消 ${cancelled} 个待执行目标`,
    });
    this.inbox.push({
      kind: 'drive_stopped',
      companion: st.name,
      needsBrain: true,
      detail: {
        message: `LLM 接管连续操作 ${Math.round(elapsed / 1000)} 秒、${st.driveGoals} 个目标，已自动停手（预算 ${Math.round(maxMs / 1000)}s / ${maxGoals} 个）。`,
        cancelled,
        position: st.pos,
        hp: st.hp,
        hunger: st.hunger,
        hint:
          '这是防"无限自动操作"的自止。要接着干：tree_control resume（重置预算）或 tree_task 重新下任务；' +
          '想让它自己待着就什么都不用做（树回到自动生存模式）。',
        budget: {
          maxSeconds: Math.round(maxMs / 1000),
          maxGoals,
          usedSeconds: Math.round(elapsed / 1000),
          usedGoals: st.driveGoals,
        },
      },
    });
    return true;
  }

  /**
   * 大脑入口（MCP tree_task / 控制 API / 自动规则共用）：
   * 模糊意图 → 配方 → 建计划。同一时间只允许一个计划。
   */
  startPlan({ intent, source = 'llm', deadlineSeconds = null, overrides = {} }) {
    const st = this.state;
    if (!this.planner) return { ok: false, reason: 'planner_unavailable' };
    // LLM 的计划优先：正在跑的自动计划让位（在途动作会自然结束，不硬中断）
    if (source === 'llm' && st.plan && st.plan.source === 'auto') {
      this.trace.warn('auto_plan_yield', {
        companion: st.name,
        note: `${st.plan.id} ${st.plan.recipeId} 让位给 LLM 任务，已中止`,
      });
      this.#finishPlan(st.plan, PlanStatus.ABANDONED, 'llm_takeover', { silent: true });
    }
    if (planAlive(st.plan)) {
      return { ok: false, reason: 'busy', plan: planView(st.plan) };
    }
    const byId = this.planner.recipes.find((r) => r.id === intent);
    const m = byId ? { recipe: byId, why: `配方 id ${intent}` } : this.planner.match(intent);
    if (m.error) {
      return {
        ok: false,
        reason: 'no_recipe',
        tried: String(intent ?? ''),
        available: this.planner.listRecipes(),
      };
    }
    const plan = this.planner.build(m.recipe, { intent, source, deadlineSeconds, overrides });
    // LLM 任务 = 一次新接管：重置预算（自止后也能被显式新任务重新开启）
    if (source === 'llm') {
      if (st.paused && st.driveStopReason) st.paused = false;
      this.#resetDrive();
      this.noteLlmActivity();
    }
    st.plan = plan;
    st.planHistory = [plan, ...(st.planHistory || [])].slice(0, 5);
    this.trace.info('plan_start', {
      companion: st.name,
      note: `${plan.id} ${plan.recipeId}「${plan.intent}」source=${source} why=${m.why}`,
    });
    this.inbox.push({
      kind: 'plan_started',
      companion: st.name,
      needsBrain: false,
      detail: { plan: planView(plan), why: m.why },
    });
    return {
      ok: true,
      plan: {
        ...planView(plan),
        steps: plan.steps.map((s) => ({ as: s.as, skill: s.skill, type: s.type })),
      },
      recipe: { id: m.recipe.id, title: m.recipe.title },
      why: m.why,
    };
  }

  /** 中断表求值：命中就挂起计划、派中断动作/计划。 */
  #maybeInterrupt() {
    const st = this.state;
    // 已经有中断动作在排队/执行：不要叠第二个（否则一次威胁会连派两次 retreat）
    const busyInterrupt = st.goals.some(
      (g) =>
        (g.status === 'pending' || g.status === 'running') &&
        typeof g.note === 'string' &&
        g.note.startsWith('interrupt:'),
    );
    if (busyInterrupt) return false;
    // 全局最小间隔：刚派过一次中断动作，别马上再派第二个（防"连派两次撤退"）
    const anyGap = Number(this.cfg.behavior?.interruptGlobalCooldownSeconds ?? 5) * 1000;
    if (Date.now() - (st.lastAnyInterruptAt || 0) < anyGap) return false;
    const activeIds = st.goals
      .filter((g) => g.status === 'pending' || g.status === 'running')
      .map((g) => (typeof g.note === 'string' && g.note.startsWith('interrupt:') ? g.note.slice(10) : null))
      .filter(Boolean);
    const hit = pickInterrupt({ state: st, cfg: this.cfg, now: Date.now(), activeInterruptIds: activeIds });
    if (!hit) return false;
    const it = hit.entry;
    st.lastInterruptAt[it.id] = Date.now();
    st.lastAnyInterruptAt = Date.now();

    // 计划类中断（夜里回家）：只有在没有计划在跑时才能"整个配方"执行；
    // 已有计划时退化成一条兜底目标（例如先回主人身边），不去抢第二个计划槽。
    if (it.plan && !planAlive(st.plan)) {
      const r = this.startPlan({ intent: it.plan, source: 'auto' });
      if (r.ok) {
        this.trace.warn('interrupt', { companion: st.name, note: `${it.id}: ${hit.why} -> 计划 ${r.plan.id} ${r.recipe.id}` });
        return true;
      }
      this.trace.warn('interrupt_plan_failed', {
        companion: st.name,
        note: `${it.id} 想开计划 ${it.plan} 但失败：${r.reason}`,
      });
      if (!it.goal && !it.halt) return true;
    }

    // 停手类（stuck）：上报并停一段
    if (it.halt) {
      if (planAlive(st.plan)) this.#finishPlan(st.plan, PlanStatus.ABANDONED, `interrupt:${it.id}`, { silent: true });
      this.trace.warn('interrupt', { companion: st.name, note: `${it.id}: ${hit.why}（停手等大脑）` });
      const haltMs = Number(this.cfg.behavior?.survival?.starvingHaltSeconds ?? 240) * 1000;
      st.survivalHaltedUntil = Date.now() + haltMs;
      this.#escalate(it.escalate || 'stuck', {
        message: hit.why,
        interrupt: it.id,
        position: st.pos,
        dimension: st.dimension,
        ownerPosition: st.ownerPos,
        ownerDistance: st.ownerDistance,
        hp: st.hp,
        hunger: st.hunger,
        hint: '树已停手等你处置。卡住常见原因：掉坑/水里/被方块埋住/过不了水。',
        haltSeconds: Math.round(haltMs / 1000),
      });
      this.#speak('task_failed', { reason: '卡住了' });
      return true;
    }

    // 有具体动作要派：先按 resume 策略处理当前计划
    let planNote = '';
    if (planAlive(st.plan)) {
      planNote = `（计划 ${st.plan.recipeId} 第 ${(st.plan.stepResults || []).length + 1} 步被抢占）`;
      if ((it.resume || 'resume') === 'abandon') {
        this.#finishPlan(st.plan, PlanStatus.ABANDONED, `interrupt:${it.id}`, { silent: true });
      } else {
        suspendPlan(st.plan, it.id);
        if ((it.resume || 'resume') === 'restart') st.planRestartRequested = true;
      }
    }

    if (it.goal) {
      this.trace.warn('interrupt', { companion: st.name, note: `${it.id}: ${hit.why}${planNote}` });
      const goal = makeGoal({
        skill: it.goal.skill,
        params: it.goal.params || {},
        priority: Number(it.priority ?? 90),
        note: `interrupt:${it.id}`,
      });
      st.pushGoal(goal);
      return true;
    }
    return true;
  }

  /** 计划推进：恢复挂起 / doneWhen / 派下一步 / 处理 report 步。返回 true 表示本 tick 有事做。 */
  #planControl() {
    const st = this.state;
    const plan = st.plan;
    if (!planAlive(plan)) return false;

    // 挂起中：等中断动作跑完、并且槽/观测恢复正常，才恢复
    if (plan.status === PlanStatus.SUSPENDED) {
      const pendingInterrupt = st.goals.some(
        (g) =>
          (g.status === 'pending' || g.status === 'running') &&
          typeof g.note === 'string' &&
          g.note.startsWith('interrupt:'),
      );
      if (pendingInterrupt || st.actionLock) return true;
      // slot_blocked / timeout 挂起的：观测还在被拒就先别动（docs/12 §3.1）
      if ((plan.suspendedBy === 'slot_blocked' || plan.suspendedBy === 'timeout') && (st.slotBlocked ?? 0) > 0) {
        return true;
      }
      // 刚挂起不到 2 秒，先让状态稳定一下
      if (plan.suspendedAt && Date.now() - Date.parse(plan.suspendedAt) < 2000) return true;
      resumePlan(plan);
      if (st.planRestartRequested) {
        st.planRestartRequested = false;
        plan.cursor = plan.steps[0]?.as ?? null;
        plan.visits = plan.cursor ? { [plan.cursor]: 1 } : {};
      }
      this.trace.info('plan_resume', { companion: st.name, note: `${plan.id} ${plan.recipeId} 恢复` });
    }

    // doneWhen：条件满足 = 计划正常结束（例如"守到天亮"）。
    // 注意：计划刚建好时还没跑任何一步，不能立刻用 doneWhen 收尾——先让它动起来。
    const recipe = this.planner?.recipes.find((r) => r.id === plan.recipeId);
    const doneWhen = plan.doneWhen || recipe?.doneWhen;
    if (doneWhen && plan.stepResults.length > 0) {
      try {
        if (doneWhen(st, this.cfg)) {
          this.#finishPlan(plan, PlanStatus.DONE, 'done_when');
          return true;
        }
      } catch {
        /* 条件写坏了就当没满足 */
      }
    }

    const step = currentStep(plan);
    if (!step) {
      this.#finishPlan(plan, PlanStatus.DONE, 'no_more_steps');
      return true;
    }

    // 非技能步：report（试过了不行，上报并结束）
    if (step.type === 'report') {
      this.#finishPlan(plan, PlanStatus.FAILED, step.escalate || 'report', { silent: true });
      this.#escalate(step.escalate || 'plan_failed', {
        message: step.params?.message || '计划走不通',
        plan: planView(plan),
        position: st.pos,
        hp: st.hp,
        hunger: st.hunger,
        foodCount: st.foodCount,
        animalCount: st.animalCount,
        hint: '计划自己走不通，树已停手等大脑决定下一步。',
      });
      if (step.escalate === 'starving') {
        st.survivalHaltedUntil =
          Date.now() + Number(this.cfg.behavior?.survival?.starvingHaltSeconds ?? 240) * 1000;
        this.#speak('hungry');
      }
      return true;
    }

    // 技能步：把 params 解析成目标
    const built = this.#buildStepGoal(plan, step);
    if (built.fail) {
      const outcome = { ok: false, kind: built.failKind || 'not_found', message: built.message || '' };
      const decision = decideAfterStep(plan, step, outcome);
      this.#applyPlanDecision(plan, step, decision, outcome);
      return true;
    }
    st.currentPlanStep = step.as;
    st.pushGoal(built.goal);
    return true;
  }

  /** 步骤 → 目标；解析 params.place（地点簿名字 → 坐标）。 */
  #buildStepGoal(plan, step) {
    const st = this.state;
    const params = { ...(step.params || {}) };
    if (params.place) {
      const name = params.place;
      delete params.place;
      const m = this.places?.find(name, { dimension: st.dimension, near: st.pos }) || null;
      if (!m || !m.place || !m.place.pos) {
        return { fail: true, failKind: 'not_found', message: `地点簿里找不到「${name}」` };
      }
      params.target = { x: m.place.pos.x, y: m.place.pos.y, z: m.place.pos.z };
      if (params.range == null) params.range = 4;
    }
    const goal = makeGoal({ skill: step.skill, params, priority: 10, note: `step:${plan.id}:${step.as}` });
    goal.planId = plan.id;
    goal.stepAs = step.as;
    return { goal };
  }

  /** 应用计划决策（推进/重试/挂起/结束/上报）。 */
  #applyPlanDecision(plan, step, decision, outcome) {
    const st = this.state;
    this.trace.info('plan_step', {
      companion: st.name,
      note: `${plan.recipeId}/${step.as} ok=${!!outcome.ok}${outcome.ok ? '' : ':' + (outcome.kind || '')} -> ${decision.kind}${decision.label ? ':' + decision.label : ''}`,
    });
    // 阶段通知：不叫醒大脑
    this.inbox.push({
      kind: 'plan_stage',
      companion: st.name,
      needsBrain: false,
      detail: {
        planId: plan.id,
        recipeId: plan.recipeId,
        step: step.as,
        ok: !!outcome.ok,
        kind: outcome.kind ?? null,
        next: decision.kind === 'advance' || decision.kind === 'retry' ? decision.label : null,
        ms: outcome.ms ?? null,
      },
    });

    switch (decision.kind) {
      case 'advance':
      case 'retry':
        return; // 下一 tick #planControl 派下一步
      case 'suspend':
        suspendPlan(plan, decision.by || 'blocked');
        this.trace.warn('plan_suspended', {
          companion: st.name,
          note: `${plan.recipeId} 因 ${decision.by} 挂起，等槽空/观测恢复`,
        });
        return;
      case 'plan_done':
        this.#finishPlan(plan, PlanStatus.DONE, decision.reason);
        return;
      case 'report': {
        const escalate = decision.escalate || 'plan_failed';
        this.#finishPlan(plan, PlanStatus.FAILED, decision.reason, { silent: true });
        // 报告预算（docs/12 §3.2）：求助类（starving）必须叫醒；其它按计划来源，auto 只通知
        const waken = escalate === 'starving' ? true : plan.source === 'llm';
        this.#escalate(escalate, {
          message: `计划 ${plan.recipeId} 走不通：${decision.reason}`,
          plan: planView(plan),
          position: st.pos,
          hp: st.hp,
          hunger: st.hunger,
          foodCount: st.foodCount,
          animalCount: st.animalCount,
          hint: '计划已停，等大脑决定下一步。',
        }, { needsBrain: waken });
        if (escalate === 'starving') {
          st.survivalHaltedUntil =
            Date.now() + Number(this.cfg.behavior?.survival?.starvingHaltSeconds ?? 240) * 1000;
          this.#speak('hungry');
        }
        return;
      }
      case 'fail':
      default:
        this.#finishPlan(plan, PlanStatus.FAILED, decision.reason || 'step_failed', { silent: true });
        // 报告预算（docs/12 §3.2）：LLM 的计划失败叫醒大脑；自动计划失败只通知（可拉）
        this.#escalate('plan_failed', {
          message: `计划 ${plan.recipeId} 在步骤 ${step.as} 失败：${decision.reason}`,
          plan: planView(plan),
          position: st.pos,
          hp: st.hp,
          hunger: st.hunger,
          hint: '计划已停，等大脑决定下一步。',
        }, { needsBrain: plan.source === 'llm' });
        return;
    }
  }

  /** 结束计划（清槽、取消该计划残留的步骤目标、记账、按来源决定叫不叫醒大脑）。 */
  #finishPlan(plan, status, reason, { silent = false } = {}) {
    const st = this.state;
    if (!plan || st.plan !== plan) return;
    const view = planView(plan);
    finishPlan(plan, status, reason);
    st.plan = null;
    st.currentPlanStep = null;
    // 该计划还没执行的步骤目标一律作废，别留在队列里
    let cancelled = 0;
    for (const g of st.goals) {
      if (g.status === GoalStatus.PENDING && typeof g.note === 'string' && g.note.startsWith(`step:${plan.id}:`)) {
        g.status = GoalStatus.CANCELLED;
        g.endedAt = new Date().toISOString();
        g.lastResult = { reason: 'plan_finished' };
        cancelled += 1;
      }
    }
    this.trace.info('plan_end', {
      companion: st.name,
      note: `${view.id} ${view.recipeId} ${status}${reason ? ' ' + reason : ''}${cancelled ? `（取消 ${cancelled} 个残留步骤）` : ''}`,
    });
    if (silent) return; // 失败/上报由调用方负责，避免同一次失败报两遍
    const isDone = status === PlanStatus.DONE;
    this.inbox.push({
      kind: isDone ? 'plan_done' : 'plan_failed',
      companion: st.name,
      // 完成 = 通知（拉）；失败 = 求助（推，只有 LLM 的计划才叫醒）
      needsBrain: !isDone && plan.source === 'llm',
      detail: { ...view, reason: reason ?? null, status },
    });
  }

  /** 计划一步结束：记录结果 → 推进/重试/挂起/上报，并顺手更新世界记忆。 */
  #onPlanStep(goal, outcome, ms) {
    const st = this.state;
    const plan = st.plan;
    if (!plan || plan.id !== goal.planId) return;
    const step = plan.steps.find((s) => s.as === goal.stepAs);
    if (!step) return;
    try {
      this.#rememberFromStep(goal, outcome);
    } catch (e) {
      this.trace.warn('worldmem_failed', { companion: st.name, note: String(e?.message || e) });
    }
    const result = { ...outcome, ms };
    const decision = decideAfterStep(plan, step, result);
    // feed 计划的失败统一升级成 starving（文案/停手在 applyPlanDecision 里）
    if (decision.kind === 'report' && plan.recipeId === 'feed') decision.escalate = 'starving';
    if (decision.kind === 'fail' && plan.recipeId === 'feed') {
      decision.kind = 'report';
      decision.escalate = 'starving';
    }
    this.#applyPlanDecision(plan, step, decision, result);
  }

  /** 世界记忆：把技能结果里的事实记下来（容器内容 / 资源点）。M1 只做最小集。 */
  #rememberFromStep(goal, outcome) {
    const st = this.state;
    const wm = this.worldmem;
    if (!wm || !outcome?.ok) return;
    const d = outcome.data || {};
    if (goal.skill === 'store_items' && d.chest && d.chest.x != null) {
      wm.rememberContainer({
        dimension: st.dimension,
        pos: d.chest,
        contents: Array.isArray(d.contents) ? d.contents : [],
        note: '存东西时顺手记的',
        companion: st.name,
      });
      this.trace.info('worldmem_container', {
        companion: st.name,
        note: `${Math.round(d.chest.x)},${Math.round(d.chest.y)},${Math.round(d.chest.z)}`,
      });
    }
    if (goal.skill === 'dig_nearby' && st.pos) {
      wm.rememberResource({
        kind: 'wood',
        dimension: st.dimension,
        pos: st.pos,
        note: `挖过 ${goal.params?.block ?? '资源'}`,
      });
    }
  }

  // ── 日程（M1.5）：时段 → 允许做什么；规则在 schedule.mjs，这里只查表 ──

  /** 地点簿里的"家"坐标（没有/不合法返回 null）。 */
  #homePos() {
    const st = this.state;
    const name = this.cfg.leash?.placeName || '家';
    const m = this.places?.find?.(name, { dimension: st.dimension }) || null;
    const pos = m?.place?.pos;
    if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return null;
    return { x: pos.x, y: pos.y, z: pos.z };
  }

  /**
   * 选当前时段段并记到 state（纯查表，不做价值判断）。
   * 时段只影响"自动行为"；LLM 显式下的目标不受影响。
   */
  #updateSchedule() {
    const st = this.state;
    if (this.cfg.behavior?.schedule?.enabled === false) {
      this.seg = OFF_SEGMENT;
      st.schedule = {
        id: OFF_SEGMENT.id,
        title: OFF_SEGMENT.title,
        hasHome: false,
        leashMaxDistance: null,
        nightGuard: false,
      };
      return;
    }
    const home = this.#homePos();
    const seg = pickSegment(st, { hasHome: !!home });
    this.seg = seg;
    st.schedule = {
      id: seg.id,
      title: seg.title,
      hasHome: !!home,
      leashMaxDistance: seg.leash?.maxDistance ?? null,
      // 夜间日程接管守家时，night_danger 中断不再抢计划槽（见 interrupts.mjs）
      nightGuard: seg.id === 'night' && seg.guard?.enabled !== false,
    };
    if (this.#lastScheduleId !== seg.id) {
      this.#lastScheduleId = seg.id;
      st.idleSince = Date.now();
      this.trace.info('schedule', {
        companion: st.name,
        note: `${seg.id}「${seg.title}」${st.dark ? '天黑' : '天亮'}`
          + `，牵引绳≤${seg.leash?.maxDistance ?? this.cfg.leash?.maxDistance ?? 32}`
          + `${st.schedule.nightGuard ? '，守家模式' : ''}`,
      });
    }
  }

  /**
   * 仲裁器：空闲时按**规则表**决定"下一步做什么"。
   *
   * 设计边界（不许破坏）：
   *  - 只查表 + 固定规则，不做价值判断、不发明目标；
   *  - 每条行为有独立冷却，避免打转；
   *  - 规则从上往下，第一条成立的胜出；命中的规则和理由写进 trace，永远可复查。
   *
   * 顺序：求生（血/饿 → 吃 → 猎 → 找 → 报）→ 模式行为（战斗/生产）→ 牵引绳（#tick 里）。
   */
  async #arbitrate() {
    const st = this.state;
    const b = this.cfg.behavior || {};
    const now = Date.now();
    const seg = this.seg || OFF_SEGMENT;
    const allowKey = (key) => allow(seg, key);

    // 报过"要饿死了"就先停手等大脑（边界 6：报了 = 已经停手等你）。
    // 但"吃"永远不被停：万一包里有吃的了（大脑投放/自己捡到），该吃还得吃。
    const halted = now < (st.survivalHaltedUntil || 0);

    const ready = (key, def) =>
      now - (st.lastAutoAt?.[key] || 0) >= Number(b.cooldowns?.[key] ?? def) * 1000;
    const push = (key, skill, params, priority, why) => {
      st.lastAutoAt[key] = now;
      const goal = makeGoal({ skill, params, priority, note: `auto:${key}` });
      st.pushGoal(goal);
      this.trace.info('auto_action', {
        companion: st.name,
        note: `${key}(${why}) -> ${skill} ${JSON.stringify(params)}`,
      });
    };

    const hp = st.hp ?? 20;
    const hunger = st.hunger ?? 20;
    const hpPct = Math.round((hp / 20) * 100);
    const s = b.survival || {};
    const hasFood = (st.foodCount ?? 0) > 0;
    const animals = st.animalCount ?? 0;

    // ── 求生：安全判断在 interrupts.mjs（中断表），这里只决定"该不该开始找吃的" ──
    const panicPct = Number(s.panicHpPercent ?? 60);
    const calm = (st.hostileCount ?? 0) === 0 || hpPct > 80;

    if (!halted && calm) {
      const wantFeed =
        hunger <= Number(s.eatHunger ?? 6) ||
        (hunger <= Number(s.forageHunger ?? 12) && !hasFood) ||
        (hpPct <= panicPct && hasFood && hunger < Number(s.healHunger ?? 18));
      if (wantFeed) {
        const started = this.startPlan({ intent: 'feed', source: 'auto' });
        if (started.ok) {
          this.trace.info('auto_plan', {
            companion: st.name,
            note: `feed(hunger ${hunger}, food ${st.foodCount ?? 0}, hp ${hpPct}%) -> ${started.plan.id} ${started.recipe.title}`,
          });
          return;
        }
      }
    }

    // 重伤 + 没吃的 + 附近安全：回主人身边（要保护、等人给吃的）
    if (
      hpPct <= panicPct &&
      !hasFood &&
      (st.hostileCount ?? 0) === 0 &&
      st.ownerOnline &&
      (st.ownerDistance ?? 999) > Number(s.regroupDistance ?? 8) &&
      allowKey('regroup') &&
      ready('regroup', 30)
    ) {
      push('regroup', 'approach_owner', { range: 4, chunkSeconds: 8, maxChunks: 4 }, 44,
        `hp ${hpPct}%、没食物、附近安全，回主人身边`);
      return;
    }

    // ── 日程：白天自动开工（候选与冷却全部来自 schedule.mjs 的 work）──
    // 只在 survival 模式自动开工；combat/production 是 LLM 显式选的行为，不在这里管。
    if (st.mode === 'survival' && allowKey('dayWork') && !halted) {
      for (const w of seg.work || []) {
        if (w.requires === 'pickaxe' && !hasTool(st.inventory, 'pickaxe')) continue;
        // 装备兜底：有武器就不需要 bootstrap（死亡重生后没武器才会走）
        if (w.requires === 'no_weapon' && st.weapon) continue;
        // 采集工具缺了才补（镐+斧都有就跳过 craft_tools）
        if (
          w.requires === 'missing_tool' &&
          hasTool(st.inventory, 'pickaxe') &&
          hasTool(st.inventory, 'axe')
        ) {
          continue;
        }
        const autoKey = `work:${w.key || w.recipe}`;
        if (!ready(autoKey, Number(w.cooldownSeconds ?? 120))) continue;
        const started = this.startPlan({ intent: w.recipe, source: 'auto' });
        if (started.ok) {
          st.lastAutoAt[autoKey] = now;
          this.trace.info('auto_plan', {
            companion: st.name,
            note: `${autoKey} -> ${started.plan.id} ${started.recipe.title}`,
          });
          return;
        }
        if (started.reason !== 'busy') {
          this.trace.warn('auto_work_failed', {
            companion: st.name,
            note: `${autoKey} 开计划失败：${started.reason}`,
          });
        }
      }
    }

    // ── 日程：夜间守卫（敌对进入守家半径 → 有武器、血够才打）──
    if (allowKey('guard') && seg.guard?.enabled !== false) {
      const g = seg.guard;
      const hostiles = st.hostileCount ?? 0;
      const near = st.hostileDistance != null && st.hostileDistance <= Number(g.radius ?? 10);
      const healthOk = hpPct >= Number(g.minHpPercent ?? 55);
      const weaponOk = !g.requireWeapon || !!st.weapon;
      if (hostiles > 0 && near && healthOk && weaponOk && ready('guard', Number(g.cooldownSeconds ?? 15))) {
        const c = b.combat || {};
        push('guard', g.skill || 'fight_safe',
          {
            radius: Number(g.radius ?? 10) + 6,
            minHp: Number(s.retreatHp ?? 8),
            maxTargets: Number(c.maxTargets ?? 2),
            fleeDistance: Number(s.fleeDistance ?? 16),
          },
          Number(g.priority ?? 40),
          `夜间守卫：敌对 ${st.hostileDistance} 格、hp ${hpPct}%`);
        return;
      }
    }

    // ── 日程：夜间巡逻（家里没威胁 → 绕"家"走一个路点；每段都回仲裁，可随时被中断）──
    if (allowKey('patrol') && seg.patrol?.enabled !== false) {
      const p = seg.patrol;
      const home = this.#homePos();
      const noThreat = (st.hostileCount ?? 0) === 0 && st.hostileDistance == null;
      const weaponOk = !p.requireWeapon || !!st.weapon;
      if (home && noThreat && weaponOk && ready('patrol', Number(p.intervalSeconds ?? 25))) {
        const target = patrolTarget(seg, { homePos: home, index: st.patrolIndex ?? 0 });
        st.patrolIndex = (Number(st.patrolIndex ?? 0) + 1) % 8;
        if (target) {
          push('patrol', 'go_to', { target, range: Number(p.range ?? 2) },
            Number(p.priority ?? 15), '夜间巡逻：家里没威胁，绕一圈');
          return;
        }
      }
    }

    // ── 模式规则 ────────────────────────────────────────────
    // 血低/被围的"撤"由 interrupts.mjs 统一处理（任何模式都生效），这里只管打不打。
    if (st.mode === 'combat' && allowKey('combat')) {
      const c = b.combat || {};
      const hostiles = st.hostileCount ?? 0;
      const hdist = st.hostileDistance;
      const attackPct = Number(c.attackHpPercent ?? 60);
      const maxTargets = Number(c.maxTargets ?? 2);

      if (hostiles > 0) {
        // 没武器且敌人已经近了：别硬上
        if (!st.weapon) {
          const near = Number(c.noWeaponFleeDistance ?? 10);
          if (hdist != null && hdist <= near && ready('retreat', 20)) {
            push('retreat', 'retreat', { distance: Number(s.fleeDistance ?? 16) }, 60,
              `没有武器，敌对距 ${hdist} 格 <= ${near}`);
          }
          return;
        }
        // 血够 + 有武器：打（技能内部还有"打不过就跑"的守卫）
        if (hpPct > attackPct && ready('fight', 10)) {
          push('fight', 'fight_safe',
            {
              radius: Number(c.radius ?? 16),
              minHp: Number(s.retreatHp ?? 8),
              maxTargets,
              fleeDistance: Number(s.fleeDistance ?? 16),
            }, 30, `hp ${hpPct}% 有武器 ${st.weapon}`);
        }
      }
      return;
    }

    if (st.mode === 'production' && allowKey('production')) {
      if (ready('gather', 30)) {
        // 连续几次都找不到资源 → 先出去探一段
        if ((st.gatherFails ?? 0) >= 4) {
          st.gatherFails = 0;
          push('explore', 'explore', { seconds: 30 }, 15, 'production:找不到资源，出去探');
          return;
        }
        const blocks = b.production?.blocks?.length
          ? b.production.blocks
          : [b.production?.block ?? 'minecraft:oak_log'];
        const i = (st.gatherIndex ?? 0) % blocks.length;
        st.gatherIndex = (i + 1) % blocks.length;
        push(
          'gather',
          'dig_nearby',
          {
            block: blocks[i],
            count: Number(b.production?.count ?? 8),
            radius: Number(b.production?.radius ?? 32),
          },
          20,
          `production:${blocks[i]}`,
        );
      }
      return;
    }

    // survival 模式：不主动做事，靠牵引绳 + 待命
  }

  /**
   * 牵引绳：离**锚点**太远就自己回去。
   *
   * 锚点是动态的（LLM/主人可以切）：
   *  - tether='owner'：绑主人，跟着走（主人死了重生很远时会追过去，仅在这个模式）
   *  - tether='home'（默认）：绑地点簿里的"家"，主人死远/跑远都不跟，自己回基地待着
   *
   * 只在"没有其它目标"时生效；失败退避 15→30→60→120 秒，连续 3 次才报一次 stuck。
   */
  #leashAnchor() {
    const st = this.state;
    const l = this.cfg.leash || {};
    const want = st.tether === 'owner' ? 'owner' : 'home';

    if (want === 'owner') {
      if (!st.ownerOnline || st.ownerDistance == null) return null;
      return { kind: 'owner', distance: st.ownerDistance, label: '主人' };
    }

    // home：从地点簿取"家"的坐标；没记就退回主人（并在 trace 里说明）
    const name = l.placeName || '家';
    const m = this.places?.find(name, { dimension: st.dimension }) || null;
    if (!m?.place?.pos) {
      if (st.ownerOnline && st.ownerDistance != null) {
        return { kind: 'owner', distance: st.ownerDistance, label: `主人（地点簿没记「${name}」）` };
      }
      return null;
    }
    if (!st.pos) return null;
    const pos = m.place.pos;
    const d = Math.hypot(st.pos.x - pos.x, st.pos.z - pos.z);
    return { kind: 'home', target: { x: pos.x, y: pos.y, z: pos.z }, distance: d, label: `家「${name}」` };
  }

  async #maybeLeash() {
    const l = this.cfg.leash;
    if (!l?.enabled) return;

    const st = this.state;
    if (st.paused) return;

    // 上报过"卡住了"：停手等大脑，别再试
    const now = Date.now();
    if (st.leashHaltedUntil && now < st.leashHaltedUntil) return;

    const anchor = this.#leashAnchor();
    if (!anchor) return;
    // 牵引绳最大距离随时段变（日程表 leash.maxDistance；没写就用配置默认）
    const max = Number(this.seg?.leash?.maxDistance ?? l.maxDistance ?? 32);
    if (anchor.distance <= max) return;

    // 队列里已经有回家的目标，就别重复加
    if (st.goals.some((g) => g.status === 'pending' && g.note === 'leash')) return;

    // 失败退避：按连续失败次数指数拉长间隔
    const fails = st.autoFails?.leash ?? 0;
    const baseMs = Number(l.minIntervalSeconds ?? 15) * 1000;
    const gapMs = Math.min(
      baseMs * 2 ** fails,
      Number(l.maxIntervalSeconds ?? 120) * 1000,
    );
    if (now - st.lastLeashAt < gapMs) return;
    st.lastLeashAt = now;

    // 绑主人 → 分段追踪（目标动态刷新）；绑家 → 固定坐标 go_to
    const isOwnerAnchor = anchor.kind === 'owner';
    const goal = makeGoal({
      skill: isOwnerAnchor ? l.skill ?? 'approach_owner' : 'go_to',
      params: isOwnerAnchor
        ? { ...(l.params || {}), range: l.params?.range ?? 4 }
        : { target: anchor.target, range: 4 },
      priority: Number(l.priority ?? 5),
      note: 'leash',
    });
    goal.leashAnchor = anchor.kind;
    st.pushGoal(goal);

    this.trace.info('leash', {
      companion: st.name,
      note: `离${anchor.label} ${Math.round(anchor.distance)} 格 > ${max}，加目标 ${goal.id} ${goal.skill}${fails > 0 ? `（失败后退避到 ${Math.round(gapMs / 1000)}s）` : ''}`,
    });
    if (isOwnerAnchor) this.#speak('leash_return', { dist: Math.round(anchor.distance) });
    this.inbox.push({
      kind: 'leash',
      companion: st.name,
      needsBrain: false,
      detail: {
        message: `离${anchor.label} ${Math.round(anchor.distance)} 格，超过 ${max}，已自动${isOwnerAnchor ? '往回走' : '回家附近待着'}。`,
      },
    });
  }

  // ── 僵尸锁外部清理（补丁 v3 的 127.0.0.1:8768）────────────

  /**
   * 自动清锁：连续被拒到阈值（默认 2 次）就调补丁清一次。
   * 冷却期内不重试（补丁没装/游戏没重启时，避免每 tick 打 HTTP）。
   */
  async #maybeAutoUnlock() {
    const st = this.state;
    const rc = this.cfg.behavior?.lockRecovery || {};
    if (rc.enabled === false || !this.lockfix) return false;
    const threshold = Math.max(1, Number(rc.unlockAfterBlocked ?? 2));
    if (st.slotBlocked < threshold) return false;
    const gapMs = Math.max(5, Number(rc.minIntervalSeconds ?? 30)) * 1000;
    if (Date.now() - this.#lastUnlockAt < gapMs) return false;
    this.#lastUnlockAt = Date.now();
    const r = await this.#doUnlock({ all: false, auto: true });
    return !!r?.ok;
  }

  /** 手动清锁（CLI / 控制 API / MCP tree_control op=unlock 用）。 */
  async unlockNow({ all = false } = {}) {
    this.#lastUnlockAt = Date.now();
    return this.#doUnlock({ all, auto: false });
  }

  async #doUnlock({ all = false, auto = false } = {}) {
    const st = this.state;
    if (!this.lockfix) {
      return { ok: false, error: 'lockRecovery 未启用 / 没有补丁客户端' };
    }
    const r = await this.lockfix.unlock(all ? { all: true } : { uuid: st.id });
    const cleared = Number(r?.cleared || 0);
    if (r?.ok && cleared > 0) {
      this.trace.warn('lock_unlock', {
        companion: st.name,
        note: `${auto ? '自动' : '手动'}清锁成功：cleared=${cleared}（第 ${st.slotBlocked} 次被拒，未重建同伴）`,
      });
      this.inbox.push({
        kind: 'lock_unlock',
        companion: st.name,
        needsBrain: false, // 通知：已自动恢复，不需要大脑决策
        detail: {
          message: `Lua 槽被补丁外部清理（cleared=${cleared}），同伴不用重建、背包没丢。`,
          auto,
          attempts: st.slotBlocked,
        },
      });
      return { ok: true, cleared, patch: r.patch ?? null };
    }
    if (r?.ok && cleared === 0 && !auto) {
      // 手动清锁时表里本来就没有：这不是错误，告诉调用方"当前没锁"
      this.trace.info('lock_unlock_noop', { companion: st.name, note: '当前没有该同伴的锁（无需清理）' });
      return { ok: true, cleared: 0, noop: true, patch: r.patch ?? null };
    }
    this.trace.warn('lock_unlock_failed', {
      companion: st.name,
      note: `${auto ? '自动' : '手动'}清锁失败：${r?.ok ? `补丁在线但 cleared=${cleared}` : (r?.error || '补丁无响应')}`,
    });
    return { ok: false, error: r?.ok ? `补丁在线但没清到这个同伴的锁（cleared=${cleared}）` : r?.error || '补丁无响应', patch: r?.patch ?? null };
  }

  /** 补丁状态（诊断用）：{ok, patch, foundClass, count, running[]} */
  async lockStatus() {
    if (!this.lockfix) return { ok: false, error: 'lockRecovery 未启用 / 没有补丁客户端' };
    return this.lockfix.status();
  }

  /**
   * 状态重置：换档 / 重进世界 / 与会话重建时调用。
   * 铁律：上一局的目标、位置、任务一律作废，不带着走。
   */
  #resync(reason, detail = {}) {
    const st = this.state;
    const cleared = st.goals.filter(
      (g) => g.status === 'pending' || g.status === 'running',
    ).length;

    st.cancelAll(reason);
    st.pos = null;
    st.hp = null;
    st.hunger = null;
    st.gameTime = null;
    st.taskStatus = null;
    st.detachedTask = null;
    st.current = null;
    st.foodCount = null;
    st.foodKinds = 0;
    st.weapon = null;
    st.weaponScore = 0;
    st.animalCount = 0;
    st.animalDistance = null;
    st.animalType = null;
    st.autoFails = {};
    st.starvingSince = null;
    st.survivalHaltedUntil = 0;
    st.leashHaltedUntil = 0;
    st.lastLeashAt = 0;
    st.schedule = null;
    st.patrolIndex = 0;
    // 上一局的计划一律作废（不带着走）
    st.plan = null;
    st.currentPlanStep = null;
    st.lastInterruptAt = {};
    st.stuckSince = null;
    st.planRestartRequested = false;
    st.lastAction = null;
    st.dark = false;
    st.lastHeartbeatAt = null;
    st.lastEventAt = {};
    st.slotBlocked = 0;
    st.slotBlockedSince = null;
    st.slotBlockedNotified = 0;
    st.consecutiveFailures = 0;
    this.#lastObserveAt = 0;

    // 同伴可能有新 id（换档/重生），异步刷新，不阻塞
    this.numen
      .listCompanions()
      .then(({ companions }) => {
        const me = companions.find((c) => c.name === st.name);
        if (me && me.id !== st.id) {
          this.trace.info('companion_id_refreshed', {
            companion: st.name,
            note: `${st.id} → ${me.id}`,
          });
          st.id = me.id;
        }
        if (!me) {
          this.trace.warn('companion_missing', { companion: st.name });
          this.inbox.push({
            kind: 'companion_missing',
            companion: st.name,
            needsBrain: true,
            detail: {
              message: '当前世界里找不到这个同伴（可能换档后还没召唤回来）。',
              hint: '先 list_companions 确认；需要的话让主人召回来。',
            },
          });
        }
      })
      .catch(() => {});

    this.trace.warn(reason, {
      companion: st.name,
      note: `${detail.note ?? ''}（清掉 ${cleared} 个待办目标）`,
    });

    this.inbox.push({
      kind: reason,
      companion: st.name,
      needsBrain: true,
      detail: {
        message:
          reason === 'world_changed'
            ? '世界变了（换档/重进），上一局的目标、坐标、任务全部作废。'
            : '与游戏的连接重建过（游戏可能重启了），同伴状态已重置。',
        hint: '重新确认同伴在哪、要做什么，再下新的目标。不要去接上一局的事。',
        clearedGoals: cleared,
        ...detail,
      },
    });
  }

  /**
   * 快观测：只采危险相关的字段（hp/敌对/主人位置/天黑/任务），默认 1.2 秒一次。
   * 慢变量（背包/食物/猎物/武器）走 #maybeObserve，默认 3.6 秒一次。
   */
  async #maybeObserveFast() {
    const st = this.state;
    const now = Date.now();
    const gap = Math.max(500, Number(this.cfg.loop?.observeFastMs ?? 1200));
    if (now - this.#lastFastObserveAt < gap) return;
    if (st.actionLock || st.slotBlocked >= 2) return;
    this.#lastFastObserveAt = now;
    try {
      const r = await this.numen.lua(st.name, OBSERVE_FAST_LUA, 15_000);
      const raw = String(r.raw ?? r.message ?? '');
      if (/a program is already running/i.test(raw)) return;
      let v = r.value;
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          /* keep */
        }
      }
      if (!v || typeof v !== 'object') return;
      st.hp = v.hp;
      st.hunger = v.hunger;
      st.pos = { x: v.x, y: v.y, z: v.z };
      st.dimension = v.dim;
      st.gameTime = v.game_time;
      st.ownerOnline = !!v.owner_online;
      st.ownerDistance = v.owner_dist;
      st.ownerPos = { x: v.owner_x, y: v.owner_y, z: v.owner_z };
      st.hostileCount = v.hostile_n ?? 0;
    noteObservation(this.exec);
    st.lastObservedAt = this.exec.lastObservedAt;
      st.hostileDistance = v.hostile_d;
      st.dark = !!v.dark;
      st.taskStatus = v.task_id
        ? {
            task_id: v.task_id,
            task: v.task,
            state: v.task_state,
            elapsed_s: v.elapsed_s,
            budget_left_s: v.budget_left_s,
          }
        : null;
      st.lastFastObserveAt = now;
    } catch {
      // 安静失败：慢观测会处理"槽被占/连接断了"的上报
    }
  }

  async #maybeObserve() {
    const st = this.state;
    // 被别的驱动者占着槽时降低观测频率，免得每 3 秒刷一次失败
    const minGap =
      st.slotBlocked >= 2
        ? 15000
        : Math.max(1000, Number(this.cfg.loop?.observeSlowMs ?? Math.max(3000, this.cfg.loop.tickMs * 3)));
    if (Date.now() - this.#lastObserveAt < minGap) return;
    this.#lastObserveAt = Date.now();

    st.actionLock = true;
    try {
      const r = await this.numen.lua(st.name, OBSERVE_LUA, 20_000);
      const raw = String(r.raw ?? r.message ?? '');

      // 另一个驱动者 / 僵尸锁占着这个同伴的 Lua 槽
      if (/a program is already running/i.test(raw)) {
        // 先区分："内置脑/本能" vs "程序遗留（僵尸锁）"。
        // 补丁 /status count=0 说明 ServerPrograms 里没有我们的程序 → 是内置脑在动 → 让路，不清锁。
        if (this.lockfix) {
          try {
            const patch = await this.lockfix.status();
            if (patch && patch.ok !== false && Number(patch.count ?? 0) === 0) {
              const holdMs = Number(this.cfg.behavior?.instinctHoldSeconds ?? 8) * 1000;
              st.instinctBusyUntil = Math.max(st.instinctBusyUntil || 0, Date.now() + holdMs);
              st.lastReflexAt = Date.now();
              if (Date.now() - (st.lastInstinctTraceAt || 0) > 10_000) {
                st.lastInstinctTraceAt = Date.now();
                this.trace.info('instinct_busy', {
                  companion: st.name,
                  note: '内置脑/本能在占用 Lua 槽（补丁 count=0）→ 树让路等待，不硬刹',
                });
              }
              this.#lastObserveAt = 0; // 让路结束后尽快重试
              return;
            }
          } catch {
            // 补丁不可用：按旧逻辑（可能是僵尸锁/其它驱动者）处理
          }
        }
        st.slotBlocked += 1;

        // 外部清锁（补丁 v3 的 127.0.0.1:8768）：报错到阈值就清一次，不用重建同伴、不丢背包。
        // 清理成功后直接 return（下一 tick 立刻重新观测）；清理失败再走原来的上报/降频路径。
        if (await this.#maybeAutoUnlock()) {
          st.slotBlocked = 0;
          st.slotBlockedSince = null;
          st.slotBlockedNotified = 0;
          this.#lastObserveAt = 0;
          return;
        }

        if (st.slotBlocked === 3) {
          st.slotBlockedSince = new Date().toISOString();
          st.slotBlockedNotified = 1;
          this.trace.warn('slot_blocked', {
            companion: st.name,
            note: '另一个驱动者占着 Lua 槽，树无法行动',
          });
          this.inbox.push({
            kind: 'slot_blocked',
            companion: st.name,
            needsBrain: true,
            detail: {
              message: '同伴的 Lua 执行槽被占用，树无法行动。',
              hint:
                '三种可能：① 还有别的会话/内置脑在驱动同一个同伴；② 换过存档，旧程序残留成僵尸锁；③ 上一个长任务还没结束。' +
                '先关掉其它驱动者。若持续不恢复，树会再报一次并给处置建议。',
              consecutive: st.slotBlocked,
            },
          });
        } else if (
          st.slotBlockedNotified === 1 &&
          st.slotBlockedSince &&
          Date.now() - Date.parse(st.slotBlockedSince) > 60000
        ) {
          st.slotBlockedNotified = 2;
          const seconds = Math.round((Date.now() - Date.parse(st.slotBlockedSince)) / 1000);
          this.trace.warn('slot_blocked_persistent', {
            companion: st.name,
            note: `Lua 槽被占 ${seconds} 秒，建议处置`,
          });
          this.inbox.push({
            kind: 'slot_blocked_persistent',
            companion: st.name,
            needsBrain: true,
            detail: {
              message: `同伴的 Lua 槽被占用已超过 ${seconds} 秒，仍未恢复。`,
              evidence: `连续被拒 ${st.slotBlocked} 次；期间没有任何一次成功观测。`,
              how_to_tell: '看游戏日志里最新的 [numen-program] 行时间：如果远早于现在却仍被拒，就是僵尸锁，不是有人在驱动。',
              suggestion:
                '两个处置方案，二选一：' +
                '①【推荐】彻底重启 Minecraft —— 最干净，不丢东西；' +
                '② 删掉重建同伴 —— 立刻恢复，但背包/护甲/饰品会全部掉落、实体 id 会变。',
              recovery: {
                option_restart_game: '彻底退出 Minecraft 再启动（不是只换存档）',
                option_rebuild_companion: {
                  risk: '背包/护甲/饰品全部掉落，实体 id 改变',
                  steps: [
                    '重要的话先用 memory 记下要紧的事（重建后笔记可能丢）',
                    'delete_companion(name)',
                    'create_companion(同名)',
                    'list_companions 拿新 id',
                    '重新用 tree_status 确认树已接管',
                  ],
                },
              },
              note: '树不会自动执行删除重建——这个决定要你或者主人来做。',
            },
          });
        }
        return;
      }

      if (st.slotBlocked > 0) {
        const seconds = st.slotBlockedSince
          ? Math.round((Date.now() - Date.parse(st.slotBlockedSince)) / 1000)
          : null;
        this.trace.info('slot_unblocked', {
          companion: st.name,
          note: `恢复（此前连续被拒 ${st.slotBlocked} 次${seconds ? `，持续 ${seconds}s` : ''}）`,
        });
        this.inbox.push({
          kind: 'slot_unblocked',
          companion: st.name,
          needsBrain: false,
          detail: { message: 'Lua 槽已恢复，树可以继续执行。' },
        });
      }
      st.slotBlocked = 0;
      st.slotBlockedSince = null;
      st.slotBlockedNotified = 0;

      let v = r.value;
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          /* keep */
        }
      }
      if (!v || typeof v !== 'object') {
        this.trace.warn('observe_bad_shape', {
          companion: st.name,
          note: `${r.kind}: ${String(r.raw ?? r.message ?? '').slice(0, 200)}`,
        });
        return;
      }
      // 世界时间大幅回退 = 换档 / 重进世界
      if (st.gameTime != null && v.game_time != null && v.game_time < st.gameTime - 1200) {
        this.#resync('world_changed', {
          note: `世界时间回退 ${st.gameTime} → ${v.game_time}`,
          oldGameTime: st.gameTime,
          newGameTime: v.game_time,
        });
      }

      st.hp = v.hp;
      st.hunger = v.hunger;
      st.pos = { x: v.x, y: v.y, z: v.z };
      st.dimension = v.dim;
      st.gameTime = v.game_time;
      st.ownerOnline = !!v.owner_online;
      st.ownerDistance = v.owner_dist;
      st.ownerPos = { x: v.owner_x, y: v.owner_y, z: v.owner_z };
      st.hostileCount = v.hostile_n ?? 0;
    noteObservation(this.exec);
    st.lastObservedAt = this.exec.lastObservedAt;
      st.hostileDistance = v.hostile_d;
      st.dark = !!v.dark;
      // 觅食 / 战斗评估的感知
      st.foodCount = v.food ?? 0;
      st.foodKinds = v.food_kinds ?? 0;
      st.weapon = v.weapon ?? null;
      st.weaponScore = v.weapon_score ?? 0;
      st.held = v.held ?? null;
      st.animalCount = v.animal_n ?? 0;
      st.animalDistance = v.animal_d ?? null;
      st.animalType = v.animal_t ?? null;
      // 背包概览（给 LLM 挑方块/材料用；最多 24 种）
      st.inventory = Array.isArray(v.inv)
        ? v.inv
            .filter((x) => Array.isArray(x) && x.length === 2)
            .map(([item, count]) => ({ item: String(item), count: Number(count) || 0 }))
        : [];
      // 一旦包里有吃的，"要饿死了"的停手状态就解除（大脑给食/自己捡到都算）
      if ((st.foodCount ?? 0) > 0) st.survivalHaltedUntil = 0;
      st.taskStatus = v.task_id
        ? {
            task_id: v.task_id,
            task: v.task,
            state: v.task_state,
            elapsed_s: v.elapsed_s,
            budget_left_s: v.budget_left_s,
          }
        : null;
      if (!st.taskStatus) st.detachedTask = null;
    } catch (e) {
      // 连不上游戏时别刷屏：30 秒最多记一条
      const now = Date.now();
      if (now - this.#lastErrLogAt > 30000) {
        this.#lastErrLogAt = now;
        this.trace.warn('observe_failed', { companion: st.name, note: String(e?.message || e) });
      }
    } finally {
      st.actionLock = false;
    }
  }

  /** 默认行为表：命令盒空着时，按配置轮流做（MVP 默认关闭）。 */
  async #maybeIdle() {
    const idle = this.cfg.idle;
    if (!idle?.enabled || !idle.skills?.length) return;

    const st = this.state;
    const now = Date.now();
    if (now - st.lastIdleAt < (idle.cooldownSeconds ?? 30) * 1000) return;
    st.lastIdleAt = now;

    const pick = idle.skills[Math.floor(Math.random() * idle.skills.length)];
    const goal = makeGoal({ skill: pick.skill, params: pick.params, priority: -1, note: 'idle' });
    st.pushGoal(goal);
    this.trace.info('idle_goal', { companion: st.name, note: `${pick.skill}` });
  }

  // ── 执行一个目标 ──────────────────────────────────────────
  /**
   * 战术包执行（lane 集成 v1）：
   *  - 用 tactic-runner 跑一层战术包；原子边界检查安全中断（更高优先级 → preempted）；
   *  - 预算/熔断由 runner 兜底；硬中断类结果（preempted/timeout）后先 settle 再结束；
   *  - 与现有 skill 一样会占用本次 tick（原子 ≤15s），但安全中断在原子边界即可抢占。
   */
  async #runTacticGoal(goal) {
    const st = this.state;
    const tacticId = goal.params?.tactic;
    const tacticParams = goal.params?.params ?? {};
    goal.startedAt = new Date().toISOString();
    goal.attempts += 1;
    if (!tacticId) {
      goal.status = GoalStatus.FAILED;
      goal.endedAt = new Date().toISOString();
      goal.lastResult = { ok: false, kind: 'bad_argument', message: '缺少 params.tactic' };
      this.trace.warn('tactic_failed', { companion: st.name, note: `${goal.id} 缺 tactic` });
      return;
    }
    st.actionLock = true;
    st.current = { goalId: goal.id, skill: `tactic:${tacticId}`, startedAt: new Date().toISOString() };
    st.lastHeartbeatAt = Date.now();
    goal.status = GoalStatus.RUNNING;
    st.tactic = { id: tacticId, atom: null, priorityClass: goal.priorityClass ?? null, startedAt: new Date().toISOString() };
    const started = Date.now();
    const goalPriority = Number(goal.priority ?? 30);

    const executeAtom = async (atomId, params) => {
      // 原子边界安全中断：更高优先级的中断 → 让 runner 结束本战术（下一 tick 走中断）。
      // 例外：settle 是急刹后的清理动作，必须允许执行（否则会被同一个中断再次抢占）。
      if (atomId !== 'atom.settle') {
        const activeIds = st.goals
          .filter(
            (g) =>
              (g.status === 'pending' || g.status === 'running') &&
              typeof g.note === 'string' &&
              g.note.startsWith('interrupt:'),
          )
          .map((g) => g.note.slice(10));
        const hit = pickInterrupt({ state: st, cfg: this.cfg, now: Date.now(), activeInterruptIds: activeIds });
        if (hit && Number(hit.entry?.priority ?? 0) > goalPriority) {
          return { ok: false, kind: 'preempted', msg: `interrupt:${hit.entry.id}` };
        }
      }
      let built;
      try {
        built = buildAtom(atomId, params);
      } catch (e) {
        return { ok: false, kind: 'bad_atom', msg: String(e?.message ?? e).slice(0, 300) };
      }
      st.tactic.atom = atomId;
      try {
        const r = await this.numen.lua(st.name, built.code, built.timeoutMs + 5_000);
        let v = r?.value;
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            v = { ok: false, kind: 'bad_result', msg: String(v).slice(0, 200) };
          }
        }
        if (r?.kind === 'returned' && v && typeof v === 'object' && 'ok' in v) return v;
        return {
          ok: false,
          kind: r?.kind === 'returned' ? 'bad_result' : (r?.kind ?? 'error'),
          msg: String(r?.message ?? r?.raw ?? '').slice(0, 300),
        };
      } catch (e) {
        return { ok: false, kind: 'error', msg: String(e?.message ?? e).slice(0, 300) };
      }
    };

    let res;
    try {
      res = await runTactic(tacticId, tacticParams, { executeAtom });
    } catch (e) {
      res = { ok: false, kind: 'error', message: String(e?.message ?? e), atoms: 0 };
    }
    // 被抢占/超时/急刹 = 危险证据 → 执行档位降级 + 冷却（即使当下看着安全）
    noteInterrupt(this.exec, res.kind);
    if (needsSettle(res.kind)) {
      // timeout/slot_blocked/detached：游戏里可能还有程序在跑 → 先用补丁急刹，再 settle
      if (this.lockfix && ['timeout', 'slot_blocked', 'detached'].includes(String(res.kind))) {
        try {
          await this.lockfix.unlock({ uuid: st.id });
        } catch {
          // 补丁不在线时降级：下面 settle 会尽量 task.stop
        }
        await sleep(300);
      }
      try {
        await runSettle(executeAtom);
      } catch {
        // settle 失败不改变原结果；由上报/下一 tick 处理
      }
    }
    const ms = Date.now() - started;
    st.actionLock = false;
    st.current = null;
    st.tactic = null;
    st.lastHeartbeatAt = Date.now();
    st.lastActionAt = Date.now();
    st.lastAction = {
      skill: `tactic:${tacticId}`,
      goalId: goal.id,
      ok: res.ok === true,
      kind: res.kind ?? 'ok',
      message: res.message ?? '',
      ms,
      at: new Date().toISOString(),
    };
    goal.endedAt = new Date().toISOString();
    if (res.ok) {
      goal.status = GoalStatus.DONE;
      goal.lastResult = { ok: true, tactic: tacticId, atoms: res.atoms, ms };
      this.trace.info('tactic_done', {
        companion: st.name,
        note: `${goal.id} ${tacticId} ok atoms=${res.atoms} ${ms}ms`,
      });
    } else {
      goal.status = GoalStatus.FAILED;
      goal.lastResult = { ok: false, kind: res.kind, message: res.message, tactic: tacticId, atoms: res.atoms, ms };
      this.trace.warn('tactic_failed', {
        companion: st.name,
        note: `${goal.id} ${tacticId} ${res.kind} atoms=${res.atoms} ${ms}ms: ${res.message ?? ''}`,
      });
    }
  }

  async #runGoal(goal) {
    const st = this.state;
    // 战术包目标：skill='tactic'，params={tactic, params}；由 tactic-runner 一次跑多个原子，
    // 原子边界会检查安全中断（见 #runTacticGoal），预算/熔断在 runner 内。
    if (goal.skill === 'tactic') {
      return this.#runTacticGoal(goal);
    }
    const skill = getSkill(goal.skill);

    if (!skill) {
      goal.status = GoalStatus.FAILED;
      goal.endedAt = new Date().toISOString();
      goal.lastResult = { ok: false, kind: 'unknown_skill' };
      this.#escalate('skill_failed', {
        goalId: goal.id,
        skill: goal.skill,
        kind: 'unknown_skill',
        message: `没有这个技能：${goal.skill}`,
      });
      return;
    }

    st.actionLock = true;
    st.current = { goalId: goal.id, skill: goal.skill, startedAt: new Date().toISOString() };
    st.lastHeartbeatAt = Date.now(); // 技能里会 arm 一个 task.timer 定时上报，这里先记发车时间
    goal.status = GoalStatus.RUNNING;
    goal.startedAt = new Date().toISOString();
    goal.attempts += 1;

    let built;
    try {
      built = skill.build({ state: st, cfg: this.cfg, places: this.places }, goal.params);
    } catch (e) {
      st.actionLock = false;
      st.current = null;
      goal.status = GoalStatus.FAILED;
      goal.lastResult = { ok: false, kind: 'build_error', message: String(e) };
      this.#escalate('skill_failed', { goalId: goal.id, skill: goal.skill, kind: 'build_error', message: String(e) });
      return;
    }

    this.trace.info('dispatch', {
      companion: st.name,
      note: `${goal.id} ${goal.skill} ${JSON.stringify(goal.params)}`,
    });

    const started = Date.now();
    let softMs = Number(built.timeoutMs ?? this.cfg.loop.actionTimeoutMs);
    // 自动行为（auto 计划步骤 / auto 单目标）的在途动作限时更短：
    // LLM 接管时最坏只等这么久；卡死动作也能更快进入"槽位被占→lockfix 清除"路径。
    // LLM 自己下的目标保持原预算（用户显式选择了长动作）。
    const isAutoGoal =
      (typeof goal.note === 'string' && goal.note.startsWith('auto:')) ||
      (goal.stepAs && st.plan && st.plan.source === 'auto');
    const autoCapMs = Math.max(10, Number(this.cfg.loop?.autoActionTimeoutSeconds ?? 60)) * 1000;
    if (isAutoGoal) softMs = Math.min(softMs, autoCapMs);
    st.current.budgetMs = softMs; // 供状态显示"自报预算"，超了就是可疑
    let r;
    try {
      // LLM 目标：客户端比技能自报预算多等 15 秒；自动动作只多等 5 秒（尽快把方向盘还给 LLM）
      r = await this.numen.lua(st.name, built.code, softMs + (isAutoGoal ? 5_000 : 15_000));
    } catch (e) {
      r = { kind: 'error', message: String(e) };
    } finally {
      st.actionLock = false;
      st.current = null;
      st.lastActionAt = Date.now();
    }
    const ms = Date.now() - started;

    // 解析结果
    let outcome;
    if (r.kind === 'returned') {
      let v = r.value;
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          /* 保持字符串 */
        }
      }
      if (v && typeof v === 'object' && 'ok' in v) {
        outcome = v.ok ? { ok: true, data: v } : { ok: false, kind: v.kind || 'failed', message: v.msg, hint: v.hint, data: v };
      } else {
        outcome = { ok: true, data: v };
      }
    } else if (r.kind === 'detached') {
      outcome = { ok: true, detached: true, taskId: r.taskId, message: r.message };
    } else if (r.kind === 'timeout') {
      // 等回执超时：游戏里的程序可能仍在跑。先别重派，交给下一轮观测。
      outcome = {
        ok: false,
        kind: 'timeout',
        message: r.message,
        hint: '程序可能还在后台跑；树会先观测槽位，恢复后再决定，不会重发同一件事。',
      };
    } else {
      const slotBlocked = /a program is already running/i.test(String(r.message ?? ''));
      outcome = {
        ok: false,
        kind: slotBlocked ? 'slot_blocked' : r.kind,
        message: r.message,
        hint: slotBlocked ? '另一个驱动者占着同伴，先解决冲突再重试' : undefined,
      };
    }

    goal.endedAt = new Date().toISOString();
    goal.lastResult = { ...outcome, ms };
    noteInterrupt(this.exec, outcome.kind);

    // 最近一次动作结果（供 tree_status / cli 显示"上一步干了啥"）
    const autoKey =
      typeof goal.note === 'string' && goal.note.startsWith('auto:')
        ? goal.note.slice(5)
        : null;
    st.lastAction = {
      skill: goal.skill,
      goalId: goal.id,
      ok: !!outcome.ok,
      kind: outcome.ok ? (outcome.detached ? 'detached' : 'ok') : outcome.kind,
      message: outcome.ok ? null : (outcome.message ?? null),
      ms,
      at: goal.endedAt,
    };

    // 分片动作：没做完但还有进展 → 续派下一段（下一 tick 会先跑中断检查，再执行）
    if (outcome.ok && outcome.data && outcome.data.partial) {
      const rounds = (goal.chunkRound || 0) + 1;
      const maxRounds = Number(this.cfg.behavior?.maxChunkRounds ?? 8);
      if (rounds > maxRounds) {
        outcome = {
          ok: false,
          kind: 'incomplete',
          message: `分片动作 ${goal.skill} 续了 ${maxRounds} 段还没做完`,
          data: outcome.data,
        };
      } else {
        goal.status = GoalStatus.DONE;
        const nextParams = { ...(goal.params || {}) };
        if (outcome.data.remaining != null) nextParams.count = Number(outcome.data.remaining);
        const cont = makeGoal({
          skill: goal.skill,
          params: nextParams,
          priority: goal.priority,
          note: goal.note,
        });
        cont.planId = goal.planId;
        cont.stepAs = goal.stepAs;
        cont.chunkRound = rounds;
        st.pushGoal(cont);
        this.trace.info('chunk_continue', {
          companion: st.name,
          note: `${goal.skill} 第 ${rounds} 段继续：${JSON.stringify(outcome.data).slice(0, 120)}`,
        });
        this.#lastObserveAt = 0;
        return;
      }
    }

    // 计划已结束/作废，但这一步还在收尾：只记账，不要再按"大脑目标"上报
    if (goal.stepAs && (!st.plan || st.plan.id !== goal.planId)) {
      goal.status = outcome.ok ? GoalStatus.DONE : GoalStatus.FAILED;
      this.trace.info('orphan_step', {
        companion: st.name,
        note: `${goal.planId}/${goal.stepAs} 计划已结束，忽略结果 ok=${!!outcome.ok}`,
      });
      this.#lastObserveAt = 0;
      return;
    }

    // ── 计划步骤：交给计划层推进，上报预算由计划来源决定 ──────────
    if (goal.stepAs && st.plan && st.plan.id === goal.planId) {
      // 先给这一步结账（否则队列里会留一堆"running"的幽灵目标）
      goal.status = outcome.ok
        ? outcome.detached
          ? GoalStatus.DETACHED
          : GoalStatus.DONE
        : GoalStatus.FAILED;
      if (outcome.ok) {
        st.stuckSince = null;
      } else if (
        outcome.kind === 'no_path' ||
        /can't stand|no path/i.test(String(outcome.message ?? ''))
      ) {
        st.stuckSince ??= Date.now(); // 卡住中断用
      }
      this.#onPlanStep(goal, outcome, ms);
      this.#lastObserveAt = 0;
      return;
    }

    if (outcome.ok) {
      st.consecutiveFailures = 0;
      st.stuckSince = null;
      if (autoKey) st.autoFails[autoKey] = 0;
      // 大脑给了目标并跑成了 = 求生的求助已解决，恢复自动行为
      st.survivalHaltedUntil = 0;
      goal.status = outcome.detached ? GoalStatus.DETACHED : GoalStatus.DONE;
      st.idleSince = Date.now();
      if (outcome.detached) st.detachedTask = { taskId: outcome.taskId, skill: goal.skill, at: goal.endedAt };
      this.trace.info('done', {
        companion: st.name,
        note: `${goal.id} ${goal.skill} ok in ${ms}ms${outcome.detached ? ` (detached ${outcome.taskId})` : ''}`,
      });
      // 报告预算（边界 #7：完成/通知 拉，求助 推）：
      // - 自动行为/中断/牵引绳：完成只留 trace，不进收件箱（否则全是噪音）
      // - LLM 下的目标：完成进收件箱当通知（needsBrain=false），想看由 LLM 主动拉
      const quiet =
        !!autoKey ||
        goal.note === 'leash' ||
        (typeof goal.note === 'string' && goal.note.startsWith('interrupt:'));
      if (!quiet) {
        this.inbox.push({
          kind: outcome.detached ? 'task_detached' : 'goal_done',
          companion: st.name,
          goalId: goal.id,
          skill: goal.skill,
          ms,
          data: outcome.data ?? null,
          needsBrain: false,
        });
      }
      // 机械播报（查表，不生成语言）
      if (goal.skill === 'go_to') this.#speak('arrived');
      if (goal.skill === 'dig_nearby') st.gatherFails = 0;
      if (goal.note === 'leash') st.autoFails.leash = 0; // 回到主人了，退避清零
    } else {
      st.consecutiveFailures += 1;
      goal.status = GoalStatus.FAILED;
      this.trace.warn('failed', {
        companion: st.name,
        note: `${goal.id} ${goal.skill} ${outcome.kind} after ${ms}ms: ${outcome.message ?? ''}`,
      });

      if (autoKey) {
        // 自动行为失败：树自己还能重试，先不惊动大脑（边界 6：自己还能处理的不报）。
        // 连续失败够多次才升成一次"规则级"求助。
        st.autoFails[autoKey] = (st.autoFails[autoKey] ?? 0) + 1;
        const reportAt = Number(this.cfg.behavior?.escalateAfterAutoFails ?? 3);
        if (st.autoFails[autoKey] >= reportAt) {
          st.autoFails[autoKey] = 0;
          this.#escalate('auto_action_failing', {
            rule: autoKey,
            skill: goal.skill,
            kind: outcome.kind,
            message: outcome.message,
            hint: outcome.hint,
            position: st.pos,
            hp: st.hp,
            hunger: st.hunger,
            foodCount: st.foodCount,
            animalCount: st.animalCount,
            note: `自动规则 ${autoKey} 连续失败 ${reportAt} 次，已加长冷却，等大脑决定要不要换法子。`,
          });
        }
      } else if (typeof goal.note === 'string' && goal.note.startsWith('interrupt:')) {
        // 中断动作失败：只留痕，不再刷大脑（安全动作下次中断/仲裁会兜住）
        this.trace.warn('interrupt_failed', {
          companion: st.name,
          note: `${goal.note} ${outcome.kind} ${String(outcome.message ?? '').slice(0, 90)}`,
        });
      } else if (goal.note === 'leash') {
        // 回主人失败：悄悄退避（间隔指数拉长），失败够 3 次才报一次 "stuck"
        st.autoFails.leash = (st.autoFails.leash ?? 0) + 1;
        this.trace.info('leash_failed', {
          companion: st.name,
          note: `回主人第 ${st.autoFails.leash} 次失败：${outcome.kind} ${String(outcome.message ?? '').slice(0, 90)}`,
        });
        const reportAt = Number(this.cfg.leash?.escalateAfterFails ?? 3);
        if (st.autoFails.leash >= reportAt) {
          st.autoFails.leash = 0;
          st.leashHaltedUntil =
            Date.now() + Number(this.cfg.leash?.haltSeconds ?? 180) * 1000;
          this.trace.warn('stuck', {
            companion: st.name,
            note: `离主人 ${Math.round(st.ownerDistance ?? 0)} 格，连续 ${reportAt} 次走不过去`,
          });
          this.#escalate('stuck', {
            message: '想回主人身边但一直走不过去，很可能卡住了 / 过不了水或地形。',
            position: st.pos,
            dimension: st.dimension,
            ownerPosition: st.ownerPos,
            ownerDistance: st.ownerDistance,
            lastError: outcome.message,
            hint:
              '树已停手等你 3 分钟。处置：① 过去把它挖出来/推上岸；' +
              '② 或 delete_companion + create_companion 重建（会掉背包，位置回到主人身边）；' +
              '③ 或先用 tree_place 把它现在的位置记成 poi，改天再去接。',
            haltSeconds: Number(this.cfg.leash?.haltSeconds ?? 180),
          });
          this.#speak('task_failed', { reason: '卡住了' });
        }
      } else {
        // 大脑下的目标失败：必须报（带事实字段，不给建议措辞）
        this.#escalate('skill_failed', {
          goalId: goal.id,
          skill: goal.skill,
          params: goal.params,
          kind: outcome.kind,
          message: outcome.message,
          hint: outcome.hint,
          position: st.pos,
          hp: st.hp,
          hunger: st.hunger,
          ms,
        });
        this.#speak('task_failed', { reason: KIND_WORDS[outcome.kind] ?? '没成' });
      }

      // 自动行为失败：把冷却往后推，避免每 30 秒撞一次同样的墙
      if (autoKey) {
        const key = autoKey;
        const base = Number(this.cfg.behavior?.cooldowns?.[key] ?? 30) * 1000;
        // gather 失败多半是"这附近没这种方块"，早点换下一种；其它行为多等一会
        const desired = key === 'gather' ? 6000 : base * 2;
        // ready() 判定是 now - lastAutoAt >= base，这里反推一个"上次尝试时间"
        st.lastAutoAt[key] = Date.now() - base + desired;
        if (key === 'gather') st.gatherFails = (st.gatherFails ?? 0) + 1;
        this.trace.info('auto_action_backoff', {
          companion: st.name,
          note: `${key} 失败，${Math.round(desired / 1000)}s 后再试`,
        });
      }
    }

    // 动作做完先重新观测一次再仲裁：否则仲裁器会拿"动作前"的旧数据决策
    // （典型症状：刚打完猎/走完路，又因为"没食物没猎物"再派一遍同样的活）
    this.#lastObserveAt = 0;
  }

  /**
   * 说一句台词。**只查表，不生成**：
   *   when → 台词库 → 冷却/权重 → 填槽 → say
   * 全局最小间隔由 cfg.lines.minGapSeconds 控制，避免刷屏。
   */
  #speak(when, slots = {}) {
    if (!this.lines || !this.lines.enabled) return;
    const st = this.state;
    if (st.paused) return;

    const minGap = Number(this.cfg.lines?.minGapSeconds ?? 8) * 1000;
    const now = Date.now();
    if (now - this.#lastSpeakAt < minGap) return;

    const line = this.lines.pick(when, slots);
    if (!line) return;

    this.#lastSpeakAt = now;
    this.trace.info('say_line', { companion: st.name, note: `${line.id}: ${line.text}` });
    Promise.resolve()
      .then(() => this.numen.say(st.name, line.text))
      .catch((e) =>
        this.trace.warn('say_line_failed', { companion: st.name, note: String(e?.message || e) }),
      );
  }

  // ── 事件循环（不占 Lua 槽）────────────────────────────────
  async #eventLoop() {
    while (!this.#stopped) {
      try {
        const { events } = await this.eventsClient.events(
          this.state.name,
          this.cfg.loop.eventWaitSeconds,
        );
        for (const ev of events) this.#handleEvent(ev);
      } catch (e) {
        const now = Date.now();
        if (now - this.#lastErrLogAt > 30000) {
          this.#lastErrLogAt = now;
          this.trace.warn('event_error', {
            companion: this.state.name,
            note: String(e?.message || e),
          });
        }
        await sleep(this.cfg.loop.eventBackoffMs);
      }
    }
  }

  #handleEvent(ev) {
    const st = this.state;

    if (ev.kind === 'owner_query') {
      this.trace.info('owner_query', { companion: st.name, note: ev.message });
      this.inbox.push({
        kind: 'owner_query',
        companion: st.name,
        text: ev.message,
        needsBrain: true,
      });
      return;
    }

    if (ev.kind === 'task_finished') {
      // 只有"树自己派出去的后台任务"才值得上报；mod reflex 自己的 move.go 收尾只留痕。
      // status 实测：'done' = 成功到达；'stopped' = 被更新的身体动作替换/取消（不是求助）。
      const mine = !!st.detachedTask && ev.id === st.detachedTask.taskId;
      if (mine) st.detachedTask = null;
      const ok = ev.status === 'done' || ev.status === 'completed';
      this.trace.info('task_finished', {
        companion: st.name,
        note: `${ev.id} ${ev.task} ${ev.status} ${ev.message}${mine ? '' : '（非树派发，仅留痕）'}`,
      });
      if (!mine) return;
      if (!ok) {
        this.#escalate('task_failed', {
          taskId: ev.id,
          task: ev.task,
          status: ev.status,
          message: ev.message,
        });
      } else {
        this.inbox.push({
          kind: 'task_done',
          companion: st.name,
          taskId: ev.id,
          task: ev.task,
          needsBrain: false, // 通知：完成靠拉，不叫醒
        });
      }
      return;
    }

    // 死亡：mod 会复活，但**死亡会打断在途程序**，可能留下僵尸锁。
    // 上报里直接给处置顺序，别让大脑猜。
    if (ev.kind === 'death') {
      st.deathAt = new Date().toISOString();
      // 手头的计划立即作废（人死了，步数/游标都不算数）
      if (planAlive(st.plan)) this.#finishPlan(st.plan, PlanStatus.ABANDONED, 'death', { silent: true });
      this.trace.warn('death', { companion: st.name, note: (ev.message ?? '').slice(0, 200) });

      // 自动把死亡地点记进地点簿（坐标取最后一次观测，可能差几格，note 里说明）
      let deathPlace = null;
      if (this.places && st.pos) {
        try {
          deathPlace = this.places.record({
            name: `死亡点 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
            kind: 'death',
            dimension: st.dimension,
            pos: st.pos,
            note: `死亡位置（最后一次观测坐标，可能有几格偏差）。${(ev.message ?? '').slice(0, 90)}`,
            source: 'tree',
            companion: st.name,
          });
          this.trace.info('place_recorded', {
            companion: st.name,
            note: `${deathPlace.id} ${deathPlace.name} @ ${Math.round(st.pos.x)},${Math.round(st.pos.y)},${Math.round(st.pos.z)}`,
          });
          // 每个同伴只保留最近一次死亡点：把该同伴更早的死亡记录删掉
          try {
            const stale = this.places
              .list({ kind: 'death' })
              .filter((p) => p.companion === st.name && p.id !== deathPlace.id);
            for (const p of stale) this.places.forget(p.id);
            if (stale.length) {
              this.trace.info('death_place_pruned', {
                companion: st.name,
                note: `删掉 ${stale.length} 条更早的死亡点`,
              });
            }
          } catch (e) {
            this.trace.warn('death_place_prune_failed', { companion: st.name, note: String(e?.message || e) });
          }
        } catch (e) {
          this.trace.warn('place_record_failed', { companion: st.name, note: String(e?.message || e) });
        }
      }

      this.#escalate('death', {
        message: '同伴死了（mod 会自动复活）。',
        detail: ev.message,
        position: st.pos,
        deathPlace: deathPlace ? { id: deathPlace.id, name: deathPlace.name, pos: deathPlace.pos } : null,
        hint:
          '如果随后出现「Lua 槽被占且长时间不恢复」，说明客户端死在 lua 调用途中（不是死亡本身）：' +
          '① 用 delete_companion + create_companion 重建同伴（实测能清锁、不用重启游戏）；' +
          '② 不行再彻底重启 Minecraft。不要反复重派动作。',
      });
      this.#speak('death');
      return;
    }

    // 主人挨打 / 主人有危险：记一笔，中断表会据此决定"去帮忙/自保"
    if (ev.kind === 'owner_hurt' || /owner is in DANGER|危险/i.test(String(ev.message ?? ''))) {
      st.ownerDangerAt = Date.now();
      this.trace.info('owner_danger', {
        companion: st.name,
        note: `${ev.kind} ${String(ev.message ?? '').slice(0, 120)}`,
      });
      // 不单独上报：15 秒内若真需要动作，中断表会派护主；动作结果会走正常上报
      return;
    }

    // 长任务心跳：技能里用 numen.task.timer 定的定时器，触发时走这里
    if (ev.kind === 'timer') {
      st.lastHeartbeatAt = Date.now();
      this.trace.info('heartbeat', {
        companion: st.name,
        note: `${st.current?.skill ?? '?'} ${ev.message ?? ''}`.slice(0, 120),
      });
      return;
    }

    // 本能让路：numen 核心反射（Flee/MobDefense/Unstuck/MLG/Breath）由 mod 自己执行，
    // 树收到 reflex 事件后暂停派动作一段时间，等本能做完再继续（不抢槽）。
    if (ev.kind === 'reflex') {
      const holdMs = Number(this.cfg.behavior?.instinctHoldSeconds ?? 8) * 1000;
      st.instinctBusyUntil = Math.max(st.instinctBusyUntil || 0, Date.now() + holdMs);
      st.lastReflexAt = Date.now();
      // 本能出手 = 环境不安全的直接证据 → 执行档位立即降级
      const modeBeforeReflex = this.exec.mode;
      noteRisk(this.exec, 'reflex', st.lastReflexAt);
      st.execMode = this.exec.mode;
      st.execReason = this.exec.reason;
      st.execSince = this.exec.since;
      if (modeBeforeReflex !== this.exec.mode) {
        this.trace.info('exec_mode', {
          companion: st.name,
          note: `${modeBeforeReflex} -> ${this.exec.mode}（${this.exec.reason}）`,
        });
      }
      this.trace.info('instinct_busy', {
        companion: st.name,
        note: `reflex: ${String(ev.message ?? '').slice(0, 120)}（树让路 ${Math.round(holdMs / 1000)}s）`,
      });
    }

    // 机械播报：只按事件查台词表，不生成
    if (ev.kind === 'hungry') this.#speak('hungry');
    else if (ev.kind === 'reflex') this.#speak('fled');

    // 高频事件去重：同一个 kind 在冷却窗口内只进一次收件箱/trace，
    // 否则 reflex 这种会每秒刷一条，把收件箱和日志淹掉。
    const nowE = Date.now();
    st.lastEventAt ??= {};
    const dedupeMs = Number(this.cfg.loop.eventDedupeSeconds ?? 20) * 1000;
    const prevAt = st.lastEventAt[ev.kind] || 0;
    st.lastEventAt[ev.kind] = nowE;
    if (nowE - prevAt < dedupeMs) {
      st.eventSuppressed = (st.eventSuppressed || 0) + 1;
      return;
    }

    this.trace.info('event', { companion: st.name, note: `${ev.kind} ${ev.message ?? ''}`.slice(0, 200) });
    this.inbox.push({ kind: ev.kind || 'event', companion: st.name, text: ev.message, needsBrain: false });
  }

  #escalate(kind, detail, { needsBrain = null } = {}) {
    const st = this.state;
    // 同类求助静默窗口：窗口内重复的只当通知（不叫醒），避免连续死亡/卡住把大脑刷爆
    const winMs = Number(this.cfg.behavior?.escalateDedupeSeconds ?? 300) * 1000;
    st.lastEscalateAt ??= {};
    st.escalateRepeat ??= {};
    const now = Date.now();
    const last = st.lastEscalateAt[kind] || 0;
    const repeated = now - last < winMs;
    if (repeated) {
      st.escalateRepeat[kind] = (st.escalateRepeat[kind] || 0) + 1;
    } else {
      st.lastEscalateAt[kind] = now;
      st.escalateRepeat[kind] = 0;
    }
    this.inbox.push({
      kind,
      companion: st.name,
      detail: repeated
        ? { ...detail, note: `${kind} 在 ${Math.round(winMs / 1000)}s 内重复（第 ${st.escalateRepeat[kind]} 次），只当通知` }
        : detail,
      // 调用方可显式指定叫不叫醒（auto 计划失败只通知）；没指定就按"求助"默认叫醒
      needsBrain: repeated ? false : needsBrain == null ? true : !!needsBrain,
    });
  }
}

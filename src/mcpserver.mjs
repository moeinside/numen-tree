import http from 'node:http';
import crypto from 'node:crypto';
import { inferKind, normalizeKind, distanceBetween, normalizeText } from './places.mjs';

const PROTOCOL_VERSION = '2025-06-18';

/**
 * 树对 LLM 的 MCP 工具面。
 *
 * 设计纪律：
 *  - 工具少（当前 10 个），每个都粗粒度；
 *  - 返回的是"压缩过后的事实"，不是原始数据；
 *  - 只有 tree_wait 是长轮询，其余都是瞬时返回。
 */
export function createTreeMcpServer({
  host,
  port,
  lanes,
  inbox,
  trace,
  numen,
  skills,
  places,
  startTask,
}) {
  const sessions = new Set();

  /**
   * 进度可见性辅助：**只读 CompanionState 已有字段**，不新增记账。
   *
   * 长任务期间观测循环被占住（actionLock），taskStatus 会一直是旧值，
   * 看起来像"卡住"。所以用 current.startedAt / goals[].createdAt /
   * slotBlockedSince 这些时间戳现算秒数，让调用方知道"它还在动"。
   */
  const secondsSince = (iso, nowMs = Date.now()) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.round((nowMs - t) / 1000));
  };

  /**
   * 上一动作：优先用 state.lastAction（lane 记账，最准）；
   * 老/中间状态没有时退回"goals 里最后一条有 lastResult 的项"。
   */
  const lastActionOf = (st) => {
    const a = st.lastAction;
    if (a && typeof a === 'object') {
      return {
        goal: a.goalId ?? null,
        skill: a.skill ?? null,
        ok: !!a.ok,
        kind: a.kind ?? null,
        message: a.message ?? null,
        ms: a.ms ?? null,
        at: a.at ?? null,
      };
    }
    const g = [...st.goals].reverse().find((x) => x.lastResult);
    if (!g) return null;
    const r = g.lastResult;
    return {
      goal: g.id,
      skill: g.skill,
      ok: !!r.ok,
      kind: r.kind ?? null,
      message: r.message ?? null,
      ms: r.ms ?? null,
      at: g.endedAt ?? null,
    };
  };

  const progressOf = (st, nowMs = Date.now()) => {
    const current = st.current || null;
    const pending = st.goals.filter((g) => g.status === 'pending' || g.status === 'running');
    return {
      current_skill: current?.skill ?? null,
      current_goal_id: current?.goalId ?? null,
      running_seconds: current?.startedAt ? secondsSince(current.startedAt, nowMs) : null,
      budget_seconds: current?.budgetMs ? Math.round(Number(current.budgetMs) / 1000) : null,
      heartbeat_seconds: st.lastHeartbeatAt ? secondsSince(st.lastHeartbeatAt, nowMs) : null,
      last_action: lastActionOf(st),
      pending_goals: pending.map((g) => ({
        id: g.id,
        skill: g.skill,
        priority: g.priority,
        status: g.status,
        waited_seconds: secondsSince(g.createdAt, nowMs),
      })),
      slot_blocked_seconds: st.slotBlockedSince ? secondsSince(st.slotBlockedSince, nowMs) : null,
    };
  };

  const lastActionText = (a) =>
    a ? `上一步 ${a.skill}${a.ok ? ' 成功' : ` 失败：${a.kind ?? a.message ?? '未知'}`}` : '';

  // ── 计划（M1）辅助：数据来自 lane.state.plan（形如 docs/12 §2.1）────────
  /** 把内部 plan 归一成对外的紧凑形态；没有计划返回 null。 */
  const planOf = (st) => {
    const raw = st?.plan;
    if (!raw || typeof raw !== 'object') return null;
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    return {
      id: raw.id ?? null,
      recipeId: raw.recipeId ?? raw.recipe?.id ?? null,
      title: raw.title ?? raw.recipeTitle ?? raw.recipe?.title ?? null,
      cursor: raw.cursor ?? null,
      status: raw.status ?? null,
      steps_done:
        raw.steps_done ?? (Array.isArray(raw.stepResults) ? raw.stepResults.length : null),
      steps_total: raw.steps_total ?? (steps.length || null),
      suspendedBy: raw.suspendedBy ?? null,
      startedAt: raw.startedAt ?? null,
    };
  };

  /** 计划一句话："计划 砍木头存箱子 第 2/共 4 步（当前步 home）"；没有计划返回 ''。 */
  const planText = (pl) => {
    if (!pl) return '';
    const title = pl.title ?? pl.recipeId ?? '未命名计划';
    let s = `计划 ${title}`;
    if (pl.steps_done != null && pl.steps_total != null) {
      s += ` 第 ${pl.steps_done}/共 ${pl.steps_total} 步`;
    } else if (pl.steps_done != null) {
      s += ` 已完成 ${pl.steps_done} 步`;
    }
    if (pl.cursor) s += `（当前步 ${pl.cursor}）`;
    if (pl.status && pl.status !== 'active') {
      s +=
        pl.status === 'suspended'
          ? `，已挂起${pl.suspendedBy ? `（${pl.suspendedBy}）` : ''}`
          : `，${pl.status}`;
    }
    return s;
  };

  /** 一句话说人话：正在做什么 / 空闲时什么状态 / 为什么看起来没动。 */
  const summaryOf = (st, p) => {
    const head = p.current_skill
      ? `${st.name} 正在 ${p.current_skill}（已 ${p.running_seconds ?? 0} 秒）`
      : st.paused
        ? `${st.name} 已暂停`
        : st.taskStatus
          ? `${st.name} 正在执行任务 ${st.taskStatus.task}（${st.taskStatus.state}，${st.taskStatus.elapsed_s}s）`
          : st.detachedTask
            ? `${st.name} 后台 ${st.detachedTask.skill}（${st.detachedTask.taskId}）进行中`
            : `${st.name} 空闲`;
    const bits = [head];
    const planSentence = planText(planOf(st));
    if (planSentence) bits.push(planSentence);
    const last = lastActionText(p.last_action);
    if (last) bits.push(last);
    const waiting = p.pending_goals.filter((g) => g.status === 'pending');
    if (waiting.length) {
      const maxWait = Math.max(...waiting.map((g) => g.waited_seconds ?? 0));
      bits.push(`队列还有 ${waiting.length} 个目标（最久等待 ${maxWait} 秒）`);
      const llmWaiting = waiting.filter((g) => g.note === 'mcp').length;
      if (llmWaiting) bits.push(`其中 LLM 目标 ${llmWaiting} 个在等当前动作（会先跑完手上这个）`);
    }
    if (!p.current_skill) {
      // 空闲时给"为什么没事干"的事实：饿不饿、有没有吃的/武器、附近有没有猎物
      bits.push(
        `饥饿 ${st.hunger ?? '?'}${st.foodCount != null ? `（食物 ${st.foodCount} 份）` : ''}`,
      );
      bits.push(`武器 ${st.weapon ? String(st.weapon).replace(/^minecraft:/, '') : '无'}`);
      if ((st.animalCount ?? 0) > 0) {
        bits.push(
          `附近猎物 ${st.animalCount} 只${st.animalType ? `（${st.animalType}）` : ''}`,
        );
      }
      if (st.tether) {
        bits.push(`牵引绳 ${st.tether === 'owner' ? '跟主人' : '绑家'}`);
      }
      bits.push(`模式 ${st.mode}`);
    }
    if (p.slot_blocked_seconds != null) bits.push(`Lua 槽被占 ${p.slot_blocked_seconds} 秒`);
    if (
      p.current_skill &&
      p.budget_seconds &&
      (p.running_seconds ?? 0) > p.budget_seconds
    ) {
      bits.push(
        `⚠️ 已超自报预算（${p.running_seconds}s > ${p.budget_seconds}s），可能卡住；不要急着再派同一件事`,
      );
    }
    return bits.join('，');
  };

  const summaryLine = (st) => {
    const p = progressOf(st);
    const pos = st.pos ? `${st.pos.x.toFixed(1)},${st.pos.y.toFixed(1)},${st.pos.z.toFixed(1)}` : '?';
    // 任务行以 current 为准：观测循环被长任务占住时 taskStatus 可能是旧值/空
    const task = p.current_skill
      ? `执行中 ${p.current_skill}(已 ${p.running_seconds ?? 0}s)`
      : st.taskStatus
        ? `${st.taskStatus.task}(${st.taskStatus.state},${st.taskStatus.elapsed_s}s)`
        : st.detachedTask
          ? `后台 ${st.detachedTask.skill}(${st.detachedTask.taskId})`
          : '空闲';
    const queue = st.goals.filter((g) => g.status === 'pending' || g.status === 'running');
    const blocked = st.slotBlocked >= 3 ? ` | ⚠️ Lua槽被占用(${st.slotBlocked}次)` : '';
    const last = p.last_action
      ? ` | 上一步 ${p.last_action.skill} ${p.last_action.ok ? '成功' : `失败:${p.last_action.kind ?? '?'}`}`
      : '';
    const plan = planText(planOf(st));
    return (
      [
        `${st.name}: ${pos} ${st.dimension ?? ''}`.trim(),
        `HP ${st.hp ?? '?'} 饥饿 ${st.hunger ?? '?'} 模式 ${st.mode}${st.paused ? ' 已暂停' : ''}`,
        `任务 ${task}`,
        `队列 ${queue.length ? queue.map((g) => g.skill).join('->') : '空'}${blocked}`,
      ].join(' | ') + (plan ? ` | ${plan}` : '') + last
    );
  };

  /** 把一条上报压成一行短文本（默认给 LLM 看的精简版，避免大 JSON 撑爆上下文）。 */
  const shortInboxText = (i) => {
    const raw = i.text != null ? i.text : (i.detail ?? i.data ?? null);
    let s = '';
    if (raw && typeof raw === 'object') {
      s = raw.message || raw.msg || raw.reason || raw.note || '';
      if (!s && raw.recipeId && raw.step) {
        s = `${raw.recipeId}/${raw.step} ${raw.ok ? 'ok' : 'fail'}${raw.kind ? ':' + raw.kind : ''}${raw.next ? '→' + raw.next : ''}`;
      }
      if (!s && raw.plan && raw.plan.recipeId) {
        s = `计划 ${raw.plan.recipeId} ${raw.plan.status ?? ''}${raw.why ? `（${raw.why}）` : ''}`;
      }
      if (!s && raw.goalId && raw.skill) {
        s = `${raw.goalId} ${raw.skill}${raw.kind ? ' ' + raw.kind : ''}`;
      }
      if (!s) s = Object.keys(raw).slice(0, 6).join(',');
    } else if (raw != null) {
      s = String(raw);
    }
    return String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
  };

  // ── 地点簿（tree_place）辅助 ─────────────────────────────────────────  /** 同伴选择：指定了就必须存在；没指定默认第一个。 */
  const placeLaneOf = (companion) =>
    companion ? lanes.get(companion) || null : [...lanes.values()][0] || null;

  const finitePos = (o) => {
    if (!o || typeof o !== 'object') return null;
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  };

  const parseCoordText = (s) => {
    const parts = String(s).split(',').map((x) => Number(x.trim()));
    return parts.length === 3 && parts.every(Number.isFinite)
      ? { x: parts[0], y: parts[1], z: parts[2] }
      : null;
  };

  /**
   * 解析 record 的位置，规则：
   *  - {x,y,z} / "x,y,z" 显式坐标；
   *  - "here" → 该同伴 state.pos；"owner" → 该同伴 state.ownerPos；
   *  - 没给 pos → 先同伴位置、再主人位置；都没有就返回 error（不抛）。
   */
  const resolveToolPos = (posArg, lane) => {
    const st = lane?.state || null;
    const dimension = st?.dimension ?? null;
    const key = typeof posArg === 'string' ? posArg.trim().toLowerCase() : '';
    if (posArg && typeof posArg === 'object') {
      const p = finitePos(posArg);
      if (!p) return { error: 'pos 对象需要数字 x/y/z' };
      return { pos: p, dimension };
    }
    if (key === 'here') {
      if (!st?.pos) {
        return {
          error:
            '还没观测到同伴位置，pos:"here" 暂不可用；稍后再试，或直接给 {x,y,z}',
        };
      }
      return { pos: finitePos(st.pos) || { ...st.pos }, dimension };
    }
    if (key === 'owner') {
      if (!st) return { error: '现在没有同伴，拿不到主人位置' };
      if (st.ownerOnline === false) return { error: '主人当前不在线，拿不到主人位置' };
      if (!st.ownerPos) return { error: '还没观测到主人位置（主人可能不在线）' };
      return { pos: finitePos(st.ownerPos) || { ...st.ownerPos }, dimension };
    }
    if (key) {
      const p = parseCoordText(key);
      if (p) return { pos: p, dimension };
      return {
        error: `无法解析 pos："${String(posArg)}"（用 "here" / "owner" / {x,y,z}）`,
      };
    }
    if (st?.pos) return { pos: finitePos(st.pos) || { ...st.pos }, dimension };
    if (st?.ownerPos && st.ownerOnline !== false) {
      return { pos: finitePos(st.ownerPos) || { ...st.ownerPos }, dimension };
    }
    return {
      error: '不知道位置：pos 传 "here" / "owner" / {x,y,z}；或等同伴观测到位置',
    };
  };

  /** 同伴到地点的大致直线距离（跨维度不算距离，返回 null）。 */
  const distanceFromLane = (lane, place) => {
    const st = lane?.state;
    if (!st?.pos || !place?.pos) return null;
    if (st.dimension && place.dimension && st.dimension !== place.dimension) return null;
    return distanceBetween(st.pos, place.pos);
  };

  const placeWithDistance = (place, lane) => ({
    ...place,
    pos: place.pos ? { ...place.pos } : null,
    distance: distanceFromLane(lane, place),
  });

  /** "主人/我的位置/你在哪/主人在哪/where is owner" → 取主人实时位置，不查簿。 */
  const isOwnerLiveQuery = (raw) => {
    const q = normalizeText(raw);
    if (!q) return false;
    const ownerRef =
      /主人|老板|owner|master/.test(q) ||
      /(^|[^a-z])(你|我|自己|me|you)([^a-z]|$)/.test(q) ||
      /(你|我|自己)(现在)?在/.test(q) ||
      /(你|我|自己)(的)?(位置|坐标|地方)/.test(q);
    const whereRef =
      /在哪|哪里|哪儿|位置|坐标|什么地方|在什么|那|where|position/.test(q) ||
      /你在|我在|自己在|主人在/.test(q);
    return (
      ownerRef &&
      (whereRef || /^(主人|老板|你|我|自己|me|owner|master)$/.test(q))
    );
  };

  const tools = [
    {
      name: 'tree_status',
      description:
        '看同伴现在在哪、在做什么。**默认超精简**（每个同伴一行 summary + 收件箱待决策数，几十~几百字节）；需要完整 JSON（goals/plan/progress/inventory）时传 detail:true。',
      inputSchema: {
        type: 'object',
        properties: {
          detail: { type: 'boolean', description: 'true=返回完整 JSON（大，默认 false 只给一行摘要）' },
        },
        additionalProperties: true,
      },
    },
    {
      name: 'tree_task',
      description:
        '把一句任务意图交给树（可以直接用主人的原话，如"把木头存了""回家过夜""去砍点木头"）——树按配方表匹配，自动分步执行，不逐步叫你。' +
        '成功返回 plan（配方标题 + 步骤）；匹配不上返回 no_recipe 和可用配方列表（用其中 title/match 的说法再试）。' +
        '需要精确指挥单个技能时用 tree_goal；提交后进度看 tree_status，完成/失败会在 tree_wait 出现。',
      inputSchema: {
        type: 'object',
        properties: {
          companion: { type: 'string', description: '同伴名' },
          intent: {
            type: 'string',
            description: '任务意图，模糊说法即可（直接抄主人的原话也行），树会按配方表匹配',
          },
          deadline_seconds: {
            type: 'number',
            description: '整条计划的时限（秒），可选；不填用配方默认预算',
          },
          params: {
            type: 'object',
            description: '附加参数（可选，通常不用给）',
            additionalProperties: true,
          },
        },
        required: ['companion', 'intent'],
      },
    },
    {
      name: 'tree_skills',
      description: '列出树能执行的四项技能卡（做什么、参数是什么）。下目标前不确定就用它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'tree_goal',
      description:
        '给同伴下一个任务（技能卡 + 参数）。立即返回，不阻塞。任务结束后会在 tree_wait / tree_inbox 里出现。',
      inputSchema: {
        type: 'object',
        properties: {
          companion: { type: 'string', description: '同伴名' },
          skill: { type: 'string', description: '技能 id，见 tree_skills' },
          params: { type: 'object', description: '技能参数', additionalProperties: true },
          priority: { type: 'number', description: '优先级，大的先做，默认 0' },
        },
        required: ['companion', 'skill'],
      },
    },
    {
      name: 'tree_control',
      description:
        '控制同伴：pause 暂停 / resume 恢复 / clear 清空队列 / mode 切换行为模式 / tether 切换牵引绳 / ' +
        'unlock 外部清掉僵尸锁（Lua 槽被占，不清就动不了；不需要重建同伴）/ lock_status 查补丁状态。' +
        '模式：survival 生存（默认，只保命+跟主人）/ production 生产（挖资源）/ combat 战斗（主动清怪）。',
      inputSchema: {
        type: 'object',
        properties: {
          companion: { type: 'string' },
          op: {
            type: 'string',
            enum: ['pause', 'resume', 'clear', 'mode', 'tether', 'unlock', 'lock_status'],
          },
          mode: {
            type: 'string',
            description: 'mode 操作时用：survival / production / combat；tether 操作时用：owner / home',
          },
          all: {
            type: 'boolean',
            description: 'unlock 时清全部同伴的锁（默认只清本同伴）',
          },
        },
        required: ['companion', 'op'],
      },
    },
    {
      name: 'tree_inbox',
      description:
        '拉取树的上报。★ 标记的是"需要你决策"的（求助、主人说话、任务失败）；其余只是通知。默认每条压成一行短文本；要原始 detail JSON 传 full:true。',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: '从这个序号之后开始，默认 0' },
          brain_only: { type: 'boolean', description: '只看需要决策的' },
          full: { type: 'boolean', description: 'true=带完整 detail JSON（大）' },
          limit: { type: 'number', description: '最多返回几条，默认 30' },
        },
      },
    },
    {
      name: 'tree_wait',
      description:
        '等树有事找你（最长 timeout 秒）。没事时零成本；有事立刻返回。返回内容 = 需要决策的上报 + 当前状态摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: '收件箱序号，默认 0' },
          timeout_seconds: { type: 'number', description: '最长等待秒数，默认 60，最大 90' },
        },
      },
    },
    {
      name: 'say',
      description: '让同伴在游戏里说话。直通 numen，随时可用。',
      inputSchema: {
        type: 'object',
        properties: {
          companion: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['companion', 'text'],
      },
    },
    {
      name: 'memory',
      description: '长期笔记（跨会话记住坐标、偏好、教训）。直通 numen。',
      inputSchema: {
        type: 'object',
        properties: {
          companion: { type: 'string' },
          command: { type: 'string', enum: ['remember', 'recall', 'forget'] },
          name: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['owner', 'world', 'lesson'] },
          content: { type: 'string' },
        },
        required: ['companion', 'command'],
      },
    },
    {
      name: 'tree_place',
      description:
        '地点簿：记录/查询/删除地点（死亡点、基地、主人位置、矿洞等）。' +
        '可以直接把用户的模糊说法当 name/query 传进来（"把这儿记成家""上次死在哪""带我去最近的基地""主人在哪"），树会做别名/模糊解析，返回 why 说明匹配原因。' +
        'action：record 记录 / list 列出 / find 查找 / forget 删除。' +
        'pos："here"=同伴当前位置，"owner"=主人当前位置，也可直接给 {x,y,z}；不给时先取同伴位置、再取主人位置。' +
        'find 的 query 是"主人/我的位置/你在哪/主人在哪"时直接返回主人实时位置（live:true，不写簿）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['record', 'list', 'find', 'forget'],
            description: 'record 记录 / list 列出 / find 查找 / forget 删除',
          },
          name: {
            type: 'string',
            description:
              'record 用：地点名，可以很模糊（"家""刚才死的地方""矿洞入口"）。没给 kind 时从名字推断（家/基地→base、死→death、主人→owner）。',
          },
          kind: {
            type: 'string',
            enum: ['base', 'death', 'owner', 'poi', 'custom'],
            description: '地点类型；不给就按 name 线索推断，推断不出为 custom。',
          },
          pos: {
            description:
              'record 用。pos:"here"=同伴当前位置；pos:"owner"=主人当前位置；也可直接给 {x,y,z}。',
            oneOf: [
              {
                type: 'string',
                enum: ['here', 'owner'],
                description: 'here=同伴当前位置，owner=主人当前位置',
              },
              {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  z: { type: 'number' },
                },
                required: ['x', 'y', 'z'],
              },
            ],
          },
          query: {
            type: 'string',
            description:
              'find/forget 用：接受模糊说法（"上次死的地方""最近的基地""主人""矿洞"）；forget 也接受 id（如 p3）。',
          },
          note: { type: 'string', description: '备注（可选）' },
          companion: {
            type: 'string',
            description:
              '同伴名；不给默认第一个同伴。record 的 pos:"here"/"owner" 用它决定取谁的位置。',
          },
        },
        required: ['action'],
      },
    },
  ];

  const text = (s, isError = false) => ({
    content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });

  async function callTool(name, args = {}) {
    const laneOf = (companion) => lanes.get(companion) || null;

    switch (name) {
      case 'tree_status': {
        const now = new Date().toISOString();
        const wantDetail = args.detail === true || args.detail === 'true';
        // 默认：每个同伴一行摘要（几十~几百字节），别把完整 goals/plan/inventory 塞进 LLM 上下文
        if (!wantDetail) {
          const need = inbox.since(0).filter((i) => i.needsBrain);
          const lines = [...lanes.values()].map((l) => summaryLine(l.state));
          return text([`状态 ${now} | 收件箱 #${inbox.seq}（待决策 ★${need.length}）`, ...lines].join('\n'));
        }
        const companions = [...lanes.values()].map((l) => {
          const st = l.state;
          const nowMs = Date.now();
          const progress = progressOf(st, nowMs);
          return {
            name: st.name,
            id: st.id,
            pos: st.pos,
            hp: st.hp,
            hunger: st.hunger,
            dimension: st.dimension,
            mode: st.mode,
            paused: st.paused,
            tether: st.tether ?? null,
            ownerDistance: st.ownerDistance,
            hostileCount: st.hostileCount,
            execMode: st.execMode ?? 'safe-batch',
            execReason: st.execReason ?? 'init',
            execSince: st.execSince ?? null,
            foodCount: st.foodCount,
            weapon: st.weapon,
            animalCount: st.animalCount,
            // 背包概览（最多 24 种 {item,count}）：LLM 挑方块/材料用
            inventory: st.inventory ?? [],
            task: st.taskStatus,
            detachedTask: st.detachedTask,
            slotBlocked: st.slotBlocked,
            consecutiveFailures: st.consecutiveFailures,
            summary: summaryOf(st, progress),
            progress,
            plan: planOf(st),
            // LLM 接管预算状态：stopped=true 表示已自止，需要 resume / 新任务
            drive: st.driveStartedAt
              ? {
                  running_seconds: secondsSince(new Date(st.driveStartedAt).toISOString(), nowMs),
                  goals: st.driveGoals,
                  stopped: !!st.driveStopReason,
                  stopReason: st.driveStopReason,
                }
              : null,
            // 保留原来的 goal 结构，只追加 waited_seconds
            goals: st.goals.map((g) => ({
              id: g.id,
              skill: g.skill,
              params: g.params,
              priority: g.priority,
              status: g.status,
              attempts: g.attempts,
              lastResult: g.lastResult,
              waited_seconds: secondsSince(g.createdAt, nowMs),
            })),
          };
        });
        return text({ now, inboxSeq: inbox.seq, companions });
      }

      case 'tree_task': {
        const lane = laneOf(args.companion);
        if (!lane) {
          return text(
            {
              ok: false,
              reason: 'no_companion',
              message: `没有这个同伴：${args.companion}`,
            },
            true,
          );
        }
        const intent = args.intent == null ? '' : String(args.intent).trim();
        if (!intent) {
          return text(
            {
              ok: false,
              reason: 'intent_required',
              message: 'intent 必填（模糊说法即可，如"把木头存了"）',
            },
            true,
          );
        }
        // 降级：plan.mjs 还没接进来时给结构化原因，别崩
        if (typeof startTask !== 'function') {
          return text({ ok: false, reason: 'tasker_unavailable' }, true);
        }
        const deadline = Number(args.deadline_seconds);
        const callArgs = {
          companion: args.companion,
          intent,
          deadlineSeconds:
            Number.isFinite(deadline) && deadline > 0 ? deadline : undefined,
          params:
            args.params && typeof args.params === 'object' ? args.params : undefined,
        };
        try {
          const r = await startTask(callArgs);
          if (!r || typeof r !== 'object') {
            return text({ ok: false, reason: 'tasker_bad_result' }, true);
          }
          if (r.ok === true) {
            const plan = r.plan && typeof r.plan === 'object' ? r.plan : null;
            const steps = Array.isArray(plan?.steps) ? plan.steps : [];
            trace.info('task_added', {
              companion: args.companion,
              note: `${plan?.id ?? '?'} ${plan?.recipeId ?? '?'} intent=${intent}`,
            });
            return text({
              ok: true,
              plan: {
                id: plan?.id ?? null,
                recipeId: plan?.recipeId ?? null,
                title: plan?.title ?? null,
                steps: steps.map((s) => ({ as: s?.as ?? null, skill: s?.skill ?? null })),
              },
            });
          }
          // 匹配不上配方：把可用的配方短语带回去，LLM 换个说法/换任务再试
          const payload = { ok: false, reason: r.reason ?? 'task_rejected' };
          if (r.tried != null) payload.tried = r.tried;
          else if (r.reason === 'no_recipe') payload.tried = intent;
          if (Array.isArray(r.available)) payload.available = r.available;
          if (r.message != null) payload.message = r.message;
          return text(payload);
        } catch (e) {
          trace.error('task_error', {
            companion: args.companion,
            note: String(e?.message || e),
          });
          return text(
            {
              ok: false,
              reason: 'tasker_error',
              message: String(e?.message || e),
            },
            true,
          );
        }
      }

      case 'tree_skills': {
        const list = skills()
          .map((s) => `- ${s.id}：${s.title}\n  参数：${JSON.stringify(s.params)}`)
          .join('\n');
        return text(list);
      }

      case 'tree_goal': {
        const lane = laneOf(args.companion);
        if (!lane) return text(`没有这个同伴：${args.companion}`, true);
        const st = lane.state;
        // 自止状态：不接受单条目标，必须显式 resume（续期）或 tree_task（新任务）
        if (st.paused && st.driveStopReason) {
          return text(
            {
              ok: false,
              reason: 'drive_stopped',
              message: `LLM 接管已自止（${st.driveStopReason}）。用 tree_control resume 续期，或 tree_task 重新下任务。`,
            },
            true,
          );
        }
        const skill = String(args.skill || '');
        const params = args.params || {};
        // 去重：同样的技能+参数已经在排队就不重复加（LLM 容易重复下同一条）
        const key = JSON.stringify(params);
        const dup = st.goals.find(
          (g) =>
            g.status === 'pending' &&
            g.skill === skill &&
            JSON.stringify(g.params || {}) === key,
        );
        if (dup) return text(`已有相同目标在排队：${dup.id} ${dup.skill}（未重复添加）`);
        // 队列上限：堆太多会"看起来卡住"
        const pendingCount = st.goals.filter((g) => g.status === 'pending').length;
        if (pendingCount >= 12) {
          return text(
            `队列已满（${pendingCount} 个待执行）。先 tree_status 看进度，或 tree_control clear 清掉旧目标再下。`,
            true,
          );
        }
        // LLM 目标默认 priority 20：高于树内部步骤(10)、低于安全中断(90)
        const goal = st.pushGoal({
          id: `g${Date.now().toString(36)}`,
          skill,
          params,
          priority: Number(args.priority ?? 20),
          status: 'pending',
          note: 'mcp',
          createdAt: new Date().toISOString(),
          startedAt: null,
          endedAt: null,
          attempts: 0,
          lastResult: null,
        });
        st.lastLlmGoalAt = Date.now();
        lane.noteLlmActivity?.();
        trace.info('goal_added', {
          companion: args.companion,
          note: `${goal.id} ${goal.skill} ${JSON.stringify(goal.params)} priority=${goal.priority}`,
        });
        return text(`已排队 ${goal.id} ${goal.skill}（${
          st.goals.filter((g) => g.status === 'pending').length
        } 个待执行）`);
      }

      case 'tree_control': {
        const lane = laneOf(args.companion);
        if (!lane) return text(`没有这个同伴：${args.companion}`, true);
        const st = lane.state;
        const resetDrive = () => {
          st.driveStartedAt = null;
          st.driveGoals = 0;
          st.driveStopReason = null;
          st.lastLlmGoalAt = 0;
        };
        if (args.op === 'pause') st.paused = true;
        else if (args.op === 'resume') {
          // 恢复 = 重置接管预算（自止后续期）
          st.paused = false;
          resetDrive();
        } else if (args.op === 'stop') {
          // 硬停：暂停 + 清空待执行目标 + 重置预算
          st.paused = true;
          st.cancelAll('stopped');
          resetDrive();
        } else if (args.op === 'tether') {
          // 动态牵引绳：跟着主人(owner) / 绑家里(home)
          const a = String(args.mode ?? args.anchor ?? '').toLowerCase();
          if (['owner', 'follow', '跟', '跟随', '跟着'].some((k) => a.includes(k))) {
            st.tether = 'owner';
          } else if (['home', '家', '基地', 'stay', '待'].some((k) => a.includes(k))) {
            st.tether = 'home';
          } else {
            return text(
              { ok: false, reason: 'bad_argument', message: 'tether 需要 mode: "owner"(跟着主人) 或 "home"(绑家里)' },
              true,
            );
          }
        } else if (args.op === 'clear') st.cancelAll('cleared');
        else if (args.op === 'mode') st.mode = String(args.mode || 'normal');
        else if (args.op === 'unlock') {
          // 外部清僵尸锁（补丁 v3 的 127.0.0.1:8768）：不重建同伴、不丢背包
          const r = await lane.unlockNow({ all: !!args.all });
          trace.info('control', { companion: args.companion, note: `unlock ${JSON.stringify(r)}` });
          return text(
            r.ok
              ? `已清掉 ${args.companion} 的僵尸锁（cleared=${r.cleared}，补丁 v${r.patch ?? '?'}），不用重建同伴。`
              : `清锁失败：${r.error}（没装 v3 补丁/游戏没重启？见 patcher/README）`,
            !r.ok,
          );
        } else if (args.op === 'lock_status') {
          const r = await lane.lockStatus();
          return text(JSON.stringify(r, null, 2), r?.ok === false);
        }
        else return text(`未知操作：${args.op}（可用 pause/resume/stop/clear/mode/tether/unlock/lock_status）`, true);
        trace.info('control', { companion: args.companion, note: args.op });
        return text(summaryLine(st));
      }

      case 'tree_inbox': {
        const since = Number(args.since ?? 0);
        const limit = Math.min(100, Math.max(1, Number(args.limit ?? 30)));
        const full = args.full === true || args.full === 'true';
        let items = inbox.since(since);
        if (args.brain_only) items = items.filter((i) => i.needsBrain);
        items = items.slice(-limit);
        if (!items.length) return text(`无新上报（当前序号 ${inbox.seq}）`);
        const body = full
          ? items
              .map((i) => `${i.needsBrain ? '★' : ' '} #${i.seq} ${i.kind} [${i.companion}] ${i.text ?? JSON.stringify(i.detail ?? i.data ?? '')}`)
              .join('\n')
          : items
              .map((i) => `${i.needsBrain ? '★' : ' '} #${i.seq} ${i.kind} [${i.companion}] ${shortInboxText(i)}`)
              .join('\n');
        return text(`${body}\n\n（当前序号 ${inbox.seq}）`);
      }

      case 'tree_wait': {
        const since = Number(args.since ?? 0);
        const timeout = Math.min(90, Math.max(1, Number(args.timeout_seconds ?? 60)));
        const deadline = Date.now() + timeout * 1000;
        while (Date.now() < deadline) {
          const items = inbox.since(since).filter((i) => i.needsBrain);
          if (items.length) {
            const body = items
              .map((i) => `★ #${i.seq} ${i.kind} [${i.companion}] ${shortInboxText(i)}`)
              .join('\n');
            const st = [...lanes.values()].map((l) => summaryLine(l.state)).join('\n');
            const now = new Date().toISOString();
            return text(`有事找你：\n${body}\n\n当前状态（${now}）：\n${st}\n\n（序号 ${inbox.seq}）`);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        const st = [...lanes.values()].map((l) => summaryLine(l.state)).join('\n');
        const now = new Date().toISOString();
        return text(
          `等了 ${timeout} 秒没有需要你决策的事。\n\n当前状态（${now}）：\n${st}\n\n（序号 ${inbox.seq}）`,
        );
      }

      case 'say':
        await numen.say(args.companion, args.text);
        return text('说了');

      case 'memory': {
        const out = await numen.callTool('memory', args);
        return text(out || 'ok');
      }

      case 'tree_place': {
        // 降级：没有地点簿实例也不崩，直接返回结构化原因
        if (!places || typeof places.record !== 'function') {
          return text({ ok: false, reason: 'places_unavailable' }, true);
        }
        const action = String(args.action ?? '').trim().toLowerCase();
        if (!action) {
          return text(
            {
              ok: false,
              reason: 'action_required',
              message: 'action 需要 record / list / find / forget',
            },
            true,
          );
        }
        const companionArg =
          args.companion == null ? '' : String(args.companion).trim();
        const lane = placeLaneOf(companionArg || undefined);
        if (companionArg && !lane) {
          return text(
            {
              ok: false,
              reason: 'no_companion',
              message: `没有这个同伴：${companionArg}`,
            },
            true,
          );
        }
        const st = lane?.state || null;

        if (action === 'record') {
          const nameHint =
            args.name != null
              ? String(args.name)
              : args.query != null
                ? String(args.query)
                : '';
          const resolved = resolveToolPos(args.pos, lane);
          if (resolved.error) {
            return text(
              { ok: false, reason: 'no_position', message: resolved.error },
              true,
            );
          }
          const kind = args.kind
            ? normalizeKind(args.kind)
            : inferKind(nameHint);
          const place = places.record({
            name: nameHint,
            kind,
            dimension: resolved.dimension,
            pos: resolved.pos,
            note: args.note == null ? '' : String(args.note),
            source: 'llm',
            companion: st?.name ?? (companionArg || null),
          });
          trace.info('place_recorded', {
            companion: st?.name,
            note: `${place.id} ${place.name} ${JSON.stringify(place.pos)}`,
          });
          return text({ ok: true, place });
        }

        if (action === 'list') {
          const query = args.query == null ? '' : String(args.query).trim();
          const list = places
            .list({ kind: args.kind || undefined })
            .map((p) => placeWithDistance(p, lane));
          const payload = {
            ok: true,
            count: list.length,
            companion: st?.name ?? null,
            places: list,
          };
          if (query) {
            payload.match = places.find(query, {
              dimension: st?.dimension ?? undefined,
              near: st?.pos ?? undefined,
            });
          }
          return text(payload);
        }

        if (action === 'find') {
          const query = String(args.query ?? args.name ?? '').trim();
          if (!query) {
            return text(
              {
                ok: false,
                reason: 'query_required',
                message: 'find 需要 query（模糊说法即可，如"上次死的地方"）',
              },
              true,
            );
          }

          // 主人本人：直接返回实时位置，不往簿里写
          if (isOwnerLiveQuery(query)) {
            if (!st) {
              return text(
                {
                  ok: false,
                  reason: 'no_companion',
                  message: '现在没有同伴在线，拿不到主人位置',
                },
                true,
              );
            }
            if (!st.ownerPos) {
              return text(
                {
                  ok: false,
                  reason: 'owner_position_unknown',
                  message: '还没观测到主人位置（主人可能不在线）',
                },
                true,
              );
            }
            const payload = {
              ok: true,
              live: true,
              why: '查询指向主人本人 → 直接返回实时位置（没有写进地点簿）',
              place: {
                name: '主人当前位置',
                kind: 'owner',
                dimension: st.dimension ?? null,
                pos: { ...st.ownerPos },
                companion: st.name,
              },
            };
            const d =
              st.ownerDistance != null
                ? st.ownerDistance
                : distanceBetween(st.pos, st.ownerPos);
            if (d != null) payload.distance = d;
            if (st.ownerOnline === false) {
              payload.note = '主人当前不在线，这是最后一次观测到的位置';
            }
            return text(payload);
          }

          const matched = places.find(query, {
            dimension: st?.dimension ?? undefined,
            near: st?.pos ?? undefined,
          });
          if (!matched) {
            return text({ ok: false, reason: 'not_found', tried: query });
          }
          return text({
            ok: true,
            place: matched.place,
            why: matched.why,
            distance: matched.distance ?? null,
            alternatives: matched.alternatives ?? [],
          });
        }

        if (action === 'forget') {
          const query = String(args.query ?? args.name ?? '').trim();
          if (!query) {
            return text(
              {
                ok: false,
                reason: 'query_required',
                message: 'forget 需要 query（模糊说法或 id，如 p3）',
              },
              true,
            );
          }
          const gone = places.forget(query);
          if (!gone) {
            return text({ ok: false, reason: 'not_found', tried: query });
          }
          trace.info('place_forgotten', {
            companion: st?.name,
            note: `${gone.id} ${gone.name}`,
          });
          return text({ ok: true, place: gone });
        }

        return text(
          {
            ok: false,
            reason: 'unknown_action',
            action,
            message: 'action 需要 record / list / find / forget',
          },
          true,
        );
      }

      default:
        return text(`未知工具：${name}`, true);
    }
  }

  function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
  }
  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  async function handle(body) {
    const { id, method, params } = body || {};
    if (method === 'initialize') {
      const sid = crypto.randomUUID();
      sessions.add(sid);
      return {
        payload: rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'numen-tree', version: '0.1.0' },
        }),
        sessionId: sid,
      };
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
      return { payload: null };
    }
    if (method === 'ping') return { payload: rpcResult(id, {}) };
    if (method === 'tools/list') return { payload: rpcResult(id, { tools }) };
    if (method === 'tools/call') {
      try {
        const result = await callTool(params?.name, params?.arguments || {});
        return { payload: rpcResult(id, result) };
      } catch (e) {
        trace.error('mcp_tool_error', { note: `${params?.name}: ${e?.message || e}` });
        return { payload: rpcError(id, -32603, String(e?.message || e)) };
      }
    }
    return { payload: rpcError(id ?? null, -32601, `unsupported method: ${method}`) };
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }

    try {
      const { payload, sessionId } = await handle(body);
      if (!payload) {
        res.writeHead(202, sessionId ? { 'Mcp-Session-Id': sessionId } : {}).end();
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      res.writeHead(200, headers).end(JSON.stringify(payload));
    } catch (e) {
      trace.error('mcp_server_error', { note: String(e?.stack || e) });
      res.writeHead(500).end();
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          trace.info('tree_mcp_listening', { note: `http://${host}:${port}/mcp` });
          resolve();
        });
      }),
  };
}

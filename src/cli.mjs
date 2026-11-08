import fs from 'node:fs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const url = cfg.control.url;

function usage() {
  console.log(`用法：
  node src/cli.mjs status
  node src/cli.mjs skills
  node src/cli.mjs inbox [--since N] [--brain]
  node src/cli.mjs goal --companion <名> --skill <id> [--params '<json>'] [--priority N]
  node src/cli.mjs control --companion <名> --op pause|resume|clear|mode [--mode normal]
  node src/cli.mjs control --op reload-skills     # 改完技能卡热重载
  node src/cli.mjs control --op exit              # 优雅退出（等在途动作收敛，避免僵尸锁）

僵尸锁（补丁 v3 的 127.0.0.1:8768，不用重建同伴、不丢背包）：
  node src/cli.mjs lock                          # 查补丁状态 + 每个同伴的 slotBlocked
  node src/cli.mjs lock --companion <名>         # 手动清这个同伴的锁
  node src/cli.mjs lock --all                    # 清全部

任务（意图 → 配方计划，树自动分步执行）：
  node src/cli.mjs task --companion tyrander --intent "把木头存了" [--deadline 120]

地点簿（死亡点/基地/主人位置/自定义地点，持久化到 places.json）：
  node src/cli.mjs place list [--kind base]
  node src/cli.mjs place find --query 基地 [--companion tyrander]
  node src/cli.mjs place record --name 家 --kind base [--pos here|owner|x,y,z] [--note 备注] [--companion 名]
  node src/cli.mjs place forget --query 旧基地
`);
}

function placeUsage() {
  console.log(`地点簿用法：
  node src/cli.mjs place list [--kind base]
  node src/cli.mjs place find --query 基地 [--companion tyrander]
  node src/cli.mjs place record --name 家 --kind base [--pos here|owner|x,y,z] [--note 备注] [--companion 名]
  node src/cli.mjs place forget --query 旧基地

  --pos 省略时：先取同伴当前位置，取不到再取主人位置。
  --query 接受模糊说法："上次死的地方""最近的基地""主人""矿洞"；
            "主人/我的位置/你在哪" 会直接返回主人实时位置（不写簿）。
  --kind base（基地）/ death（死亡点）/ owner（主人位置）/ poi（地点）/ custom（自定义）。
  动作走控制 API：GET /places?kind=&query=&near=x,y,z；POST /place {action,...}。`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

async function call(method, path, body, { soft = false } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const extra =
      data && typeof data === 'object' && !Array.isArray(data)
        ? data
        : { error: String(data) };
    // soft：地点簿命令自己决定怎么报错（旧树进程可能还没这个路由）
    if (soft) return { ok: false, httpStatus: res.status, ...extra };
    console.error(`HTTP ${res.status}`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

function short(n) {
  return Number(n).toFixed(1);
}

/** tree MCP 的地址（进度字段从那里取，和 LLM 看到的 tree_status 同源）。 */
const mcpUrl = `http://${cfg.mcp.host}:${cfg.mcp.port}/mcp`;

/**
 * 从 MCP 的 tree_status 取进度派生字段。
 *
 * 为什么绕一下：控制 API 的 /status 是 snapshot()，不含 goals[].createdAt，
 * 算不出"队列里每个目标等了多久"。tree_status 用同一份 state 现算，两边显示一致。
 * 取不到就返回 null，status 命令退回控制 API 的字段，不因此失败。
 */
async function fetchProgress() {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tree_status', arguments: {} },
      }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const body = payload?.result?.content?.[0]?.text;
    if (!body) return null;
    const parsed = JSON.parse(body);
    const byName = new Map();
    for (const c of parsed.companions || []) if (c?.name) byName.set(c.name, c);
    return byName;
  } catch {
    return null;
  }
}

/** 兜底：MCP 不可达时，用 /status 里有的字段算多少算多少（等待秒数只能留空）。 */
function progressFromStatus(c, nowMs) {
  const cur = c.current || null;
  // /status 的 snapshot 现在也带 lastAction（Lead 新增）；没有时退回 goals 扫描
  const a = c.lastAction;
  let last_action = null;
  if (a && typeof a === 'object') {
    last_action = {
      goal: a.goalId ?? null,
      skill: a.skill ?? null,
      ok: !!a.ok,
      kind: a.kind ?? null,
      message: a.message ?? null,
      ms: a.ms ?? null,
    };
  } else {
    const last = [...(c.goals || [])].reverse().find((g) => g.lastResult);
    const lr = last?.lastResult;
    if (lr) {
      last_action = {
        goal: last.id,
        skill: last.skill,
        ok: !!lr.ok,
        kind: lr.kind ?? null,
        message: lr.message ?? null,
        ms: lr.ms ?? null,
      };
    }
  }
  return {
    current_skill: cur?.skill ?? null,
    current_goal_id: cur?.goalId ?? null,
    running_seconds: cur?.startedAt
      ? Math.max(0, Math.round((nowMs - Date.parse(cur.startedAt)) / 1000))
      : null,
    last_action,
    pending_goals: (c.goals || [])
      .filter((g) => g.status === 'pending' || g.status === 'running')
      .map((g) => ({ id: g.id, skill: g.skill, status: g.status, waited_seconds: null })),
    slot_blocked_seconds: c.slotBlockedSince
      ? Math.max(0, Math.round((nowMs - Date.parse(c.slotBlockedSince)) / 1000))
      : null,
  };
}

/** 把 last_result 描述成一句人话。 */
function actionText(a) {
  if (!a) return '';
  const what = a.ok ? '成功' : `失败：${a.kind ?? a.message ?? '未知'}`;
  return `${a.skill} ${what}${a.ms != null ? `（${a.ms}ms）` : ''}`;
}

// ── 计划（M1）显示辅助 ──────────────────────────────────────────────────
/** 把内部 plan / tree_status 的 plan 归一成展示用的紧凑形态；没有返回 null。 */
function normalizePlan(raw) {
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
}

/** "砍木头存箱子 第 2/共 4 步（当前步 home），已挂起（near_death）"。 */
function planProgressText(pl) {
  if (!pl) return '';
  const title = pl.title ?? pl.recipeId ?? '未命名计划';
  let s = title;
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
}

// ── place 子命令（走控制 API）────────────────────────────────────────────

const KIND_NAMES = {
  base: '基地',
  death: '死亡点',
  owner: '主人位置',
  poi: '地点',
  custom: '自定义',
};

function fmtPos(p) {
  if (!p || ![p.x, p.y, p.z].every((n) => Number.isFinite(Number(n)))) return '?';
  return `${short(p.x)}, ${short(p.y)}, ${short(p.z)}`;
}

function fmtPlace(p, { distance } = {}) {
  if (!p) return '?';
  const id = p.id ? `${p.id} ` : '';
  const kind = p.kind ? `[${p.kind}${KIND_NAMES[p.kind] ? ` ${KIND_NAMES[p.kind]}` : ''}] ` : '';
  const dim = p.dimension ? ` @ ${p.dimension}` : '';
  const dist = distance != null ? distance : p.distance;
  const distText = dist != null ? `，距离 ${short(dist)} 格` : '';
  const note = p.note ? `  备注：${p.note}` : '';
  return `${id}${kind}${p.name ?? '?'}${dim} (${fmtPos(p.pos)})${distText}${note}`;
}

/** --pos：here / owner / "x,y,z"；非法返回 null，未给返回 undefined。 */
function parsePosArg(v) {
  if (v == null || v === '' || v === true) return undefined;
  const s = String(v).trim();
  if (s === 'here' || s === 'owner') return s;
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return { x: parts[0], y: parts[1], z: parts[2] };
  }
  return null;
}

function companionView(status, name) {
  const list = Array.isArray(status?.companions) ? status.companions : [];
  if (!list.length) return null;
  if (!name) return list[0];
  return list.find((c) => c.name === name) || null;
}

/** 控制 API 的 /places 列表不带距离，CLI 用 /status 里的同伴位置自己算。 */
function estimateDistance(lane, place) {
  if (!lane?.pos || !place?.pos) return null;
  if (lane.dimension && place.dimension && lane.dimension !== place.dimension) return null;
  const dx = Number(place.pos.x) - Number(lane.pos.x);
  const dy = Number(place.pos.y) - Number(lane.pos.y);
  const dz = Number(place.pos.z) - Number(lane.pos.z);
  if (![dx, dy, dz].every(Number.isFinite)) return null;
  return Math.round(Math.hypot(dx, dy, dz) * 10) / 10;
}

function placeError(r, prefix = '地点簿请求失败') {
  if (!r) {
    console.error('连不上树进程的控制 API（先 node src/daemon.mjs 起树）。');
    process.exitCode = 1;
    return;
  }
  const status = r.httpStatus;
  const reason = r.reason || r.error || '未知错误';
  const hint = r.hint ? `：${r.hint}` : '';
  if (status === 404) {
    console.error(
      `${prefix}：控制 API 还没有地点簿接口（当前树进程可能还是旧代码，等重启后再试）。HTTP 404 ${reason}${hint}`,
    );
  } else {
    console.error(`${prefix}${status ? `（HTTP ${status}）` : ''}：${reason}${hint}`);
  }
  process.exitCode = 1;
}

async function cmdPlace(args) {
  const sub = args._[1];

  if (!sub || sub === 'help') {
    placeUsage();
    return;
  }

  if (sub === 'list') {
    const qs = new URLSearchParams();
    if (args.kind) qs.set('kind', args.kind);
    if (args.companion) qs.set('companion', args.companion);
    const q = qs.toString();
    const r = await call('GET', `/places${q ? `?${q}` : ''}`, undefined, { soft: true });
    if (!r || r.ok === false) return placeError(r);
    const list = Array.isArray(r.places) ? r.places : [];
    if (!list.length) {
      console.log(`（地点簿为空${args.kind ? `，kind=${args.kind}` : ''}）`);
      return;
    }
    const status = await call('GET', '/status', undefined, { soft: true }).catch(() => null);
    const lane = companionView(status, args.companion);
    console.log(`地点簿共 ${list.length} 条${args.kind ? `（kind=${args.kind}）` : ''}：`);
    for (const p of list) {
      console.log(`  ${fmtPlace(p, { distance: estimateDistance(lane, p) })}`);
    }
    if (r.match?.place) {
      console.log(`\n最匹配：${fmtPlace(r.match.place)}`);
      if (r.match.why) console.log(`  原因：${r.match.why}`);
      if (r.match.distance != null) console.log(`  距离：${short(r.match.distance)} 格`);
    }
    return;
  }

  if (sub === 'find') {
    const query = args.query ?? args._[2];
    if (!query || query === true) {
      console.error('需要 --query（如：--query 基地 / --query "上次死的地方"）');
      process.exit(2);
    }
    const qs = new URLSearchParams({ query: String(query) });
    if (args.companion) qs.set('companion', args.companion);
    const r = await call('GET', `/places?${qs}`, undefined, { soft: true });
    if (!r || r.ok === false) return placeError(r);
    const m = r.match;
    if (!m?.place) {
      console.log(
        `没找到匹配 "${query}" 的地点（簿里共 ${Array.isArray(r.places) ? r.places.length : 0} 条）。`,
      );
      return;
    }
    const lines = [`匹配：${fmtPlace(m.place)}`];
    if (m.place.live) lines.push('  说明：这是主人实时位置，没有写进地点簿');
    if (m.why) lines.push(`  原因：${m.why}`);
    if (m.distance != null) lines.push(`  距离：${short(m.distance)} 格`);
    console.log(lines.join('\n'));
    if (Array.isArray(m.alternatives) && m.alternatives.length) {
      console.log('  其他候选：');
      for (const a of m.alternatives) console.log(`    ${fmtPlace(a)}`);
    }
    return;
  }

  if (sub === 'record') {
    const name = args.name ?? args._[2];
    if (!name || name === true) {
      console.error('需要 --name（如：--name 家）');
      process.exit(2);
    }
    const pos = parsePosArg(args.pos);
    if (pos === null) {
      console.error(`--pos 需要 here / owner / x,y,z，收到：${args.pos}`);
      process.exit(2);
    }
    const r = await call(
      'POST',
      '/place',
      {
        action: 'record',
        name: String(name),
        kind: args.kind,
        pos,
        note: args.note && args.note !== true ? String(args.note) : undefined,
        companion: args.companion,
      },
      { soft: true },
    );
    if (!r || r.ok === false) return placeError(r, '记录失败');
    console.log(`已记录：${fmtPlace(r.place)}`);
    if (r.place?.id) console.log(`  id ${r.place.id}`);
    return;
  }

  if (sub === 'forget') {
    const query = args.query ?? args.id ?? args._[2];
    if (!query || query === true) {
      console.error('需要 --query（如：--query 旧基地，也接受 id 如 p3）');
      process.exit(2);
    }
    const r = await call(
      'POST',
      '/place',
      { action: 'forget', query: String(query), companion: args.companion },
      { soft: true },
    );
    if (!r || r.ok === false) {
      // 旧树进程没有这个路由时是 404；有路由但没这条地点时是 200 + ok:false
      if (r?.httpStatus) return placeError(r, '删除失败');
      console.log(`没找到：${query}`);
      return;
    }
    console.log(`已删除：${fmtPlace(r.place)}`);
    return;
  }

  console.error(`未知地点簿子命令：${sub}`);
  placeUsage();
  process.exitCode = 2;
}

// ── task 子命令：一句话意图 → 配方计划（走控制 API POST /task）─────────────
async function cmdTask(args) {
  const companion = args.companion ?? args._[1];
  const intent = args.intent ?? args._[2];
  if (!companion || companion === true || !intent || intent === true) {
    console.error(
      '需要 --companion 和 --intent（如：node src/cli.mjs task --companion tyrander --intent "把木头存了"）',
    );
    process.exit(2);
  }
  let deadline;
  if (args.deadline != null && args.deadline !== true) {
    deadline = Number(args.deadline);
    if (!Number.isFinite(deadline) || deadline <= 0) {
      console.error(`--deadline 需要正数秒，收到：${args.deadline}`);
      process.exit(2);
    }
  }
  const body = { companion: String(companion), intent: String(intent) };
  if (deadline != null) body.deadlineSeconds = deadline;
  const r = await call('POST', '/task', body, { soft: true });
  if (!r) {
    console.error('连不上树进程的控制 API（先 node src/daemon.mjs 起树）。');
    process.exitCode = 1;
    return;
  }
  if (r.httpStatus === 404) {
    console.error(
      '控制 API 还没有 /task 接口（当前树进程可能还是旧代码，重启树后再试）。',
    );
    process.exitCode = 1;
    return;
  }
  if (r.httpStatus) {
    console.error(
      `任务请求失败（HTTP ${r.httpStatus}）：${r.error || r.message || '未知错误'}`,
    );
    process.exitCode = 1;
    return;
  }
  if (r.ok === false || !r.plan) {
    if (r.reason === 'no_recipe') {
      console.log(`没匹配到配方："${r.tried ?? intent}"`);
      const list = Array.isArray(r.available) ? r.available : [];
      if (list.length) {
        console.log('可用配方：');
        for (const a of list) {
          const words =
            Array.isArray(a.match) && a.match.length ? `（匹配词：${a.match.join('、')}）` : '';
          console.log(`  - ${a.id}：${a.title ?? ''}${words}`);
        }
      } else {
        console.log('（当前没有可用配方）');
      }
    } else {
      console.error(
        `任务没接：${r.reason || r.error || '未知原因'}${r.message ? `：${r.message}` : ''}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  const rawPlan = r.plan ?? {};
  const plan = normalizePlan(rawPlan) ?? rawPlan;
  console.log(
    `已接任务：${plan.id ?? '?'} ${plan.recipeId ?? ''}「${plan.title ?? '未命名'}」`,
  );
  const steps = Array.isArray(rawPlan.steps) ? rawPlan.steps : [];
  if (steps.length) {
    console.log('步骤：');
    steps.forEach((s, i) => {
      const kind = s?.skill ? s.skill : s?.type ? `非技能步：${s.type}` : '?';
      console.log(`  ${i + 1}. ${s?.as ?? '?'}（${kind}）`);
    });
  }
  console.log(
    '树会在后台按配方执行；进度看 node src/cli.mjs status，完成/失败会在 tree_wait 出现。',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help') return usage();

  if (cmd === 'place') return cmdPlace(args);

  if (cmd === 'task') return cmdTask(args);

  if (cmd === 'status') {
    const s = await call('GET', '/status');
    const progressByName = await fetchProgress();
    const nowMs = Date.now();
    for (const c of s.companions) {
      const mcpCompanion = progressByName?.get(c.name) ?? null;
      const p = mcpCompanion?.progress ?? progressFromStatus(c, nowMs);
      const plan = normalizePlan(mcpCompanion?.plan ?? c.plan);
      console.log(`\n== ${c.name} ==`);
      console.log(`  位置   ${c.pos ? `${short(c.pos.x)}, ${short(c.pos.y)}, ${short(c.pos.z)} (${c.dimension})` : '未知'}`);
      const extras = [];
      if (c.foodCount != null) extras.push(`食物 ${c.foodCount}`);
      if (c.weapon) extras.push(`武器 ${String(c.weapon).replace(/^minecraft:/, '')}`);
      if ((c.animalCount ?? 0) > 0) extras.push(`猎物 ${c.animalCount}`);
      console.log(
        `  状态   HP ${c.hp ?? '?'} / 饥饿 ${c.hunger ?? '?'}${extras.length ? ` / ${extras.join(' / ')}` : ''} / 模式 ${c.mode}${c.paused ? ' / 已暂停' : ''}`,
      );
      if (c.task) console.log(`  任务   ${c.task.task} ${c.task.task_id} (${c.task.state}, ${c.task.elapsed_s}s, 余 ${c.task.budget_left_s}s)`);
      else if (c.detachedTask) console.log(`  任务   后台 ${c.detachedTask.taskId}（${c.detachedTask.skill}）`);
      else if (!p.current_skill) console.log('  任务   空闲');
      // 有 current 时不打"空闲"（观测循环被占住，task 字段可能还是旧值）
      if (p.current_skill) {
        console.log(`  当前   ${p.current_skill}（${p.current_goal_id}），已运行 ${p.running_seconds ?? 0} 秒`);
      } else console.log('  当前   空闲');
      if (plan) console.log(`  计划   ${planProgressText(plan)}`);
      else console.log('  计划   无');
      if (p.last_action) console.log(`  上一动作 ${actionText(p.last_action)}`);
      const pending = p.pending_goals;
      console.log(
        `  队列   ${
          pending.length
            ? pending
                .map((g) => `${g.id}:${g.skill}${g.waited_seconds != null ? `（等待 ${g.waited_seconds} 秒）` : ''}`)
                .join(', ')
            : '空'
        }`,
      );
      if (p.slot_blocked_seconds != null) {
        console.log(`  槽     Lua 槽被占 ${p.slot_blocked_seconds} 秒（连续被拒 ${c.slotBlocked ?? '?'} 次）`);
      }
      console.log(`  连续失败 ${c.consecutiveFailures}`);
    }
    console.log(`\n收件箱序号：${s.inboxSeq}`);
    return;
  }

  if (cmd === 'skills') {
    const s = await call('GET', '/skills');
    for (const k of s.skills) {
      console.log(`- ${k.id.padEnd(14)} ${k.title}`);
      console.log(`    ${JSON.stringify(k.params)}`);
    }
    return;
  }

  if (cmd === 'inbox') {
    const since = Number(args.since || 0);
    const brain = args.brain ? '&brainOnly=1' : '';
    const s = await call('GET', `/inbox?since=${since}${brain}`);
    if (!s.items.length) {
      console.log(`（无新消息，当前序号 ${s.seq}）`);
      return;
    }
    for (const i of s.items) {
      const flag = i.needsBrain ? '★' : ' ';
      console.log(`${flag} #${i.seq} ${i.kind} [${i.companion}] ${i.text ?? JSON.stringify(i.detail ?? i.data ?? '')}`);
    }
    console.log(`\n（当前序号 ${s.seq}）`);
    return;
  }

  if (cmd === 'lines') {
    const s = await call('GET', '/lines');
    console.log(`台词库：${s.count} 条，人设 ${s.persona}${s.enabled ? '' : '（已停用）'}`);
    console.log(`已说 ${s.stats.picks} 次，无可用 ${s.stats.misses} 次\n`);
    for (const e of s.entries) {
      console.log(
        `- ${e.id.padEnd(20)} when=${String(e.when).padEnd(16)} 变体 ${e.variants}  冷却 ${e.cooldownSeconds}s  权重 ${e.weight}`,
      );
    }
    return;
  }

  if (cmd === 'goal') {
    if (!args.companion || !args.skill) {
      console.error('需要 --companion 和 --skill');
      process.exit(2);
    }
    const params = args['params-file']
      ? JSON.parse(fs.readFileSync(args['params-file'], 'utf8'))
      : args.params
        ? JSON.parse(args.params)
        : {};
    const r = await call('POST', '/goal', {
      companion: args.companion,
      skill: args.skill,
      params,
      priority: args.priority ? Number(args.priority) : 0,
    });
    console.log(`已加入队列：${r.goal.id} ${r.goal.skill}`);
    return;
  }

  if (cmd === 'control') {
    if (!args.op) {
      console.error('需要 --op（同伴类操作还要 --companion）');
      process.exit(2);
    }
    const r = await call('POST', '/control', {
      companion: args.companion,
      op: args.op,
      mode: args.mode,
    });
    console.log(JSON.stringify(r.state ?? r, null, 2));
    return;
  }

  if (cmd === 'lock') {
    const showStatus = !args.companion || args.status;
    if (showStatus && !args.all) {
      const r = await call('GET', '/lock');
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const r = await call('POST', '/lock', {
      op: 'unlock',
      companion: args.all ? undefined : args.companion,
      all: !!args.all,
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  usage();
}

main().catch((e) => {
  const msg = String(e?.message || e);
  if (/fetch failed|ECONNREFUSED|other side closed|fetch is not defined/i.test(msg)) {
    console.error('连不上树进程的控制 API（先 node src/daemon.mjs 起树）。');
  } else {
    console.error('出错：', msg);
  }
  process.exit(1);
});

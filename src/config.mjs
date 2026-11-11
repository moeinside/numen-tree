import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  numen: {
    configPath:
      'E:/game/HMCL/.minecraft/versions/1.21.1-NeoForge/config/numen/mcp_server.json',
  },
  control: { host: '127.0.0.1', port: 8766 },
  mcp: { host: '127.0.0.1', port: 8767 },
  loop: {
    tickMs: 1200,
    eventWaitSeconds: 5,
    // 客户端等回执的上限；技能自己另有更短的预算（单次动作必须 < 200 秒）
    actionTimeoutMs: 240_000,
    eventBackoffMs: 2000,
    eventDedupeSeconds: 20,
    // 观测分层：危险字段高频，慢变量低频
    observeFastMs: 1200,
    observeSlowMs: 3600,
    goalStaleSeconds: 120,
    // LLM 目标排队上限（秒）：LLM 目标常排在长动作后面，放宽且作废会叫醒大脑
    mcpGoalStaleSeconds: 300,
    // 自动行为（auto 计划步骤/auto 单目标）单次动作硬上限：让 LLM 最多等这么久就能接管
    autoActionTimeoutSeconds: 60,
  },
  companions: [],
  idle: { enabled: false, skills: [], cooldownSeconds: 30 },
  // 牵引绳：离锚点太远就自己回去（只在没有其它目标时生效）
  // anchor: 'owner' 绑主人（跟着走）| 'home' 绑地点簿里的"家"（不跟人）
  leash: {
    enabled: true,
    anchor: 'home',
    placeName: '家',
    maxDistance: 32,
    minIntervalSeconds: 15,
    maxIntervalSeconds: 120, // 连续失败时退避上限
    escalateAfterFails: 3, // 连续失败几次报一次 "卡住了"
    haltSeconds: 180, // 报"卡住了"后停手多久
    priority: 5,
    skill: 'approach_owner',
    params: { range: 4 },
  },
  // 地点簿：死亡点/基地/主人位置/自定义地点的持久化
  places: {
    file: 'places.json',
    maxEntries: 500,
  },
  // P0-b：GoalProfile + milestone 持久化（不存 plan cursor）
  goalStore: {
    enabled: true,
    file: 'goalstore.json',
    worldId: 'default',
  },
  // 世界记忆：容器内容 / 资源点（M1 最小集）
  worldmem: {
    file: 'world.json',
    maxContainers: 200,
    maxResources: 300,
  },
  // LLM 接管预算（自止）：连续 LLM 驱动超过上限就自动停手，等大脑显式恢复
  drive: {
    maxSeconds: 300, // 一次接管最多连续操作这么久（自主排障需要，太长会失控；接续用 resume/新任务）
    maxGoals: 20, // 一次接管最多执行这么多个 LLM 目标
    idleStopSeconds: 60, // 这么久没有新的 LLM 指令 = 接管结束（回自动模式）
    autoGraceSeconds: 20, // LLM 最近活动后这么久内，自动计划/牵引绳不抢方向盘
  },
  // 放置/建造的安全约束
  build: {
    maxBlocks: 64, // 一次 place_build 最多放多少块
    blockBlacklist: [
      'minecraft:lava',
      'minecraft:flowing_lava',
      'minecraft:water',
      'minecraft:flowing_water',
      'minecraft:tnt',
      'minecraft:fire',
      'minecraft:soul_fire',
      'minecraft:respawn_anchor',
      'minecraft:end_crystal',
      'minecraft:bed',
      'minecraft:white_bed',
    ],
  },
  // 行为模式与仲裁参数（生存闭环 / 战斗评估 / 生产）
  behavior: {
    mode: 'survival',
    // 日程（M1.5）：白天干活 / 夜里守家的时段表在 src/schedule.mjs（数据）；
    // 这里只留总开关。关掉 = 回到 M1 老行为（只靠中断/模式/牵引绳）。
    schedule: { enabled: true },
    // 效用仲裁（docs/24）：普通战略按分数竞争；当前试点 store_materials
    utility: {
      enabled: true,
      minIntervalSeconds: 180,
    },
    // 本能让路：numen 核心反射（逃/防御/脱困/MLG/溺水）触发后，树暂停派动作这么久；
    // 反射归 mod，不要抢槽。由 reflex 事件或"补丁 count=0 但槽被拒"触发。
    instinctHoldSeconds: 8,
    // 连续本能风暴超过这么久 → 树升级上报（instinct_stuck），让 LLM/主人介入
    instinctStuckSeconds: 30,
    // 执行策略层（docs/20 §10）：safe-batch / field-guarded。
    // "安全"看行为证据（reflex/被打断/受伤/敌对/主人危险），不看是否在基地。
    execPolicy: {
      enabled: true,
      gateLongSkills: true,
      batchMaxSeconds: 60,
      quietSeconds: 30,
      downgradeCooldownSeconds: 60,
      dangerHostileDistance: 16,
      preflight: {
        requireFreshMs: 3000,
        hostileRadius: 24,
        minHpPercent: 60,
        minHunger: 8,
        quietMs: 30000,
      },
    },
    // 僵尸锁外部清理：连报 N 次 "a program is already running" 就调补丁控制端口清锁
    // （patcher/ v1.1.0，127.0.0.1:8768；不用重建同伴、不丢背包）
    lockRecovery: {
      enabled: true,
      host: '127.0.0.1',
      port: 8768,
      unlockAfterBlocked: 2,
      minIntervalSeconds: 30,
      timeoutMs: 2500,
    },
    // 内置脑长时间占槽（补丁 count=0）时的保守自救：只尝试一次，长冷却
    brainRecovery: {
      enabled: true,
      blockedSeconds: 120,
      cooldownSeconds: 300,
      maxPerHour: 3,
      skipOwnerDangerSeconds: 60,
    },
    // 只读触手 mod（numen_tree_tentacle，127.0.0.1:8769）；不在时树自动回退
    tentacle: {
      enabled: true,
      host: '127.0.0.1',
      port: 8769,
      timeoutMs: 2500,
      primaryObserveMs: 3000,
      radius: 16,
    },
    // 求生：血/饿阈值、觅食参数、求助节奏
    survival: {
      retreatHp: 8,
      eatHunger: 6, // 饿到这就吃
      healHunger: 18, // 受伤时吃到这个饥饿值（MC 自然回血要 ≥18）
      forageHunger: 12, // 饿到这就主动找吃的（有猎物就猎，没有就出去找）
      fleeDistance: 16,
      dangerRange: 8, // 敌人在这个距离内 + 血不满 → 先撤
      panicHpPercent: 65, // "血不满"的门槛（%）
      nightGuardHpPercent: 80, // 天黑+有敌+血低于这个（%）→ 先撤
      regroupDistance: 8, // 重伤且没吃的：离主人超过这个距离就回去
      maxRoamDistance: 48, // 觅食不许跑得比这更远离主人
      forageRadius: 32, // 找猎物扫描半径（与观测半径一致，否则看见猎物却打不到）
      forageMax: 2, // 一次最多猎几只
      foodSearchRadius: 24, // 找食物容器扫描半径
      seekSeconds: 40, // 出去找食物走多久
      starvingEscalateSeconds: 180, // 饿且没吃的持续多久就上报"要饿死了"
      starvingRepeatSeconds: 180, // 两次求助的最小间隔
      starvingHaltSeconds: 0, // 饿死也不停手：0=不停（用户要求：饿死比卡着强）
      foodRetrySeconds: 60, // 找食物失败后，多久再试；期间允许其它行动计划
      stuckHaltSeconds: 120, // 卡住/掉坑等"停手类"中断的停手时长（和饥饿分开）
    },
    // 战斗评估表：血 > 60% 且有武器 → 打；≤ 40% / 没武器 / 被围 → 撤
    combat: {
      radius: 16,
      attackHpPercent: 60,
      fleeHpPercent: 40,
      maxTargets: 2,
      noWeaponFleeDistance: 10,
    },
    production: {
      blocks: [
        'minecraft:oak_log',
        'minecraft:birch_log',
        'minecraft:spruce_log',
        'minecraft:jungle_log',
        'minecraft:acacia_log',
        'minecraft:dark_oak_log',
        'minecraft:stone',
      ],
      count: 8,
      radius: 32,
    },
    // 自动行为失败够几次才升成一次规则级求助（自己还能处理的不报）
    escalateAfterAutoFails: 3,
    // 同类求助静默窗口：窗口内重复的只当通知（不叫醒），避免连续死亡/卡住刷爆大脑
    escalateDedupeSeconds: 300,
    // 主人挨打求助半径 / 贴脸有怪的判定
    ownerDangerRange: 24,
    hostileCloseRange: 6,
    hostileCloseHpPercent: 85,
    // 分片动作最多续几段（每段之间会先跑中断检查）
    maxChunkRounds: 8,
    cooldowns: { retreat: 20, eat: 6, forage: 15, seekFood: 45, regroup: 30, fight: 10, gather: 30 },
  },
  trace: { dir: 'logs', keepDays: 14 },
  // 台词库：只存数据，运行时机械选择；生成/更新以后再做
  lines: { enabled: true, dir: 'lines', persona: 'default', minGapSeconds: 8 },
};

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export function loadConfig(file = path.join(ROOT, 'tree.config.json')) {
  let user = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const cfg = deepMerge(DEFAULTS, user);
  cfg.control.url = `http://${cfg.control.host}:${cfg.control.port}`;
  cfg.trace.dir = path.resolve(ROOT, cfg.trace.dir);
  cfg.lines.dir = path.resolve(ROOT, cfg.lines.dir);
  cfg.places.file = path.resolve(ROOT, cfg.places.file);
  cfg.worldmem.file = path.resolve(ROOT, cfg.worldmem.file);
  if (cfg.goalStore?.file) cfg.goalStore.file = path.resolve(ROOT, cfg.goalStore.file);
  return cfg;
}

/** 读取 numen 自己的 MCP 配置（只读）：host / port / token。 */
export function loadNumenEndpoint(cfg) {
  const p = cfg.numen.configPath;
  if (!fs.existsSync(p)) {
    throw new Error(`找不到 numen MCP 配置：${p}`);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    host: raw.host || '127.0.0.1',
    port: raw.port || 8765,
    token: raw.token,
    callTimeoutSeconds: raw.call_timeout_seconds || 300,
    endpoint: `http://${raw.host || '127.0.0.1'}:${raw.port || 8765}/mcp`,
  };
}

/**
 * 状态层：
 *  - Blackboard：每个同伴一份"树对它的认知"
 *  - Goal：命令盒里的一个目标（技能卡 + 参数 + 优先级）
 *  - Inbox：要上报给上层的条目（事件 / 求助），带自增序号供拉取
 */

import { planView } from './plan.mjs';

let goalSeq = 0;

export const GoalStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DETACHED: 'detached',
};

export function makeGoal({ skill, params = {}, priority = 0, note = '' }) {
  return {
    id: `g${++goalSeq}`,
    skill,
    params,
    priority,
    note,
    status: GoalStatus.PENDING,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    attempts: 0,
    lastResult: null,
  };
}

export class Inbox {
  constructor() {
    this.seq = 0;
    this.items = [];
  }

  push(entry) {
    const item = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      ...entry,
    };
    this.items.push(item);
    if (this.items.length > 500) this.items.splice(0, this.items.length - 500);
    return item;
  }

  since(seq = 0) {
    return this.items.filter((i) => i.seq > seq);
  }
}

export class CompanionState {
  constructor({ name, id }) {
    this.name = name;
    this.id = id;

    // 行为模式：survival 生存 | production 生产 | combat 战斗
    this.mode = 'survival';
    this.paused = false;
    this.lastAutoAt = {}; // 自动行为冷却：{ eat, retreat, fight, gather }
    this.gatherIndex = 0; // 生产模式：轮换尝试的方块类型
    this.gatherFails = 0; // 生产模式：连续找不到资源的次数（够多就出去探）

    this.goals = [];
    this.current = null; // { goalId, skill, startedAt }
    this.detachedTask = null; // { taskId, skill, at }

    // 环境感知（树自己的"小脑"用来做仲裁）
    this.hostileCount = 0;
    this.hostileDistance = null;
    this.dark = false; // 世界是不是黑天/暗处（world.is_dark_outside）
    this.deathAt = null; // 最近一次死亡时间

    // 觅食闭环用的感知：背包里的食物 / 手里的家伙 / 附近的猎物
    this.foodCount = null; // 背包里可吃的东西总数（null = 还没观测到）
    this.foodKinds = 0; // 有几种可吃的
    this.weapon = null; // 最好的武器 id（剑/斧），没有就是 null
    this.weaponScore = 0; // 粗略等级：木1 石2 铁3 金1 钻石4 下界合金5
    this.held = null; // 手持物 id（空手 null）
    this.animalCount = 0; // 附近可猎杀的被动生物数（牛/猪/羊/鸡/兔）
    this.animalDistance = null;
    this.animalType = null;
    this.inventory = []; // 背包概览（最多 24 种：{item,count}，给 LLM 挑方块/材料）

    // 自动行为的记账（用于退避与"报了就停手"）
    this.autoFails = {}; // { eat: 2, forage: 1, seekFood: 1, ... }
    this.starvingSince = null; // 从什么时候开始"饿且没吃的"
    this.lastStarvingReportAt = 0;
    this.survivalHaltedUntil = 0; // 上报"要饿死了"之后暂停自动求生，等大脑
    this.lastAction = null; // 最近一次动作结果 { skill, ok, kind, message, ms, at }
    this.lastHeartbeatAt = null; // 长任务期间 timer 事件的心跳时间（靠 numen.task.timer）
    this.lastEventAt = {}; // 事件去重：{ kind: 上次时间 }
    this.eventSuppressed = 0; // 被去重掉的事件数（只记账，不刷屏）

    // 计划层（M1）：同一时间只有一个计划；计划历史留最近几条
    this.plan = null;
    this.planHistory = [];
    this.lastInterruptAt = {}; // { interruptId: 时间戳 } 防抖动
    this.lastAnyInterruptAt = 0; // 任意中断动作的全局最小间隔（防连派）
    this.stuckSince = null; // 连续走不过去的起点（stuck 中断用）
    this.currentPlanStep = null;

    // LLM 接管预算（自止）：一次接管从第一次 LLM 指令开始记，超预算自动停手
    this.driveStartedAt = null;
    this.driveGoals = 0;
    this.lastLlmGoalAt = 0;
    this.driveStopReason = null;

    this.pos = null;
    this.hp = null;
    this.hunger = null;
    this.dimension = null;
    this.gameTime = null;
    this.taskStatus = null;

    // 主人的位置与距离（牵引绳用）
    this.ownerOnline = null;
    this.ownerDistance = null;
    this.ownerPos = null;
    this.lastLeashAt = 0;
    this.leashHaltedUntil = 0; // 回主人连续失败上报"卡住了"之后，停手等大脑
    this.tether = 'home'; // 牵引绳绑谁：'owner'（跟着主人）| 'home'（绑地点簿的"家"）
    this.ownerDangerAt = 0; // 最近一次收到"主人挨打/危险"事件的时间

    // 日程（M1.5）：当前时段段（schedule.mjs 数据）+ 巡逻路点轮换指针
    this.schedule = null; // { id, title, hasHome, leashMaxDistance, nightGuard }
    this.patrolIndex = 0;

    this.lastTickAt = 0;
    this.lastActionAt = 0;
    this.consecutiveFailures = 0;
    this.idleSince = Date.now();
    this.lastIdleAt = 0;

    // Lua 槽被别人占用的迹象（另一个会话 / 内置脑 / 遗留程序）
    this.slotBlocked = 0;
    this.slotBlockedSince = null;
    this.slotBlockedNotified = 0; // 0=未报 / 1=已报 / 2=已报持久化建议

    this.actionLock = false; // 同一同伴同一时间只能有一个动作在飞
  }

  pushGoal(goal) {
    this.goals.push(goal);
    this.goals.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    return goal;
  }

  nextGoal() {
    const g = this.goals.find((x) => x.status === GoalStatus.PENDING);
    return g || null;
  }

  cancelAll(reason = 'cleared') {
    for (const g of this.goals) {
      if (g.status === GoalStatus.PENDING || g.status === GoalStatus.RUNNING) {
        g.status = GoalStatus.CANCELLED;
        g.endedAt = new Date().toISOString();
        g.lastResult = { reason };
      }
    }
    this.goals = this.goals.filter(
      (g) => g.status !== GoalStatus.CANCELLED && g.status !== GoalStatus.DONE,
    );
  }

  snapshot() {
    return {
      name: this.name,
      id: this.id,
      mode: this.mode,
      paused: this.paused,
      pos: this.pos,
      hp: this.hp,
      hunger: this.hunger,
      dimension: this.dimension,
      gameTime: this.gameTime,
      ownerOnline: this.ownerOnline,
      ownerDistance: this.ownerDistance,
      tether: this.tether,
      schedule: this.schedule,
      hostileCount: this.hostileCount,
      hostileDistance: this.hostileDistance,
      execMode: this.execMode ?? 'safe-batch',
      execReason: this.execReason ?? 'init',
      execSince: this.execSince ?? null,
      lastObservedAt: this.lastObservedAt ?? null,
      dark: this.dark,
      deathAt: this.deathAt,
      // 觅食 / 战斗评估用的感知
      foodCount: this.foodCount,
      foodKinds: this.foodKinds,
      weapon: this.weapon,
      weaponScore: this.weaponScore,
      held: this.held,
      animalCount: this.animalCount,
      animalDistance: this.animalDistance,
      animalType: this.animalType,
      inventory: this.inventory,
      // 自动行为记账
      autoFails: this.autoFails,
      starvingSince: this.starvingSince,
      survivalHaltedUntil: this.survivalHaltedUntil,
      leashHaltedUntil: this.leashHaltedUntil,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      eventSuppressed: this.eventSuppressed,
      task: this.taskStatus,
      detachedTask: this.detachedTask,
      current: this.current,
      goals: this.goals.map((g) => ({
        id: g.id,
        skill: g.skill,
        params: g.params,
        priority: g.priority,
        status: g.status,
        attempts: g.attempts,
        lastResult: g.lastResult,
      })),
      busy: this.actionLock,
      plan: this.plan ? planView(this.plan) : null,
      drive: this.driveStartedAt
        ? {
            startedAt: this.driveStartedAt,
            goals: this.driveGoals,
            lastGoalAt: this.lastLlmGoalAt,
            stopReason: this.driveStopReason,
          }
        : null,
      lastTickAt: this.lastTickAt,
      slotBlocked: this.slotBlocked,
      slotBlockedSince: this.slotBlockedSince,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

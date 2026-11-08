/**
 * 中断表（数据）：回答"正在干活时遇到 X 怎么办"。
 *
 * 约定（见 docs/12 §2.3）：
 *  - priority：越大越优先（90+ 是保命级）
 *  - cooldownSeconds：同一中断两次之间至少隔多久（防抖动）
 *  - when(st, cfg)：纯判断，只读状态，不产生副作用
 *  - goal：命中后要执行的动作（单个技能）
 *  - plan：命中后要执行的计划（配方 id）；没有 goal 时用
 *  - resume：中断结束后怎么对待被抢占的计划
 *      resume  = 继续原计划（游标不动）
 *      restart = 从头再来
 *      abandon = 作废原计划
 *  - halt：true 表示"停手等大脑"（不再派动作，只上报）
 *
 * 纪律：安全/保命只许写在这里，不许写进配方；配方里也不许写"血低就撤"。
 */

export const INTERRUPTS = [
  // 1) 血很低且身边有敌人：立刻撤
  {
    id: 'near_death',
    priority: 95,
    cooldownSeconds: 20,
    resume: 'resume',
    when: (st, cfg) => {
      const hpPct = ((st.hp ?? 20) / 20) * 100;
      return (st.hostileCount ?? 0) > 0 && hpPct <= Number(cfg?.behavior?.combat?.fleeHpPercent ?? 40);
    },
    goal: { skill: 'retreat', params: { distance: 16 } },
    why: (st) => `hp ${Math.round(((st.hp ?? 20) / 20) * 100)}% 且有 ${st.hostileCount} 个敌对`,
  },

  // 2) 被围（敌人数量超过上限）且血不满：撤
  {
    id: 'outnumbered',
    priority: 90,
    cooldownSeconds: 20,
    resume: 'resume',
    when: (st, cfg) => {
      const maxTargets = Number(cfg?.behavior?.combat?.maxTargets ?? 2);
      const hpPct = ((st.hp ?? 20) / 20) * 100;
      return (st.hostileCount ?? 0) > maxTargets && hpPct <= 60;
    },
    goal: { skill: 'retreat', params: { distance: 16 } },
    why: (st) => `敌对 ${st.hostileCount} 个，被围`,
  },

  // 3) 夜里 + 有敌 + 血不满：回家守家（走配方；没记"家"就退回主人身边）
  //    日程表（schedule.mjs）已经在守家时不再抢计划槽——守卫/巡逻由仲裁层按时段接管。
  {
    id: 'night_danger',
    priority: 80,
    cooldownSeconds: 60,
    resume: 'resume',
    when: (st, cfg) => {
      const hpPct = ((st.hp ?? 20) / 20) * 100;
      return (
        st.dark === true &&
        !st.schedule?.nightGuard &&
        (st.hostileCount ?? 0) > 0 &&
        hpPct < Number(cfg?.behavior?.survival?.nightGuardHpPercent ?? 80)
      );
    },
    plan: 'go_home',
    // 兜底：已经有一个计划在跑、开不了第二个计划时，至少先回主人身边
    goal: { skill: 'go_to', params: { target: 'owner', range: 4 } },
    why: (st) => `天黑、有 ${st.hostileCount} 个敌对`,
  },

  // 4) 卡住：位置长时间没变、连续走不过去
  {
    id: 'stuck',
    priority: 85,
    cooldownSeconds: 180,
    resume: 'abandon',
    when: (st) => !!st.stuckSince && Date.now() - st.stuckSince > 45_000,
    halt: true,
    escalate: 'stuck',
    why: () => '位置 45 秒没变，很可能卡住了',
  },

  // 5) 主人挨打/危险：有武器就过去帮忙（护主），没武器先自保
  {
    id: 'owner_danger_help',
    priority: 78,
    cooldownSeconds: 20,
    resume: 'resume',
    when: (st, cfg) => {
      const recent = st.ownerDangerAt && Date.now() - st.ownerDangerAt < 15_000;
      const near = st.ownerDistance != null && st.ownerDistance <= Number(cfg?.behavior?.ownerDangerRange ?? 24);
      return recent && near && (st.hostileCount ?? 0) > 0 && !!st.weapon;
    },
    goal: { skill: 'fight_safe', params: { radius: 12, minHp: 8, maxTargets: 2 } },
    why: (st) => `主人挨打/危险（${Math.round((Date.now() - (st.ownerDangerAt || 0)) / 1000)}s 前），有武器去帮忙`,
  },
  {
    id: 'owner_danger_hide',
    priority: 76,
    cooldownSeconds: 20,
    resume: 'resume',
    when: (st, cfg) => {
      const recent = st.ownerDangerAt && Date.now() - st.ownerDangerAt < 15_000;
      const near = st.ownerDistance != null && st.ownerDistance <= Number(cfg?.behavior?.ownerDangerRange ?? 24);
      return recent && near && (st.hostileCount ?? 0) > 0 && !st.weapon;
    },
    goal: { skill: 'retreat', params: { distance: 16 } },
    why: () => '主人挨打/危险，但我没有武器 → 先自保',
  },

  // 6) 身边贴脸有怪：别闷头赶路，先处理（有武器打，没武器撤）
  {
    id: 'hostile_close_fight',
    priority: 70,
    cooldownSeconds: 25,
    resume: 'resume',
    when: (st, cfg) => {
      const hpPct = ((st.hp ?? 20) / 20) * 100;
      return (
        (st.hostileCount ?? 0) > 0 &&
        st.hostileDistance != null &&
        st.hostileDistance <= Number(cfg?.behavior?.hostileCloseRange ?? 6) &&
        hpPct <= Number(cfg?.behavior?.hostileCloseHpPercent ?? 85) &&
        !!st.weapon
      );
    },
    goal: { skill: 'fight_safe', params: { radius: 10, minHp: 8, maxTargets: 2 } },
    why: (st) => `敌对贴脸（${st.hostileDistance} 格）`,
  },
  {
    id: 'hostile_close_flee',
    priority: 69,
    cooldownSeconds: 25,
    resume: 'resume',
    when: (st, cfg) => {
      const hpPct = ((st.hp ?? 20) / 20) * 100;
      return (
        (st.hostileCount ?? 0) > 0 &&
        st.hostileDistance != null &&
        st.hostileDistance <= Number(cfg?.behavior?.hostileCloseRange ?? 6) &&
        hpPct <= Number(cfg?.behavior?.hostileCloseHpPercent ?? 85) &&
        !st.weapon
      );
    },
    goal: { skill: 'retreat', params: { distance: 16 } },
    why: (st) => `敌对贴脸（${st.hostileDistance} 格）且没武器`,
  },
];

/** 按优先级从高到低取第一条成立、且冷却已过、且不是当前正在执行的中断。 */
export function pickInterrupt({ state, cfg, now = Date.now(), activeInterruptIds = [] }) {
  const sorted = [...INTERRUPTS].sort((a, b) => b.priority - a.priority);
  for (const it of sorted) {
    if (activeInterruptIds.includes(it.id)) continue;
    const last = state.lastInterruptAt?.[it.id] || 0;
    if (now - last < Number(it.cooldownSeconds ?? 0) * 1000) continue;
    let hit = false;
    try {
      hit = !!it.when(state, cfg);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    return {
      entry: it,
      why: typeof it.why === 'function' ? it.why(state) : String(it.why ?? ''),
    };
  }
  return null;
}

export function getInterrupt(id) {
  return INTERRUPTS.find((i) => i.id === id) || null;
}

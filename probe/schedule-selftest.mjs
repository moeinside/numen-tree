#!/usr/bin/env node
/**
 * 日程表（M1.5）离线自测 —— 只测 src/schedule.mjs 的纯函数 + 数据形态。
 *
 * 不连游戏、不碰 Lane；Lane 的接入行为由 probe/replay.mjs 的 day_work / night_guard 场景覆盖。
 * 用法：node probe/schedule-selftest.mjs
 */

import {
  OFF_SEGMENT,
  SCHEDULES,
  allow,
  hasTool,
  patrolTarget,
  pickSegment,
} from '../src/schedule.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// ── 1. 选段：夜晚/白天 × 有没有记"家" ───────────────────────────
const nightState = { dark: true };
const dayState = { dark: false };

eq('夜里 + 有家 → night', pickSegment(nightState, { hasHome: true }).id, 'night');
eq('夜里 + 没家 → night_nohome', pickSegment(nightState, { hasHome: false }).id, 'night_nohome');
eq('白天 → day', pickSegment(dayState, { hasHome: true }).id, 'day');
eq('白天（没家）→ day', pickSegment(dayState, { hasHome: false }).id, 'day');
eq('状态缺 dark 字段也能兜底 → day', pickSegment({}, {}).id, 'day');

// ── 2. 白名单：未声明的键允许；false 才禁止 ─────────────────────
const nightSeg = pickSegment(nightState, { hasHome: true });
const daySeg = pickSegment(dayState, { hasHome: true });

eq('夜里 production 被禁止', allow(nightSeg, 'production'), false);
eq('夜里 dayWork 被禁止', allow(nightSeg, 'dayWork'), false);
eq('夜里 guard 允许', allow(nightSeg, 'guard'), true);
eq('夜里 patrol 允许', allow(nightSeg, 'patrol'), true);
eq('白天 dayWork 允许', allow(daySeg, 'dayWork'), true);
eq('白天 guard 禁止', allow(daySeg, 'guard'), false);
eq('未声明的键默认允许', allow(daySeg, 'no_such_key'), true);
eq('日程关闭段不禁止生产', allow(OFF_SEGMENT, 'production'), true);
eq('日程关闭段不做 guard', allow(OFF_SEGMENT, 'guard'), false);

// ── 3. 白天自动开工候选（数据形态）────────────────────────────
const workKeys = (daySeg.work || []).map((w) => w.key);
check('白天 work 含 gather_wood', workKeys.includes('gather_wood'), workKeys.join(','));
check('白天 work 含 mine_stone', workKeys.includes('mine_stone'), workKeys.join(','));
check('白天 work 含 bootstrap_kit（装备兜底）', workKeys.includes('bootstrap_kit'), workKeys.join(','));
check('白天 work 含 craft_tools（缺镐/斧时补）', workKeys.includes('craft_tools'), workKeys.join(','));
const stoneWork = (daySeg.work || []).find((w) => w.key === 'mine_stone');
eq('mine_stone 需要镐', stoneWork?.requires, 'pickaxe');
const bootstrapWork = (daySeg.work || []).find((w) => w.key === 'bootstrap_kit');
eq('bootstrap_kit 只在没武器时开', bootstrapWork?.requires, 'no_weapon');
const toolsWork = (daySeg.work || []).find((w) => w.key === 'craft_tools');
eq('craft_tools 只在缺工具时开', toolsWork?.requires, 'missing_tool');
check('bootstrap_kit 排在最前（没武器优先级最高）', workKeys[0] === 'bootstrap_kit', workKeys.join(','));
check('每个 work 候选都指向配方（有 recipe）', (daySeg.work || []).every((w) => !!w.recipe));
check('每个 work 候选都有冷却秒数', (daySeg.work || []).every((w) => Number(w.cooldownSeconds) > 0));

// ── 4. 夜间守卫/巡逻参数（数据形态）──────────────────────────
check('night.guard 开启', nightSeg.guard?.enabled !== false);
check('night.guard 半径合理（4~24）', Number(nightSeg.guard?.radius) >= 4 && Number(nightSeg.guard?.radius) <= 24, String(nightSeg.guard?.radius));
check('night.guard 要求武器', nightSeg.guard?.requireWeapon === true);
check('night.guard 有血线', Number(nightSeg.guard?.minHpPercent) > 0 && Number(nightSeg.guard?.minHpPercent) <= 100);
eq('night.guard 用 fight_safe', nightSeg.guard?.skill, 'fight_safe');
eq('night.patrol 开启', nightSeg.patrol?.enabled, true);
check('night.patrol 半径 ≤ guard 半径', Number(nightSeg.patrol?.radius) <= Number(nightSeg.guard?.radius));
eq('night.leash 收紧到 16', nightSeg.leash?.maxDistance, 16);
eq('day.leash 放宽到 48', daySeg.leash?.maxDistance, 48);

// ── 5. 巡逻路点：绕家四个角按序轮换 ─────────────────────────
const home = { x: 100, y: 64, z: -40 };
const r = Number(nightSeg.patrol.radius);
const corners = [0, 1, 2, 3].map((i) => patrolTarget(nightSeg, { homePos: home, index: i }));
eq('路点 0 在 +X 角', `${corners[0].x},${corners[0].y},${corners[0].z}`, `${home.x + r},${home.y},${home.z}`);
eq('路点 1 在 +Z 角', `${corners[1].x},${corners[1].y},${corners[1].z}`, `${home.x},${home.y},${home.z + r}`);
eq('路点 2 在 -X 角', `${corners[2].x},${corners[2].y},${corners[2].z}`, `${home.x - r},${home.y},${home.z}`);
eq('路点 3 在 -Z 角', `${corners[3].x},${corners[3].y},${corners[3].z}`, `${home.x},${home.y},${home.z - r}`);
eq('index 4 回到路点 0', patrolTarget(nightSeg, { homePos: home, index: 4 }).x, home.x + r);
eq('没有家坐标 → null', patrolTarget(nightSeg, { homePos: null, index: 0 }), null);
eq('坐标非法 → null', patrolTarget(nightSeg, { homePos: { x: 'a', y: 1, z: 2 }, index: 0 }), null);

// ── 6. 工具判断 ───────────────────────────────────────────────
const invWithPick = [
  { item: 'minecraft:stone_pickaxe', count: 1 },
  { item: 'minecraft:oak_log', count: 8 },
];
const invNoPick = [{ item: 'minecraft:oak_log', count: 8 }];
eq('有石镐 → true', hasTool(invWithPick, 'pickaxe'), true);
eq('只有木头 → false', hasTool(invNoPick, 'pickaxe'), false);
eq('空背包 → false', hasTool([], 'pickaxe'), false);
eq('背包字段缺失 → false', hasTool(undefined, 'pickaxe'), false);

// ── 汇总 ─────────────────────────────────────────────────────
console.log(`日程表自测：${pass}/${pass + fail} 通过`);
if (fail) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部通过（选段/白名单/开工候选/守卫巡逻参数/路点/工具判断）');
}

// 引用未用到的导出，避免 lint 误报（同时验证导出存在）
void SCHEDULES;

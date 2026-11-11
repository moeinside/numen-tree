/**
 * 配方表（数据，不是代码）：一条配方 = 一件"有始有终"的事。
 *
 * 约定（见 docs/12 §2.2）：
 *  - match：主人/大脑的模糊说法（中英都要），空的说法由 plan.mjs 模糊匹配
 *  - steps[].as：步骤标签，转移用
 *  - steps[].next：成功后去哪（null = 计划完成）
 *  - steps[].onFail：失败 kind → 标签 / 'retry' / 'report'
 *  - steps[].maxVisits：同一标签最多进几次（防死循环）
 *  - steps[].params.place：地点簿名字，由 lane 解析成坐标
 *  - type:'report' 的步骤不调技能：上报后结束计划（用于"试过了，不行"）
 *  - doneWhen(state,cfg)：每步前检查，成立就正常结束（用于"守到天亮"这类）
 *
 * 加新任务 = 往这里加一条；不要改核心。
 */

export const RECIPES = [
  // ── 1. 觅食闭环（自动，不进 MCP 工具面）─────────────────────────
  {
    id: 'feed',
    title: '自己找吃的',
    source: 'auto',
    match: ['找吃的', '觅食', '吃饭', '饿了', 'find food', 'eat'],
    steps: [
      {
        as: 'eat',
        skill: 'eat',
        params: { count: 4 },
        next: 'done',
        maxVisits: 3,
        onFail: { not_found: 'forage', failed: 'forage', bad_argument: 'forage' },
      },
      {
        as: 'forage',
        skill: 'forage',
        params: { radius: 32, max: 2 },
        next: 'eat',
        maxVisits: 2,
        onFail: { not_found: 'seek' },
      },
      {
        as: 'seek',
        skill: 'seek_food',
        // 预算收紧：scan 半径小一点、段数少一点，降低"程序挂死"的概率
        params: { radius: 16, seconds: 24, maxRoam: 40 },
        next: 'eat',
        maxVisits: 2,
        onFail: { not_found: 'report', no_path: 'report' },
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'starving',
        params: { message: '饿了三轮还是没找到吃的' },
        next: null,
      },
    ],
  },

  // ── 2. 回家守家（自动/夜间，也可被 LLM 点名）─────────────────────
  {
    id: 'go_home',
    title: '回家（夜里/危险时守家）',
    source: 'auto',
    match: ['回家', '回家过夜', '回基地', '守家', 'go home', 'come home'],
    // 天亮且没有威胁，就正常结束（"守家"结束条件只看环境，不看血量）
    doneWhen: (st) => !st.dark && (st.hostileCount ?? 0) === 0,
    steps: [
      {
        as: 'home',
        skill: 'go_to',
        params: { place: '家', range: 4 },
        next: 'hold',
        maxVisits: 2,
        onFail: { not_found: 'owner', no_path: 'owner', failed: 'owner' },
      },
      {
        as: 'owner',
        skill: 'approach_owner',
        // 目标点动态刷新：跟着移动中的主人走，不会跑到旧坐标
        params: { range: 4, chunkSeconds: 8, maxChunks: 4 },
        next: 'hold',
        maxVisits: 1,
        onFail: { owner_offline: 'hold', no_path: 'report' },
      },
      {
        as: 'hold',
        skill: 'idle',
        params: { seconds: 15 },
        next: 'hold',
        maxVisits: 999,
      },
    ],
  },

  // ── 3. 砍木头存箱子（LLM 任务，M1 验收切片）─────────────────────
  {
    id: 'stock_wood',
    title: '砍木头存进箱子',
    source: 'llm',
    match: ['把木头存了', '存木头', '木材入库', '砍木头', 'stock wood'],
    steps: [
      {
        as: 'chop',
        skill: 'dig_nearby',
        params: { block: 'minecraft:oak_log', count: 8, radius: 32 },
        next: 'home',
        maxVisits: 2,
        onFail: { not_found: 'seek', no_path: 'seek' },
      },
      {
        as: 'seek',
        skill: 'explore',
        params: { seconds: 20 },
        next: 'chop',
        maxVisits: 1,
        onFail: { no_path: 'report' },
      },
      {
        as: 'home',
        skill: 'go_to',
        params: { place: '家', range: 4 },
        next: 'store',
        maxVisits: 2,
        onFail: { not_found: 'report_nohome', no_path: 'report_nohome' },
      },
      {
        as: 'store',
        skill: 'store_items',
        params: { item: 'minecraft:oak_log' },
        next: 'done',
        maxVisits: 2,
        onFail: { not_found: 'chest', failed: 'chest' },
      },
      {
        as: 'chest',
        skill: 'craft',
        params: { item: 'minecraft:chest' },
        next: 'store',
        maxVisits: 1,
        onFail: { not_found: 'report', failed: 'report' },
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '存木头没走通' },
        next: null,
      },
      {
        as: 'report_nohome',
        type: 'report',
        escalate: 'no_home',
        params: { message: '地点簿里没有叫"家"的地点，不知道往哪存' },
        next: null,
      },
    ],
  },
  // ── 6. 白天自动开工（日程表 work 候选；auto，不进 tree_task 匹配面）─────
  {
    id: 'gather_wood',
    title: '砍点木头（自动开工）',
    source: 'auto',
    match: ['砍木头', '采木头', 'gather wood'],
    // 一次只挖一种方块，所以按"当地常见树种"逐个试；都找不到就出去探一段再来。
    steps: [
      {
        // 有斧头就换手上（砍树更快；没有斧也能徒手/用剑，继续走）
        as: 'equip_axe',
        skill: 'equip',
        params: { items: 'stone_axe,iron_axe,wooden_axe' },
        next: 'chop_oak',
        maxVisits: 1,
        onFail: { no_material: 'chop_oak', failed: 'chop_oak' },
      },
      {
        as: 'chop_oak',
        skill: 'mine_nearby',
        params: { block: 'minecraft:oak_log', count: 8, radius: 32, countPerChunk: 4, maxClusters: 2 },
        next: 'collect',
        maxVisits: 2,
        // 会走近再挖并顺手捡；挖到一部分后某簇够不着 → 也先去 collect，不要整条计划失败
        onFail: {
          not_found: 'chop_spruce',
          no_path: 'chop_spruce',
          out_of_reach: 'collect',
          failed: 'collect',
        },
      },
      {
        as: 'chop_spruce',
        skill: 'mine_nearby',
        params: { block: 'minecraft:spruce_log', count: 8, radius: 32, countPerChunk: 4, maxClusters: 2 },
        next: 'collect',
        maxVisits: 2,
        onFail: {
          not_found: 'chop_birch',
          no_path: 'chop_birch',
          out_of_reach: 'collect',
          failed: 'collect',
        },
      },
      {
        as: 'chop_birch',
        skill: 'mine_nearby',
        params: { block: 'minecraft:birch_log', count: 8, radius: 32, countPerChunk: 4, maxClusters: 2 },
        next: 'collect',
        maxVisits: 2,
        onFail: { not_found: 'seek', no_path: 'seek', out_of_reach: 'collect', failed: 'collect' },
      },
      {
        // work.dig 只打碎方块，掉落物要单独捡（否则背包永远是空的）
        as: 'collect',
        skill: 'collect_items',
        params: { radius: 16 },
        next: 'done',
        maxVisits: 2,
        onFail: { failed: 'done' },
      },
      {
        as: 'seek',
        skill: 'explore',
        params: { seconds: 20 },
        next: 'chop_oak',
        maxVisits: 2,
        onFail: { no_path: 'report' },
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '附近找不到能砍的木头' },
        next: null,
      },
    ],
  },
  {
    id: 'mine_stone',
    title: '挖点石头（自动开工，需要镐）',
    source: 'auto',
    match: ['挖石头', '采石', 'mine stone'],
    steps: [
      {
        // 挖石头前换镐（拿着剑也能挖，但换对工具更稳）
        as: 'equip_pick',
        skill: 'equip',
        params: { items: 'stone_pickaxe,iron_pickaxe,wooden_pickaxe' },
        next: 'dig',
        maxVisits: 1,
        onFail: { no_material: 'dig', failed: 'dig' },
      },
      {
        // 用 mine_nearby：模块会走到石头边再挖并顺手捡起（dig 只挖手够得着的，地下石头够不着）
        as: 'dig',
        skill: 'mine_nearby',
        params: { block: 'minecraft:stone', count: 8, radius: 24, maxClusters: 2 },
        next: 'done',
        maxVisits: 2,
        onFail: { not_found: 'seek', no_path: 'seek', out_of_reach: 'seek' },
      },
      {
        as: 'seek',
        skill: 'explore',
        params: { seconds: 20 },
        next: 'dig',
        maxVisits: 1,
        onFail: { no_path: 'report' },
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '附近找不到石头' },
        next: null,
      },
    ],
  },

  // ── 11. 装备兜底（auto）：没武器/工具时自己采木→做台→木剑+木镐 ──────
  // 由日程表在"白天 + 没武器"时自动开（死亡重生后背包清空就会走这条），带 600s 冷却。
  {
    id: 'weapon_first',
    title: 'Weapon first: 2 logs -> table -> wooden sword -> equip',
    source: 'llm',
    match: ['先做武器', '武器优先', '做木剑', 'weapon first'],
    steps: [
      {
        as: 'chop_oak',
        skill: 'mine_nearby',
        params: { block: 'minecraft:oak_log', count: 2, radius: 32, countPerChunk: 2, maxClusters: 1 },
        next: 'collect',
        maxVisits: 1,
        onFail: { not_found: 'chop_spruce', no_path: 'chop_spruce', out_of_reach: 'collect', failed: 'collect' },
      },
      {
        as: 'chop_spruce',
        skill: 'mine_nearby',
        params: { block: 'minecraft:spruce_log', count: 2, radius: 32, countPerChunk: 2, maxClusters: 1 },
        next: 'collect',
        maxVisits: 1,
        onFail: { not_found: 'chop_birch', no_path: 'chop_birch', out_of_reach: 'collect', failed: 'collect' },
      },
      {
        as: 'chop_birch',
        skill: 'mine_nearby',
        params: { block: 'minecraft:birch_log', count: 2, radius: 32, countPerChunk: 2, maxClusters: 1 },
        next: 'collect',
        maxVisits: 1,
        onFail: { not_found: 'report', no_path: 'report', out_of_reach: 'collect', failed: 'collect' },
      },
      {
        as: 'collect',
        skill: 'collect_items',
        params: { radius: 16 },
        next: 'table',
        maxVisits: 1,
        onFail: { failed: 'table' },
      },
      {
        as: 'table',
        skill: 'craft',
        params: { item: 'minecraft:crafting_table', chain: true, count: 1 },
        next: 'place',
        maxVisits: 1,
        onFail: { no_material: 'report', failed: 'report' },
      },
      {
        as: 'place',
        skill: 'place_block',
        params: { item: 'minecraft:crafting_table', where: 'beside' },
        next: 'sword',
        maxVisits: 2,
        onFail: { no_material: 'sword', failed: 'sword', denied: 'sword', not_found: 'sword' },
      },
      {
        as: 'sword',
        skill: 'craft',
        params: { item: 'minecraft:wooden_sword', chain: true },
        next: 'equip_sword',
        maxVisits: 1,
        onFail: { no_material: 'report', failed: 'report' },
      },
      {
        as: 'equip_sword',
        skill: 'equip',
        params: { items: 'wooden_sword,stone_sword,iron_sword,diamond_sword' },
        next: 'done',
        maxVisits: 1,
        onFail: { no_material: 'done', failed: 'done' },
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: 'weapon_first failed: wood/table/sword not completed' },
        next: null,
      },
    ],
  },

  {
    id: 'bootstrap_kit',
    title: '没装备时先做一套（采集→工作台→木剑+木镐）',
    source: 'auto',
    match: ['做装备', '先做套装备', '应急装备', 'bootstrap kit'],
    steps: [
      {
        as: 'chop_oak',
        skill: 'mine_nearby',
        params: { block: 'minecraft:oak_log', count: 8, radius: 32, countPerChunk: 4, maxClusters: 2 },
        next: 'collect',
        maxVisits: 1,
        onFail: {
          not_found: 'chop_spruce',
          no_path: 'chop_spruce',
          out_of_reach: 'collect',
          failed: 'collect',
        },
      },
      {
        as: 'chop_spruce',
        skill: 'mine_nearby',
        params: { block: 'minecraft:spruce_log', count: 8, radius: 32, countPerChunk: 4, maxClusters: 2 },
        next: 'collect',
        maxVisits: 1,
        onFail: {
          not_found: 'chop_birch',
          no_path: 'chop_birch',
          out_of_reach: 'collect',
          failed: 'collect',
        },
      },
      {
        as: 'chop_birch',
        skill: 'mine_nearby',
        params: { block: 'minecraft:birch_log', count: 8, radius: 32, countPerChunk: 4, maxClusters: 2 },
        next: 'collect',
        maxVisits: 1,
        onFail: { not_found: 'collect', no_path: 'collect', out_of_reach: 'collect', failed: 'collect' },
      },
      {
        as: 'collect',
        skill: 'collect_items',
        params: { radius: 16 },
        next: 'find_table',
        maxVisits: 1,
        onFail: { failed: 'find_table' },
      },
      {
        // 先搜附近有没有现成工作台（有就直接用，别再造新的）
        as: 'find_table',
        skill: 'find_block',
        params: { block: 'minecraft:crafting_table', radius: 24 },
        next: 'sword',
        maxVisits: 1,
        onFail: { not_found: 'table', failed: 'table' },
      },
      {
        as: 'table',
        skill: 'craft',
        params: { item: 'minecraft:crafting_table', chain: true, count: 1 },
        next: 'place',
        maxVisits: 1,
        onFail: { no_material: 'report', failed: 'report', bad_argument: 'report' },
      },
      {
        as: 'place',
        skill: 'place_block',
        params: { item: 'minecraft:crafting_table', where: 'beside' },
        next: 'sword',
        maxVisits: 2,
        onFail: { no_material: 'sword', failed: 'sword', denied: 'sword', not_found: 'sword' },
      },
      {
        as: 'sword',
        skill: 'craft',
        params: { item: 'minecraft:wooden_sword', chain: true },
        next: 'pick',
        maxVisits: 1,
        onFail: { no_material: 'pick', failed: 'pick' },
      },
      {
        as: 'pick',
        skill: 'craft',
        params: { item: 'minecraft:wooden_pickaxe', chain: true },
        next: 'equip_pick',
        maxVisits: 1,
        onFail: { no_material: 'report', failed: 'report' },
      },
      {
        as: 'equip_pick',
        skill: 'equip',
        params: { items: 'stone_pickaxe,iron_pickaxe,wooden_pickaxe' },
        next: 'done',
        maxVisits: 1,
        onFail: { no_material: 'done', failed: 'done' },
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '装备兜底没走通（附近没树/材料不够）' },
        next: null,
      },
    ],
  },

  // ── 12. 采集工具包（auto/llm）：缺镐/斧就做木镐+木斧，并换上镐 ──────
  // 日程表在"缺采集工具"时自动开（有剑之后 bootstrap_kit 不会再跑，必须单独补工具）。
  {
    id: 'craft_tools',
    title: '做采集工具（木镐+木斧）并换手',
    source: 'llm',
    match: ['做采集工具', '做把镐', '做把斧', '补工具', 'craft tools'],
    steps: [
      {
        // 先搜附近有没有现成工作台（有就直接用，别再造新的）
        as: 'find_table',
        skill: 'find_block',
        params: { block: 'minecraft:crafting_table', radius: 24 },
        next: 'pick',
        maxVisits: 1,
        onFail: { not_found: 'table', failed: 'table' },
      },
      {
        as: 'table',
        skill: 'craft',
        params: { item: 'minecraft:crafting_table', chain: true, count: 1 },
        next: 'place',
        maxVisits: 1,
        onFail: { no_material: 'report', failed: 'report', bad_argument: 'report' },
      },
      {
        as: 'place',
        skill: 'place_block',
        params: { item: 'minecraft:crafting_table', where: 'beside' },
        next: 'pick',
        maxVisits: 2,
        onFail: { no_material: 'pick', failed: 'pick', denied: 'pick', not_found: 'pick' },
      },
      {
        as: 'pick',
        skill: 'craft',
        params: { item: 'minecraft:wooden_pickaxe', chain: true },
        next: 'axe',
        maxVisits: 1,
        onFail: { no_material: 'axe', failed: 'axe' },
      },
      {
        as: 'axe',
        skill: 'craft',
        params: { item: 'minecraft:wooden_axe', chain: true },
        next: 'equip_pick',
        maxVisits: 1,
        onFail: { no_material: 'equip_pick', failed: 'equip_pick' },
      },
      {
        as: 'equip_pick',
        skill: 'equip',
        params: { items: 'stone_pickaxe,iron_pickaxe,wooden_pickaxe' },
        next: 'done',
        maxVisits: 1,
        onFail: { no_material: 'report', failed: 'report' },
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '做采集工具没走通（缺木头/台子放不下）' },
        next: null,
      },
    ],
  },

  // ── 7. M2：做工具/装备（合成链，LLM 任务）──────────────────────
  {
    id: 'craft_gear',
    title: '做一套木制工具（工作台 + 木剑 + 木镐）',
    source: 'llm',
    match: ['做套工具', '做木剑', '做木镐', '木制工具', 'craft gear', 'wooden tools'],
    steps: [
      {
        // 先搜附近有没有现成工作台（有就直接用，别再造新的）
        as: 'find_table',
        skill: 'find_block',
        params: { block: 'minecraft:crafting_table', radius: 24 },
        next: 'sword',
        maxVisits: 1,
        onFail: { not_found: 'table', failed: 'table' },
      },
      {
        as: 'table',
        skill: 'craft',
        params: { item: 'minecraft:crafting_table', chain: true, count: 1 },
        next: 'place',
        maxVisits: 1,
        onFail: { no_material: 'report_material', failed: 'report_material' },
      },
      {
        as: 'place',
        skill: 'place_block',
        params: { item: 'minecraft:crafting_table', where: 'beside' },
        next: 'sword',
        maxVisits: 2,
        // 台子放不下不算致命：后面 3×3 配方可能直接找现成台子
        onFail: { no_material: 'sword', failed: 'sword', denied: 'sword', not_found: 'sword' },
      },
      {
        as: 'sword',
        skill: 'craft',
        params: { item: 'minecraft:wooden_sword', chain: true },
        next: 'pick',
        maxVisits: 1,
        onFail: { no_material: 'pick', failed: 'pick' },
      },
      {
        as: 'pick',
        skill: 'craft',
        params: { item: 'minecraft:wooden_pickaxe', chain: true },
        next: 'equip_pick',
        maxVisits: 1,
        onFail: { no_material: 'report', failed: 'report' },
      },
      {
        as: 'equip_pick',
        skill: 'equip',
        params: { items: 'stone_pickaxe,iron_pickaxe,wooden_pickaxe' },
        next: 'done',
        maxVisits: 1,
        onFail: { no_material: 'done', failed: 'done' },
      },
      {
        as: 'report_material',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '木头/木板不够，做不了工具' },
        next: null,
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '做工具没走通' },
        next: null,
      },
    ],
  },

  // ── 8. M2：通用合成（物品用 params 覆盖，支持链式补材料）─────────
  {
    id: 'make_item',
    title: '合成指定物品（可自动补木板/木棍）',
    source: 'llm',
    match: ['合成', '做一个', '做个', 'craft item', 'make item'],
    steps: [
      {
        as: 'craft',
        skill: 'craft',
        params: { item: 'minecraft:wooden_pickaxe', chain: true, count: 1 },
        next: 'done',
        maxVisits: 1,
        onFail: { no_material: 'report_material', failed: 'report_failed', bad_argument: 'report_failed' },
      },
      {
        as: 'report_material',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '材料不够，做不出来（矿石/煤需要先挖）' },
        next: null,
      },
      {
        as: 'report_failed',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '合成没走通（可能要工作台或配方不支持）' },
        next: null,
      },
    ],
  },

  // ── 9. M2：熔炼（找熔炉；没有就做熔炉 + 放好再烧）───────────────
  {
    id: 'smelt_item',
    title: '熔炼物品（没熔炉就先做一个）',
    source: 'llm',
    match: ['熔炼', '烧一下', '烧熟', 'smelt'],
    steps: [
      {
        // 先搜附近有没有现成熔炉（有就直接烧，别再做一个）
        as: 'find_furnace',
        skill: 'find_block',
        params: { block: 'minecraft:furnace', radius: 24 },
        next: 'smelt',
        maxVisits: 1,
        onFail: { not_found: 'furnace', failed: 'furnace' },
      },
      {
        as: 'smelt',
        skill: 'smelt',
        params: { item: 'minecraft:raw_beef' },
        next: 'done',
        maxVisits: 1,
        // 没熔炉/没燃料 → 先做熔炉；其它失败直接报
        onFail: { not_found: 'furnace', no_material: 'furnace', failed: 'report_failed' },
      },
      {
        as: 'furnace',
        skill: 'craft',
        params: { item: 'minecraft:furnace', chain: true },
        next: 'place',
        maxVisits: 1,
        onFail: { no_material: 'report_material', failed: 'report_material' },
      },
      {
        as: 'place',
        skill: 'place_block',
        params: { item: 'minecraft:furnace', where: 'beside' },
        next: 'smelt2',
        maxVisits: 2,
        onFail: { no_material: 'smelt2', failed: 'smelt2', denied: 'smelt2', not_found: 'smelt2' },
      },
      {
        as: 'smelt2',
        skill: 'smelt',
        params: { item: 'minecraft:raw_beef' },
        next: 'done',
        maxVisits: 1,
        onFail: { not_found: 'report_failed', no_material: 'report_material', failed: 'report_failed' },
      },
      {
        as: 'report_material',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '材料/燃料不够（熔炉要 8 圆石，煤要先挖）' },
        next: null,
      },
      {
        as: 'report_failed',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '熔炼没走通' },
        next: null,
      },
    ],
  },

  // ── 10. M2：从箱子取东西（fetch_items 是 store_items 的镜像）──────
  {
    id: 'fetch_item',
    title: '从箱子/木桶取东西',
    source: 'llm',
    match: ['从箱子拿', '取出来', '箱子里拿', 'fetch item', 'take from chest'],
    steps: [
      {
        as: 'fetch',
        skill: 'fetch_items',
        params: { item: 'minecraft:oak_log', radius: 24 },
        next: 'done',
        maxVisits: 2,
        onFail: { not_found: 'report_nothing', failed: 'report_nothing' },
      },
      {
        as: 'report_nothing',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '附近箱子/木桶里没有要取的东西' },
        next: null,
      },
    ],
  },

  // ── 4. 做好东西并放好（工作台/箱子等；具体物品用 params 覆盖）─────
  {
    id: 'craft_and_place',
    title: '做个东西并放好（工作台/箱子…）',
    source: 'llm',
    match: ['放个工作台', '把工作台放好', '造个工作台', '放个箱子', '造个箱子', '放好', 'place workbench'],
    steps: [
      {
        as: 'craft',
        skill: 'craft',
        params: { item: 'minecraft:crafting_table', count: 1 },
        next: 'place',
        maxVisits: 1,
        onFail: { no_material: 'report_material', not_found: 'report', failed: 'report' },
      },
      {
        as: 'place',
        skill: 'place_block',
        params: { item: 'minecraft:crafting_table', where: 'beside' },
        next: 'done',
        maxVisits: 2,
        onFail: { no_material: 'report_material', not_found: 'report', denied: 'report' },
      },
      {
        as: 'report_material',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '材料不够，做不出来' },
        next: null,
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '做一下/放一下没走通' },
        next: null,
      },
    ],
  },

  // ── 5. 砌一排 / 一面墙（方块用 params 覆盖）─────────────────────
  {
    id: 'build_wall',
    title: '砌一排/一面墙',
    source: 'llm',
    match: ['砌墙', '造墙', '修一堵墙', '围一圈', 'build wall'],
    steps: [
      {
        as: 'wall',
        skill: 'place_build',
        params: {
          item: 'minecraft:cobblestone',
          shape: 'wall',
          length: 4,
          height: 2,
          direction: 'north',
        },
        next: 'done',
        maxVisits: 1,
        onFail: { no_material: 'report_material', not_found: 'report', denied: 'report' },
      },
      {
        as: 'report_material',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '背包里的方块不够，砌不了' },
        next: null,
      },
      {
        as: 'report',
        type: 'report',
        escalate: 'plan_failed',
        params: { message: '砌墙没走通' },
        next: null,
      },
    ],
  },
];

/** 需要 LLM 直连的配方（tree_task 能匹配的） */
export const LLM_RECIPES = RECIPES.filter((r) => r.source !== 'auto').map((r) => r.id);

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id) || null;
}

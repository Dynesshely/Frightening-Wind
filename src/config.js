/**
 * Frightening-Wind 全局配置
 * 目标是"不顾一切的发育与增长"：产能最大化、控制器等级快速提升、自动扩建。
 */
module.exports = {
    // 代码版本号。每次大幅改动后 +1，用于自动迁移旧 Memory
    version: 4,
    name: 'Frightening-Wind',

    // 每多少 tick 在控制台打印一次状态报告
    reportInterval: 25,

    // 每个房间允许同时存在的工地数量上限（宁少勿多，让建造者集中火力）
    maxSitesPerRoom: 8,
    maxSitesPerRoomHighRcl: 10,
    // 每 tick 最多新开工地数量
    maxNewSitesPerTick: 2,

    // 维修阈值：结构血量低于 上限 * 该比例 才会去修
    repairThreshold: 0.8,
    // 低于该血量的核心结构优先维修（spawn / extension / tower / container / road）
    repairUrgent: 0.5,

    // 塔在能量高于该比例时才会用于维修
    towerRepairEnergyRatio: 0.7,

    // 角色身体单元：unit 会按能量预算尽量重复，剩余能量用于平衡负载/移速
    bodies: {
        // 自采自送的通用工人
        harvester: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 6 },
        // 静态矿工：站在矿源/容器上一直挖，WORK 越多越好（unit 保持 200 能量，保证 RCL1/2 也造得出来）
        miner: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 8 },
        // 搬运工：只堆 CARRY + MOVE
        hauler: { unit: ['carry', 'carry', 'move'], filler: ['carry', 'move'], maxUnits: 10 },
        builder: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 6 },
        upgrader: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 8 },
        // 远程接驳工：纯搬运（远距离 => 限价 500，走高密度路线）
        remoteHauler: { unit: ['carry', 'carry', 'move'], filler: ['carry', 'move'], maxUnits: 10, maxCost: 500 },
        // 护航兵：ATTACK+MOVE，跟着远程采集队走
        escort: { unit: ['attack', 'move'], filler: ['attack', 'move'], maxUnits: 5, maxCost: 400 },
        // 远程采集者：远距离 => 限价 450（模型结论：>40 格堆身体无效，靠密度）
        remoteHarvester: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 5, maxCost: 450 },
        // 占领者：CLAIM + MOVE，去相邻房间预定控制器（CLAIM 600 能量，所以只造 1 个）
        reserver: { unit: ['claim', 'move'], filler: [], maxUnits: 1, maxCost: 650 },
        // 占领者（真正占房）：同样是 CLAIM + MOVE，但执行 claimController
        claimer: { unit: ['claim', 'move'], filler: [], maxUnits: 1, maxCost: 650 },
        // 巡逻兵：ATTACK + MOVE，常备边防（RCL3 起 2 人，受袭时加到 3）
        patroller: { unit: ['attack', 'move'], filler: [], maxUnits: 3, maxCost: 400 },
        // 士兵：只堆 ATTACK + MOVE，有敌情时才造
        // 士兵：每个单元 ATTACK+MOVE+WORK —— 战时输出火力，和平时期能采矿/拆障当工兵
        soldier: { unit: ['attack', 'move', 'work'], filler: ['attack', 'move'], maxUnits: 6, maxCost: 500 },
        // 侦查兵：纯 MOVE，50 能量一个，跑得快、活得久（只去安全/无主房间）
        scout: { unit: ['move'], filler: [], maxUnits: 4, maxCost: 100 },
        // 侦察兵：进敌对/危险房间拿情报，2~3 个 MOVE，进得去跑得掉
        recon: { unit: ['move'], filler: [], maxUnits: 3, maxCost: 150 },
        // 开拓者：去新占房间建 spawn / 升控制器
        pioneer: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 5 },
    },

    // 生成优先级（同缺口比例时排在前的优先）
    spawnPriority: ['claimer', 'pioneer', 'soldier', 'patroller', 'scout', 'recon', 'reserver', 'miner', 'hauler', 'harvester', 'upgrader', 'builder', 'remoteHarvester'],

    // 侦查：房间情报多少 tick 后视为过期
    intelStaleTicks: 2000,
    // 一个房间最多同时派几个侦查兵
    maxScouts: 1,
    // 提前替代：creep 剩余 TTL 低于该值就开始补位（避免岗位真空）
    replaceTtl: 120,

    // ---- 战争策略：量敌用兵，经济优先 ----
    war: {
        minLevel: 2,            // 低于该 RCL 不主动进攻
        minPopulation: 8,       // 人口不足不打
        minStoredEnergy: 300,   // 库存能量不足不打
        solveTicks: 15,         // 期望多少 tick 解决战斗
        healFactor: 1.5,        // 敌方每点治疗需要额外多少火力压制
        safetyFactor: 1.5,      // 安全系数
        minUnits: 2,            // 最少出兵数
        maxUnits: 8,            // 单波次上限
        energyShare: 0.35,      // 用于爆兵的能量占比上限

        // ---- 侵略度自动档位（按经济评分 0~100 切换）----
        // defensive   防守反击：只打进入我方领地的敌人
        // opportunist 机会主义：相邻房间有敌人就打（默认）
        // aggressive  主动清野：搜索范围扩到 2 跳、常备军与巡逻各 +1
        aggression: {
            opportunisticAt: 45,   // 评分达到该值进入机会主义
            aggressiveAt: 75,      // 评分达到该值进入主动清野
            energyTarget: 1000,    // 存量能量的"满分"基准
            aggressiveRadius: 2,   // 主动清野时的目标搜索跳数
        },
    },

    // ---- P2 行为阈值集中管理 ----
    roleHysteresis: 150,        // 同一角色最少在岗 tick
    // 连续多少 tick 既没移动也没换提示语，就判定"发呆"并强制回老家待命。
    // 这是所有角色共用的最后一道兜底，防止出现站在房间边界不动几百 tick 的哨兵。
    idleTicksBeforeHome: 12,
    connectMinExits: 6,         // 建造选址：spawn 至少保留几个可达出口
    patrolLowHits: 0.45,        // 巡逻兵血量低于该比例回塔疗伤
    fleeRange: 4,               // 威胁型敌人进入该范围才撤退
    towerRepairRatio: 0.7,      // 塔能量高于该比例才参与维修

    // 侦察：进危险房间后最多停留多少 tick（信息一拿到就走）
    reconStayTicks: 3,
    // 侦察情报多久算过期
    reconStaleTicks: 1500,

    // 边防巡逻
    patrolRooms: 4,          // 巡逻路线最多几个房间（相邻房间最多也就 4 个）
    patrolStayTicks: 180,     // 每个房间驻留多少个 tick 扫荡
    patrolHealRatio: 0.45,   // 血量低于该比例就回老家（塔下面）治疗

    // 各等级扩展数量
    extensionLimit: { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
    // 各等级塔数量
    towerLimit: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
    // 各等级容器是否可建
    canBuildContainers: 2,
    // 各等级 storage
    canBuildStorage: 4,
    // 各等级 link 数量
    linkLimit: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6 },

    // 单次任务寻路的复用 tick 数（降低 CPU）
    pathReuse: 8,

    // ---- 导航层（fw.nav）----
    // 这些参数直接决定"会不会在房间边界来回穿梭"，改动前先读 fw.nav.js 顶部注释。
    nav: {
        // 意图（一次"要去哪"的承诺）最长存活 tick。超时只上报，不擅自取消。
        intentTtl: 120,
        // 连续多少 tick 位置没变判定为停滞（然后换出口格 / 8 方向脱困）
        stuckTicks: 3,
        // 连续多少次寻路失败判定目标不可达（拉黑房间，交给角色层换目标）
        giveUpAfter: 8,
        // 同一侧出口格按名字散列分流的数量。
        // 太小会让一堆单位挤在同一个边界格上互相阻挡（move() 返回 OK 但不动），
        // 线上表现为"一群远程矿工堵在同一条边上"。
        exitSpread: 8,
        // 振荡检测窗口 tick
        oscWindow: 60,
        // 窗口内跨房间达到该次数即判定振荡
        oscCount: 5,
        // 判定振荡后冻结跨房间移动的 tick 数
        holdTicks: 120,
        // 冻结期间允许活动范围（离房间中心的切比雪夫距离）
        holdRadius: 20,
        // 跨房间到达后必须走进目标房间内部多深（离边界的最小格数）才算"到了"。
        // 停在入口格上会被下一 tick 的角色逻辑当成"还在边缘"，稍一犹豫就跨回去 ——
        // 线上实测过：侦察兵在 W7N2(0,37) 与 W8N2(49,37) 之间每 2 tick 往返一次，持续几百 tick。
        roomEntryDepth: 8,
    },
};
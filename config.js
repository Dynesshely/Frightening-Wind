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
        // 道路通畅维保员：WORK(拆障) + CARRY(收废料) + MOVE
        roadKeeper: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 4, maxCost: 400 },
        // 远程接驳工：纯搬运，载重堆满
        remoteHauler: { unit: ['carry', 'carry', 'move'], filler: ['carry', 'move'], maxUnits: 10 },
        // 远程采集者：和本地采集者同款（要能挖能背）
        remoteHarvester: { unit: ['work', 'carry', 'move'], filler: ['work', 'carry', 'move'], maxUnits: 5 },
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
    spawnPriority: ['claimer', 'pioneer', 'soldier', 'patroller', 'scout', 'recon', 'roadKeeper', 'reserver', 'miner', 'hauler', 'harvester', 'upgrader', 'builder', 'remoteHarvester'],

    // 侦查：房间情报多少 tick 后视为过期
    intelStaleTicks: 2000,
    // 一个房间最多同时派几个侦查兵
    maxScouts: 1,
    // 提前替代：creep 剩余 TTL 低于该值就开始补位（避免岗位真空）
    replaceTtl: 120,

    // 侦察：进危险房间后最多停留多少 tick（信息一拿到就走）
    reconStayTicks: 3,
    // 侦察情报多久算过期
    reconStaleTicks: 1500,

    // 边防巡逻
    patrolRooms: 4,          // 巡逻路线最多几个房间（相邻房间最多也就 4 个）
    patrolStayTicks: 40,     // 每个房间驻留多少个 tick 扫荡
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
};
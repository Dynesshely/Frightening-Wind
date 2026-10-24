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
    maxSitesPerRoom: 7,
    maxSitesPerRoomHighRcl: 5,
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
    },

    // 生成优先级（同缺口比例时排在前的优先）
    spawnPriority: ['miner', 'hauler', 'harvester', 'upgrader', 'builder'],

    // 各等级扩展数量
    extensionLimit: { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
    // 各等级塔数量
    towerLimit: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
    // 各等级容器是否可建
    canBuildContainers: 2,
    // 各等级 storage
    canBuildStorage: 4,

    // 单次任务寻路的复用 tick 数（降低 CPU）
    pathReuse: 8,
};
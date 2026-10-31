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

    // 塔的补给策略：存量低于 lowEnergy 时优先补（防御是硬需求，不参与"攒钱"排队）。
    // 满容量 1000，300 够打 30 次；低于这个线说明真打起来就是空城。
    tower: {
        lowEnergy: 300,
    },

    // 角色身体单元：unit 会按能量预算尽量重复，剩余能量用于平衡负载/移速
    bodies: {
        // 经济角色用 tiers：给定能量预算，直接取"造得起且最大"的那一档。
        // 用固定档位而不是 unit 循环 + filler 平衡，是因为后者在 600 能量下会拼出
        // 3W3C3M（3 个 WORK），而矿工要的是 5W1C1M。档位让身体比例可控、可预测。
        //
        // 自采自送的通用工人：200 / 350 / 450
        harvester: {
            tiers: [
                ['work', 'carry', 'move'],
                ['work', 'work', 'carry', 'move', 'move'],
                ['work', 'work', 'work', 'carry', 'move', 'move'],
            ],
            maxUnits: 6,
        },
        // 静态矿工：站桩采集，WORK 越多越好；600 档是 5W1C1M（模型算的最优形态）
        miner: {
            tiers: [
                ['work', 'carry', 'move'],
                ['work', 'work', 'carry', 'move', 'move'],
                ['work', 'work', 'work', 'carry', 'move', 'move'],
                ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
            ],
            maxUnits: 8,
        },
        // 搬运工：只堆 CARRY + MOVE，150 / 300 / 450 / 600（载 100 / 200 / 300 / 400）
        // RCL5 容量 1800，24 格往返需要吞吐 ≈ 4 e/tick；6C3M 只有 2.0，8C4M 是 2.67。
        // （模型 fig30/fig31：距离 24 格、目标 6.67 e/tick 时理论上要 5 个 6C3M 或 3 个 8C4M）
        hauler: {
            tiers: [
                ['carry', 'carry', 'move'],
                ['carry', 'carry', 'carry', 'carry', 'move', 'move'],
                ['carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'move', 'move', 'move'],
                ['carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry',
                 'move', 'move', 'move', 'move'],
            ],
            maxUnits: 10,
        },
        builder: {
            tiers: [
                ['work', 'carry', 'move'],
                ['work', 'work', 'carry', 'move', 'move'],
                ['work', 'work', 'work', 'carry', 'move', 'move'],
            ],
            maxUnits: 6,
        },
        upgrader: {
            tiers: [
                ['work', 'carry', 'move'],
                ['work', 'work', 'carry', 'move', 'move'],
                ['work', 'work', 'work', 'carry', 'move', 'move'],
            ],
            maxUnits: 8,
        },
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
    // 经济角色必须排在扩张/军事之前：实测 reserver（650 能量）排在第一位时，
    // 它会一直霸占"下一个孵化目标"，而房间根本攒不到 650，spawn 长期空转。
    spawnPriority: ['miner', 'harvester', 'hauler', 'upgrader', 'builder', 'remoteHarvester', 'reserver', 'claimer', 'pioneer', 'soldier', 'patroller', 'scout', 'recon'],

    // ---- 孵化预算（docs/OPTIMIZATION.md F1）----
    // 旧实现用 room.energyAvailable 当预算，实测均值 120 → 永远只造得出 1W1C1M（200），
    // 5W1C1M（600）在结构上造不出来。这里给每个角色一个"值得攒到"的目标成本：
    // 能量不够就不孵（合法的投资等待），再用 starveTicks 兜底防止人口断档。
    spawn: {
        budget: {
            // RCL5 容量 1800 之后，450 的预算会把矿工锁死在 3W（3 个矿工 = 9 WORK，
            // 稳态只有 6.4 e/tick），而目标产出是 7.5。提到 600 才能造 5W1C1M（15 WORK）。
            miner: 600,             // 5W1C1M
            // hauler 从 600 降到 400：600 是理想值（8C4M / 载 400），但实测 spawn 长期只有
            // 2~26 能量，永远攒不到 -> 只能造 2C1M（载 100）-> 容器积压涨到 5,316。
            // 400（6C3M / 载 300）是"能达到且载重是现役 3 倍"的档位，先稳住再图升级。
            hauler: 400,
            harvester: 450,
            upgrader: 450,
            builder: 450,
            remoteHarvester: 450,
            remoteHauler: 500,
        },
        // 攒钱最多等多少 tick，超时就用当前能量造小一号（防止老人死光没人接班）。
        //
        // ★ 90 太短，会把自己锁进"小兵循环"：攒 90 tick 攒不到 600 -> 造 50 的 1W1C1M ->
        //   采集/运输效率极低 -> 还是攒不到 -> 永远小兵。线上实测过整房退化到 1W1C1M。
        //   250 是折中：给大身体留出 4 分钟（真实服）的攒钱窗口，同时仍能在老死前补位。
        starveTicks: 250,
        // 人口低于该值（starveGuardPopulation）时允许"有多少造多少"续命；
        // 高于它则**死等**大身体，避免退化成小兵循环（详见 mgr.spawn 里的注释）。
        starveGuardPopulation: 8,
        // 人口低于该值时进入"保命模式"：不攒钱，用当前能量能造多大造多大。
        // 实测教训：只攒钱不管人口，850 tick 内人口从 17 掉到 6，采集链直接崩掉。
        minPopulation: 12,
        // 连最小身体（200）都造不起时不孵
        minEnergy: 200,
        // spawn/扩展里攒到这个量就"够了"，多出来的能量改投控制器旁容器（升级端）。
        // 否则容量 1300 的扩展永远有空位，会把所有能量吸干、让升级者长期饿着。
        reserve: 350,
    },

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
    // 各等级 storage（RCL4 先不新建：30000 hit 会把当期产能全部吃掉，
    // 已有工地由 fw.build.sitePriority 动态降级）
    canBuildStorage: 5,
    // 边境 rampart 上限（咽喉点通常 3~8 格；给一点余量，但绝不再沿边界铺）
    maxBorderRamparts: 12,
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

    // ---- V2 预算驱动架构（docs/ARCHITECTURE_V2.md）----
    // 灰度开关：false 时完全走旧的 quota / economy 路径，行为与重构前一致。
    // 所有 core.* 模块都从这里取参数，**不要在别处写死阈值**。
    core: {
        v2: false,

        // L0 账本：滑动窗口长度（tick）与 Memory 里最多保留的样本数
        ledgerWindow: 300,

        // L1/L2 的 η 闸门：低于 optimize 时禁止扩军（只优化动线），高于 expand 才允许加人
        etaOptimize: 0.4,
        etaExpand: 0.75,

        // 维护负债占收入的比例上限；超过就要求 policy 输出更小的 upkeepCap
        upkeepRatio: 0.3,
        // 各类结构单件维护成本（e/tick），用于把"能养多少"反解成数量上限
        // 依据 modeling/fig83：rampart 0.03 / container(有主) 0.10 / road(平地,时间项) 0.0015
        upkeepUnit: { rampart: 0.03, container: 0.10, road: 0.0015 },

        // 预算分配比例（扣掉维护之后的部分）
        budgetShare: { spawn: 0.5, upgrade: 0.3, build: 0.15, defense: 0.05 },

        // L3 任务队列
        taskLimit: 50,
        taskTtl: 300,
    },
};
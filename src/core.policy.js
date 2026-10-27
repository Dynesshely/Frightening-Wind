/**
 * core.policy —— L2 策略：把预算解成"要几个人、什么身体"。
 *
 * ============================== 这一层是什么 ==============================
 *
 * 契约见 docs/ARCHITECTURE_V2.md §5。输入 snap（L0）+ bud（core.budget.allocate），
 * 输出目标产出、各角色目标人数、目标 body、η 模式与基建上限。
 * **不写死人数**：人数由模型（core.estimator）反解，预算只决定"能不能扩"。
 *
 * 三条硬规则（都来自模型，改动前先读 docs/MODEL.md 与 modeling/）：
 *   1. η < config.core.etaOptimize（默认 0.4）→ etaMode='optimize'，roles 只减不增；
 *      预算为负 / 维护超限（bud.overBudget）同样禁止扩军。
 *   2. body 的 MOVE 配比用 **1:1**（平地满速：2·n_MOVE ≥ w·c，c=2 ⇒ n_MOVE ≥ w）。
 *      旧的 1:2（5W1C1M）在平地上是 6 tick/格，正是线上 31% ERR_TIRED 的结构性原因（MECHANICS D9）。
 *   3. n_work = workFor(targetYield, q)；n_miner = ceil(n_work / WORK_PER_MINER)；
 *      n_hauler = ceil(yieldPerSource / throughput(haulerBody, steps, terrain))，距离用真实 pos。
 *
 * 不该放进来：
 *   - 预算怎么分（core.budget.js）、账本怎么记（core.ledger.js）、任务怎么派（core.task.js）；
 *   - 具体动作执行（utils / fw.*）—— 本模块只输出"配置"，不碰 Game 写接口。
 *
 * 依赖：config、core.estimator。
 * 不 require core.ledger：snap 是入参（契约 §5 的签名就是这么给的），避免 L2 绑死 L0 加载顺序。
 */
const config = require('config');
const estimator = require('core.estimator');

/* ------------------------------ 参数 ------------------------------ */

// L2 阈值：config.core 由 Lead 统一维护（v2 / etaOptimize / upkeepRatio / upkeepUnit /
// budgetShare / taskLimit / taskTtl）。**本模块不再往 config 里加键** —— 下面这些是
// 模块内置常量（数字全部来自 modeling/，改参数改这里 + 注释说明依据）。
const DEFAULTS = {
    etaOptimize: 0.4,
    shrinkRatio: 0.5,
    workPerMiner: 5,
    workPerUpgrader: 5,
    workPerBuilder: 5,
    haulerTerrain: 'plain',
    // 各 RCL 下"每个 source 的目标产出"（e/tick）。沿用旧 quota 的档位：
    // RCL<4 5.0（1 个矿工吃满），RCL4 6.67（2 个矿工），RCL5 7.5，RCL6+ 8.0。
    // 不作为硬上限：真正的人数仍由 workFor() 反解。
    yieldTarget: { 1: 5.0, 2: 5.0, 3: 5.0, 4: 6.67, 5: 7.5, 6: 8.0, 7: 8.0, 8: 8.0 },
    // 收缩模式（预算为负）下目标产出的下限比例，避免把矿工全裁掉导致死循环
    minTargetRatio: 0.5,

    // ---- 身体预算的"渐进式"档位（重要）----
    // 房间容量（energyCapacityAvailable）只是上限，不代表能稳定攒到。
    // 线上实测：容量 1300、存量长期只有 180，一步到位的大 body 永远孵不出来，
    // 结果就是"配置要求 850 能量、spawn 永远等钱"—— 新架构必须避免这个坑。
    // 所以身体预算取 min(容量, 收入 × bootstrapTicks)，并给一个下限。
    bootstrapTicks: 200,   // 允许一次投资预支多少 tick 的收入
    minBodyBudget: 300,    // 再穷也要能造出 2W2C2M 级别的小身体
    // 账本样本不足时保守取值（还没测出真实收入）
    warmupSamples: 30,

    // 搬运工上限（积压补偿时不会无限加人）
    haulerMax: 6,
    // 容器积压超过该值就加人（e）
    backlogTrigger: 500,
};

// 每个经济角色维持的最低编制（optimize 模式下"只减不增"不能减到 0，
// 否则一次 η 低谷就会把采集链裁空，之后再也凑不齐钱扩军 —— 线上踩过）。
const FLOOR = { miner: 1, harvester: 1, hauler: 1, upgrader: 1, builder: 0 };

/* ------------------------------ 身体 ------------------------------ */

// 身体形态（非 MOVE 部分）：数字来自模型结论 + 本模块的 DEFAULTS.workPer*。
// 只在这里定义一次；MOVE 由 withMoves() 按 1:1 补齐，任何角色都不许手写 MOVE 数。
function bodySpec(role) {
    const work = n => { const out = []; for (let i = 0; i < n; i++) out.push('work'); return out; };
    switch (role) {
        // 静态矿工：5 WORK 站桩（一个矿工 = 10 e/tick 的抽干速度，2 个吃满 6.67 e/tick）
        case 'miner': return work(DEFAULTS.workPerMiner).concat(['carry']);
        // 自采自送：WORK 比矿工少，CARRY 多一些（没有容器，必须自己把能量扛回去）
        case 'harvester': return ['work', 'work', 'work', 'carry', 'carry', 'carry'];
        // 搬运工：纯 CARRY，靠 1:1 的 MOVE 在平地跑满速（4C4M 一趟运 200）
        case 'hauler': return ['carry', 'carry', 'carry', 'carry'];
        // 升级者 / 建造者：WORK 吃量，2 个 CARRY 做缓冲
        case 'upgrader':
        case 'builder': return work(role === 'upgrader' ? DEFAULTS.workPerUpgrader : DEFAULTS.workPerBuilder).concat(['carry', 'carry']);
        default: return ['carry'];
    }
}

/**
 * 按 1:1 补 MOVE：平地满速判据是 n_MOVE ≥ w（w = 非 MOVE 部件数，c=2）。
 * 这是本模块唯一允许生成 MOVE 的地方 —— 不要在别处拼 body。
 */
function withMoves(nonMove) {
    const parts = nonMove.slice();
    for (let i = 0; i < nonMove.length; i++) parts.push('move');
    return parts;
}

/**
 * 容量不够时把身体压小（孵化不出来等于没配置）。
 * 从尾部减部件（尾部是 CARRY），每减一个都重新按 1:1 补 MOVE，保证比例不变。
 */
function fitBody(nonMove, capacity) {
    const limit = Math.max(0, Number(capacity) || 0);
    let spec = nonMove.slice();
    while (spec.length > 1 && estimator.bodyCost(withMoves(spec)) > limit) spec.pop();
    return withMoves(spec);
}

/* ------------------------------ 小工具 ------------------------------ */

function coreCfg() {
    return (config && config.core) || {};
}

function cfgNum(value, fallback) {
    const n = Number(value);
    return isFinite(n) ? n : fallback;
}

function r4(x) {
    return Math.round(x * 10000) / 10000;
}

/** 当前 RCL 每个 source 的目标产出（内置 yieldTarget 表；依据 fig20/fig72 的档位）。 */
function targetPerSource(level) {
    const table = DEFAULTS.yieldTarget;
    const lv = Math.max(1, Math.min(8, Math.floor(Number(level) || 1)));
    return cfgNum(table[lv], DEFAULTS.yieldTarget[lv] || 5.0);
}

/** source 上限 q：已占领 3000 / 未占领 1500（M08 三档容量，由 estimator 提供）。 */
function sourceCap(data) {
    const owned = !!(data && data.level > 0);
    return estimator.sourceCapacity(owned ? 'owned' : 'neutral');
}

/** 这个矿源旁 2 格内有没有容器（有 = 可以静态采矿 + 搬运，没有 = 自采自送）。 */
function hasContainerNear(data, source) {
    const list = (data && data.containers) || [];
    for (const c of list) {
        if (!c || !c.pos) continue;
        let d;
        try { d = c.pos.getRangeTo(source.pos); } catch (e) { d = 99; }
        if (d <= 2) return true;
    }
    return false;
}

/**
 * 到"交付点"的步数：优先 storage（大宗），其次第一个 spawn，再次控制器。
 * 用 RoomPosition.getRangeTo（切比雪夫距离）当步数近似 —— 实际路径只会更长，
 * 所以 hauler 数偏保守（模型口径 fig03 的 spawn_steps 也是这么估的）。
 */
function stepsToDrop(data, source) {
    const spots = [];
    if (data && data.storage) spots.push(data.storage);
    if (data && data.spawns && data.spawns.length) spots.push(data.spawns[0]);
    if (data && data.room && data.room.controller) spots.push(data.room.controller);
    let best = 0;
    for (const s of spots) {
        if (!s || !s.pos) continue;
        let d;
        try { d = s.pos.getRangeTo(source.pos); } catch (e) { d = 0; }
        if (best === 0 || (d > 0 && d < best)) best = d;
    }
    return Math.max(1, best);
}

/** 全房间"有工地的建造需求"（e/tick）：每个工地按 build 速度上限给 1 个建造者，上限 3。 */
function buildersFor(data, bud) {
    const sites = (data && data.sites) ? data.sites.length : 0;
    if (!sites) return 0;
    const per = DEFAULTS.workPerBuilder;
    const capacity = per;                                  // 每 WORK = 1 进度/tick = 1 e/tick
    const byBudget = Math.ceil((bud ? Math.max(0, bud.build) : 0) / Math.max(1, capacity));
    const bySites = Math.min(3, sites);
    return Math.max(1, Math.min(bySites, byBudget || 1));
}

/* ------------------------------ 主函数 ------------------------------ */

/**
 * 把预算解成配置。
 *
 * @param {Room}   room
 * @param {Object} data  roomData 快照（level / sources / containers / spawns / storage / sites / creepsByRole）
 * @param {Object} snap  core.ledger.snapshot() → {income, spend, net, eta, upkeepDebt, samples}
 * @param {Object} bud   core.budget.allocate() 的返回值
 * @returns {{target:{yield:number, haulerRate:number},
 *            roles:{miner:number, harvester:number, hauler:number, upgrader:number, builder:number},
 *            bodies:Object, etaMode:string, upkeepCap:{rampart:number, container:number, road:number}}}
 */
function plan(room, data, snap, bud) {
    const c = coreCfg();
    const d = data || {};
    const s = snap || {};
    const b = bud || null;

    const level = Math.max(1, Math.floor(Number(d.level) || 1));
    const sources = (d.sources && d.sources.length) ? d.sources : [];
    const nSources = Math.max(1, sources.length);
    const capacity = (room && room.energyCapacityAvailable) || 300;

    /* ---- 1. η 模式：低 η 或超预算时只优化动线，禁止扩军 ---- */
    const eta = Math.max(0, Math.min(1, cfgNum(s.eta, 1)));
    const shrink = !!(b && (b.overBudget || b.total <= 0));
    const etaMode = (eta < cfgNum(c.etaOptimize, DEFAULTS.etaOptimize) || shrink) ? 'optimize' : 'expand';

    /* ---- 2. 目标产出：该 RCL 的档位；收缩时乘 shrinkRatio（不低于 minTargetRatio） ---- */
    const perSourceBase = targetPerSource(level);
    const shrinkRatio = DEFAULTS.shrinkRatio;
    const minRatio = DEFAULTS.minTargetRatio;
    const perSource = r4(perSourceBase * (shrink ? Math.max(shrinkRatio, minRatio) : 1));
    const targetYield = r4(perSource * nSources);

    /* ---- 3. 人数：由模型反解，不写死 ---- */
    const q = sourceCap(d);
    const workPerMiner = Math.max(1, DEFAULTS.workPerMiner);
    const roles = { miner: 0, harvester: 0, hauler: 0, upgrader: 0, builder: 0 };
    const terrain = String(DEFAULTS.haulerTerrain);
    let haulerRate = 0;

    for (const source of sources) {
        const nWorkRaw = estimator.workFor(perSource, q);
        // 先取整到整数 WORK（身体只能按整 WORK 计数；workFor(6.67,3000)=10.01 → 10），
        // 再按 5 WORK/矿工折算。不先取整会把 10.01 直接 ceil 成 3 个矿工（多养 50%）。
        const nWork = Math.max(1, Math.round(isFinite(nWorkRaw) ? nWorkRaw : workPerMiner));
        const people = Math.max(1, Math.ceil(nWork / workPerMiner));
        if (hasContainerNear(d, source)) {
            // 有容器：静态矿工 + 搬运。产出全部走搬运链。
            roles.miner += people;
            const steps = stepsToDrop(d, source);
            const perHauler = estimator.throughput(withMoves(bodySpec('hauler')), steps, terrain);
            roles.hauler += perHauler > 0 ? Math.max(1, Math.ceil(perSource / perHauler)) : 1;
            haulerRate += perSource;
        } else {
            // 没容器：自采自送，产出直送交付点，不产生搬运预算。
            roles.harvester += people;
        }
    }
    roles.hauler = Math.max(0, roles.hauler);

    // 容器积压补偿：稳态吞吐算出来的人数是"刚好够用"，但一旦出现积压
    // （采集 > 运输，或 spawn 一时满仓送不进去），积压会自我强化 —— 本地推演实测
    // 容器堆到 3950 而 spawn 只有 300，孵化断粮。这里按积压量临时加 1~3 个搬运工。
    let backlog = 0;
    for (const c of (d.containers || [])) {
        if (c && c.store) backlog += c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }
    if (backlog > 500 && roles.hauler < DEFAULTS.haulerMax) {
        const extra = Math.min(3, Math.floor(backlog / 1000) + 1);
        roles.hauler = Math.min(DEFAULTS.haulerMax, roles.hauler + extra);
    }

    /* ---- 4. 消耗端：预算决定，不按 RCL 拍脑袋 ---- */
    const workUpgrader = Math.max(1, DEFAULTS.workPerUpgrader);
    const upgradeCap = workUpgrader;                       // 每个 WORK 升级 1 e/tick
    roles.upgrader = b ? Math.ceil(Math.max(0, b.upgrade) / upgradeCap) : 0;
    roles.builder = buildersFor(d, b);

    /* ---- 5. η 低谷：只减不增（保留最低编制，避免裁空采集链） ---- */
    if (etaMode === 'optimize') {
        const live = (d.creepsByRole) || {};
        for (const role in roles) {
            const floor = FLOOR[role] || 0;
            const alive = Math.max(0, Number(live[role]) || 0);
            roles[role] = Math.max(Math.min(floor, roles[role]), Math.min(roles[role], alive));
        }
    }

    /* ---- 6. 身体：按 1:1 补 MOVE，并按"当前能攒到的能量"压缩 ---- */
    // 预算 = min(容量, 收入 × bootstrapTicks)，下限 minBodyBudget。
    // 这样低产能房间先养小兵铺人口，产能上来后身体自动长到满档。
    const income = Math.max(0, cfgNum(s.income, 0));
    const samples = Math.max(0, cfgNum(s.samples, 0));
    const warm = samples >= DEFAULTS.warmupSamples;   // 账本还没测准 → 保守用小身体
    const fromIncome = income * DEFAULTS.bootstrapTicks;
    const bodyBudget = Math.min(
        capacity,
        Math.max(DEFAULTS.minBodyBudget, Math.floor(warm ? fromIncome : 0))
    );

    const bodies = {};
    for (const role in roles) {
        if (roles[role] <= 0) continue;
        // 产能角色（矿工/搬运）值得多预支：它们是整条链的上游，
        // 身体大一档 = 采集/运输翻倍；而升级者/建造者只是消耗端，用标准预算即可。
        // 本地推演实测：一视同仁时，房间卡在"2 个 1W 矿工 + 一堆小兵"，产能永远起不来。
        const budgetOf = (role === 'miner' || role === 'hauler')
            ? Math.min(capacity, Math.max(DEFAULTS.minBodyBudget, Math.floor(warm ? income * DEFAULTS.bootstrapTicks * 1.8 : 0)))
            : bodyBudget;
        bodies[role] = fitBody(bodySpec(role), budgetOf);
    }

    /* ---- 7. 基建上限：按维护预算反解"最多养几件" ---- */
    const upkeep = b ? Math.max(0, b.upkeep) : 0;
    const unit = c.upkeepUnit || { rampart: 0.03, container: 0.10, road: 0.0015 };
    const capOf = kind => (unit[kind] > 0 ? Math.floor(upkeep / unit[kind]) : 0);
    const upkeepCap = { rampart: capOf('rampart'), container: capOf('container'), road: capOf('road') };

    /* ---------------- 手算样例（写死在这里当文档，防止后续改动悄悄跑偏） ----------------
     * 场景：RCL4、2 个已占领 source（q=3000）、容器旁，交付距离 24 / 6 步，
     *      snap = { net: 10, eta: 0.62, upkeepDebt: 1.0 }，有工地。
     *
     * budget.allocate → total=10、upkeep=1.0（1.0 ≤ 10×0.3，overBudget=false）
     *   disposable = 9 → spawn 4.5 / upgrade 2.7 / build 1.35 / defense 0.45 / reserve 0
     *
     * policy.plan：
     *   etaMode = expand（0.62 ≥ 0.4）
     *   每 source 目标 6.67 → 全房 13.34 e/tick
     *   n_work = workFor(6.67, 3000) = 10.01 → 取整 10 → 每 source ceil(10/5) = 2 个矿工 → miner=4
     *   hauler body 4C4M：平地 w=4、c=2、m=4 → ceil(4×2/(2×4)) = 1 tick/格
     *     source A 24 步：throughput = 200/(24+24+2) = 4.00 e/tick → ceil(6.67/4.00) = 2 人
     *     source B 6 步：  throughput = 200/(6+6+2)   = 14.29 e/tick → ceil(6.67/14.29) = 1 人
     *     → hauler = 3（与旧 quota 的 RCL4 档位一致，但 body 从 6C3M 改成 4C4M，平地满速）
     *   upgrader = ceil(2.7 / 5) = 1（旧 quota 按 RCL 拍 3 个）
     *   builder  = ceil(1.35 / 5) = 1（旧 quota 按工地数拍 2~3 个）
     *   upkeepCap = rampart floor(1.0/0.03)=33 段、container floor(1.0/0.10)=10 个、
     *               road floor(1.0/0.0015)=666 段
     *   bodies：miner 5W1C6M（850）、hauler 4C4M（400）、upgrader 5W2C7M（950）、builder 同 upgrader
     *           —— 全部满足 n_MOVE = 非 MOVE（平地 1 tick/格）
     *   合计 9 人（旧 quota 同房间为 miner 5 + hauler 3 + builder 2 + upgrader 3 = 13 人）。
     * ------------------------------------------------------------------------------------ */

    return {
        target: { yield: targetYield, haulerRate: r4(haulerRate) },
        roles: roles,
        bodies: bodies,
        etaMode: etaMode,
        upkeepCap: upkeepCap,
    };
}

module.exports = { plan: plan };

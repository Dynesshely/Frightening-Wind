/**
 * core.estimator —— L1 估计层：模型公式的纯 JS 版。
 *
 * ============================== 这一层是什么 ==============================
 *
 * docs/ARCHITECTURE_V2.md §3 把 L1 定义成"模型公式的 JS 版（纯函数）"：
 * 输入几个数字，输出几个数字，不读 Game、不写 Memory、不看 config.core 开关。
 * 上层（L2 budget/policy）和 L0（ledger 的 eta）都只通过这里拿数，
 * 这样"模型算的"和"线上跑的"永远是同一套公式 —— 旧版最大的坑就是
 * docs/MODEL.md 里的公式和 src/ 里的实现各写一遍，然后慢慢漂移。
 *
 * 公式来源（Python 版，逐行对照，不要凭记忆改）：
 *   modeling/models/mining.py    steady_yield()                → yieldOf / workFor   （fig20/fig72）
 *   modeling/models/movement.py  weight() / tile_ticks() / trip_ticks()  → （fig01/fig03/fig70）
 *   modeling/models/logistics.py throughput() / haulers_needed()        → （fig30/fig31）
 *   modeling/models/upkeep.py    decay_energy_per_tick() / link_throughput()（fig83/fig85）
 *
 * 关键词（与 MECHANICS.md 的编号对应）：
 *   M02 疲劳：φ += w·c；φ -= 2·n_MOVE；满速要求 2·n_MOVE ≥ w·c ⇒ **平地 1:1，不是 1:2**（D9）
 *   M08 source 容量三档：无主 1500 / 已占领或预订 3000 / 中心房 4000
 *   M12 折旧：container 5000/500(tick, 有主)；road = 自然率×(1+交通项)；rampart 300/100
 *   注意 upkeepDebt() 会优先采用 config.core.upkeepUnit 的单件成本（Lead 的口径），
 *   只有缺项才回退到公式；decayEnergyPerTick() 永远返回公式值，方便与 Python 版对拍。
 *   M13 link：实收 97%，冷却 = 距离格数 ⇒ 吞吐 776/d
 *
 * ============================== 输入约定 ==============================
 *
 * parts 支持三种写法（内部统一成"部件计数表"，避免上层各写一套）：
 *   ['work','carry','move']            // config.bodies.* 的 tier 就是这种
 *   { work: 1, carry: 2, move: 2 }     // 显式计数
 *   '1W2C2M'                           // 紧凑串（日志/图表里常用）
 *
 * terrain 支持：'plain' | 'swamp' | 'road'（也接受 0/1/2 或 TERRAIN_MASK 数值）。
 *
 * loaded 支持：1 / 0 / 0..1 的装载率（空 CARRY 不产生疲劳，见 M02）。
 */
const config = require('config');

/* ------------------------------ 官方常数 ------------------------------ */
/*
 * config.js 目前不含游戏常数，而本层的依赖白名单只有 config（不许 require fw.*），
 * 所以这里内置官方值作为默认；若将来 config.consts 提供了同名键，则自动以 config 为准。
 * 全部数值与 modeling/mw/params.py 的 OFFICIAL 层逐项一致（见 MECHANICS.md §1）。
 */
const OFFICIAL = {
    BODYPART_COST: {
        move: 50, work: 100, carry: 50, attack: 80,
        ranged_attack: 150, heal: 250, tough: 10, claim: 600,
    },
    CARRY_CAPACITY: 50,
    HARVEST_POWER: 2,
    CREEP_LIFE_TIME: 1500,
    CREEP_SPAWN_TIME: 3,
    CREEP_PART_MAX_ENERGY: 125,
    SOURCE_ENERGY_CAPACITY: 3000,
    SOURCE_ENERGY_NEUTRAL_CAPACITY: 1500,
    SOURCE_ENERGY_KEEPER_CAPACITY: 4000,
    ENERGY_REGEN_TIME: 300,
    TERRAIN_FATIGUE: { road: 1, plain: 2, swamp: 10 },
    REPAIR_COST: 0.01,
    REPAIR_POWER: 100,
    CONTAINER_HITS: 250000,
    CONTAINER_DECAY: 5000,
    CONTAINER_DECAY_TIME: 100,
    CONTAINER_DECAY_TIME_OWNED: 500,
    ROAD_HITS: 5000,
    ROAD_DECAY_AMOUNT: 100,
    ROAD_DECAY_TIME: 1000,
    CONSTRUCTION_COST_ROAD_SWAMP_RATIO: 5,
    CONSTRUCTION_COST_ROAD_WALL_RATIO: 150,
    ROAD_DECAY_WALL: 15000,
    RAMPART_DECAY_AMOUNT: 300,
    RAMPART_DECAY_TIME: 100,
    RAMPART_HITS_MAX: { 2: 300000, 3: 1000000, 4: 3000000, 5: 10000000,
                        6: 30000000, 7: 100000000, 8: 300000000 },
    WALL_HITS_MAX: 300000000,
    LINK_CAPACITY: 800,
    LINK_LOSS_RATIO: 0.03,
};

/** 取常数：config.consts 优先，否则官方默认值。 */
function K(name) {
    const c = config && config.consts;
    if (c && c[name] !== undefined) return c[name];
    return OFFICIAL[name];
}

/* ------------------------------ 小工具 ------------------------------ */

const LETTERS = { W: 'work', C: 'carry', M: 'move', A: 'attack', R: 'ranged_attack', H: 'heal', T: 'tough', L: 'claim' };

/** 把 parts 的三种写法统一成 { work: n, carry: n, ... }。非法输入一律按空处理（纯函数不该抛）。 */
function countParts(parts) {
    const out = {};
    if (!parts) return out;
    if (typeof parts === 'string') {
        // '1W2C2M'：数字 + 字母，字母见 LETTERS
        const re = /(\d*)([A-Za-z])/g;
        let m;
        while ((m = re.exec(parts)) !== null) {
            const name = LETTERS[m[2].toUpperCase()];
            if (!name) continue;
            out[name] = (out[name] || 0) + (m[1] ? parseInt(m[1], 10) : 1);
        }
        return out;
    }
    if (Array.isArray(parts)) {
        for (let i = 0; i < parts.length; i++) {
            const name = String(parts[i] || '').toLowerCase();
            if (!name) continue;
            out[name] = (out[name] || 0) + 1;
        }
        return out;
    }
    if (typeof parts === 'object') {
        for (const k in parts) {
            if (!Object.prototype.hasOwnProperty.call(parts, k)) continue;
            const name = String(k).toLowerCase();
            if (!name) continue;
            out[name] = (out[name] || 0) + (Number(parts[k]) || 0);
        }
        return out;
    }
    return out;
}

/** 总部件数（决定孵化时间 3·N，M04）。 */
function bodySize(parts) {
    const c = countParts(parts);
    let n = 0;
    for (const k in c) n += c[k];
    return n;
}

/** body 造价（Σ 部件 × 单价，M06/recycle 都要用）。 */
function bodyCost(parts) {
    const c = countParts(parts);
    const cost = K('BODYPART_COST');
    let total = 0;
    for (const k in c) total += (cost[k] || 0) * c[k];
    return total;
}

/** 地形系数：1 道路 / 2 平地 / 10 沼泽；不可走（墙）返回 Infinity。 */
function terrainCost(terrain) {
    const tg = K('TERRAIN_FATIGUE');
    if (typeof terrain === 'number') {
        // TERRAIN_MASK_WALL=1 / SWAMP=2；0 是平地
        if (terrain === 1) return Infinity;
        return terrain === 2 ? tg.swamp : tg.plain;
    }
    const key = String(terrain || 'plain').toLowerCase();
    if (key === 'wall' || key === 'lava') return Infinity;
    if (tg[key] !== undefined) return tg[key];
    return tg.plain;
}

/**
 * 有效重量 w（M02）：产生疲劳的部件数，**空 CARRY 不计**。
 * loaded = 1 / 0 / 0..1 装载率；WORK/ATTACK 等无论有没在干活都算重量。
 */
function bodyWeight(parts, loaded) {
    const frac = loaded === undefined ? 1 : (loaded === true ? 1 : (loaded === false ? 0 : Math.max(0, Math.min(1, Number(loaded) || 0))));
    const c = countParts(parts);
    let w = 0;
    for (const k in c) {
        if (k === 'move') continue;
        if (k === 'carry') { w += c[k] * frac; continue; }
        w += c[k];
    }
    return w;
}

/**
 * 走一格要几个 tick（M02 / fig01）：
 *     T = ceil( w·c / (2·n_MOVE) )，w=0 时固定 1 tick（空载最省）。
 */
function tileTicks(parts, terrain, loaded) {
    const c = countParts(parts);
    const move = c.move || 0;
    if (move <= 0) return Infinity;                 // 没 MOVE 走不动
    const cost = terrainCost(terrain);
    if (!isFinite(cost)) return Infinity;           // 墙/岩浆
    const w = bodyWeight(parts, loaded);
    if (w <= 0) return 1;                           // 空载：零疲劳
    return Math.ceil(w * cost / (2 * move));
}

/**
 * 往返耗时（fig70）：去程满载、回程空载（空 CARRY 不计疲劳，M02）。
 * 返回数字 = 总 tick；需要分项用 tripTicksDetail()。
 */
function tripTicks(parts, steps, terrain) {
    return tripTicksDetail(parts, steps, terrain).total;
}

/**
 * 往返分项（去/回/合计 + 单格耗时）。
 * 注意：不含装卸的 2 tick，需要总周期时由 throughput() 自己加（见 logistics.py 口径）。
 */
function tripTicksDetail(parts, steps, terrain) {
    const s = Math.max(0, Number(steps) || 0);
    const out = tileTicks(parts, terrain, 1) * s;
    const back = tileTicks(parts, terrain, 0) * s;
    return {
        out: out,
        back: back,
        total: out + back,
        tileOut: tileTicks(parts, terrain, 1),
        tileBack: tileTicks(parts, terrain, 0),
    };
}

/**
 * 单个 hauler 的吞吐（e/tick，fig30）：
 *     Thr = 50·n_CARRY / (往返 + 2)     ← +2 是装卸各 1 tick（logistics.py 口径）
 */
function throughput(parts, steps, terrain) {
    const c = countParts(parts);
    const cap = K('CARRY_CAPACITY') * (c.carry || 0);
    if (cap <= 0) return 0;
    const t = tripTicks(parts, steps, terrain) + 2;
    if (!isFinite(t) || t <= 0) return 0;
    return cap / t;
}

/** 默认 hauler body：取 config.bodies.hauler 的最高档（tiers 最后一档）。 */
function defaultHaulerBody() {
    const def = (config && config.bodies && config.bodies.hauler) || null;
    if (def && def.tiers && def.tiers.length) return def.tiers[def.tiers.length - 1];
    if (def && def.unit) return def.unit;
    return ['carry', 'carry', 'move'];
}

/**
 * 喂满 rate 需要几个 hauler（fig31）：ceil(rate / throughput)，至少 1。
 * parts 省略时用 config.bodies.hauler 的最高档。
 */
function haulersFor(rate, steps, terrain, parts) {
    const r = Math.max(0, Number(rate) || 0);
    if (r <= 0) return 0;
    const body = parts || defaultHaulerBody();
    const thr = throughput(body, steps, terrain);
    if (thr <= 0) return Infinity;
    return Math.max(1, Math.ceil(r / thr - 1e-9));
}

/**
 * source 稳态产出（e/tick，M08 / fig20 / fig72）：
 *
 *     Y(n, q) = q / ( q/(2n) + 300 )
 *
 * q 是库存上限（**不是**恒为 3000）：未预订中立房 1500、已占领/预订 3000、
 * 中心房 4000。q=3000 时退化成经典式 10n/(5+n)。
 */
function yieldOf(nWork, q) {
    const n = Number(nWork) || 0;
    const cap = q === undefined || q === null ? K('SOURCE_ENERGY_CAPACITY') : (Number(q) || 0);
    if (n <= 0 || cap <= 0) return 0;
    const regen = K('ENERGY_REGEN_TIME');
    const drain = cap / (2 * n);                     // 抽干耗时 D(n)
    return cap / (drain + regen);                    // 稳态 Q/(D+T)
}

/**
 * 反解：要拿到 targetY 需要几个 WORK（fig20）。
 *
 *     Y = q/(q/(2n)+T)  ⇒  n = q·Y / (2·(q − T·Y))
 *
 * ⚠ ARCHITECTURE_V2.md §3 把它写成 n = q*300/(2*(q - targetY))，量纲不对
 *   （q 与 targetY 一个是能量一个是 e/tick，不能相减）。这里按上面的正确反解实现，
 *   并用 yieldOf(workFor(y)) ≈ y 做了往返校验（harness/verify 脚本）。
 * targetY 超过物理上限 q/T 时返回 Infinity（给定 q=3000、T=300，上限就是 10 e/tick）。
 */
function workFor(targetY, q) {
    const y = Math.max(0, Number(targetY) || 0);
    const cap = q === undefined || q === null ? K('SOURCE_ENERGY_CAPACITY') : (Number(q) || 0);
    const regen = K('ENERGY_REGEN_TIME');
    if (y <= 0 || cap <= 0) return 0;
    const room = cap - regen * y;                    // q − T·Y
    if (room <= 0) return Infinity;                  // 已到/超过天花板
    return cap * y / (2 * room);
}

/* ------------------------------ 折旧 / 维护（M12 / fig83） ------------------------------ */

/** 单个 container 的自然折旧（hit/tick）：有主 5000/500=10，无主 5000/100=50。 */
function containerHitsPerTick(owned) {
    const period = owned === false ? K('CONTAINER_DECAY_TIME') : K('CONTAINER_DECAY_TIME_OWNED');
    return K('CONTAINER_DECAY') / period;
}

/** rampart 折旧：300/100 = 3 hit/tick（与上限无关，但补满上限很贵，见 M12/D15）。 */
function rampartHitsPerTick() {
    return K('RAMPART_DECAY_AMOUNT') / K('RAMPART_DECAY_TIME');
}

/** wall 无自然折旧（M12）。 */
function wallHitsPerTick() {
    return 0;
}

/**
 * road 折旧（hit/tick）：自然率 × (1 + 交通项)。
 * 交通项 Λ = 每 tick 踩过该格的**部件数**（官方原文：每个 creep 每踩一次按部件数扣 1 tick 计时）。
 * 自然率：平地 100/1000=0.1；沼泽 500/1000=0.5；墙上 15000/1000=15。
 */
function roadHitsPerTick(terrain, trafficParts) {
    const key = String(terrain || 'plain').toLowerCase();
    const amount = K('ROAD_DECAY_AMOUNT');
    const time = K('ROAD_DECAY_TIME');
    let rate;
    if (key === 'swamp') rate = amount * K('CONSTRUCTION_COST_ROAD_SWAMP_RATIO') / time;
    else if (key === 'wall') rate = K('ROAD_DECAY_WALL') / time;
    else rate = amount / time;
    const traffic = Math.max(0, Number(trafficParts) || 0);
    return rate * (1 + traffic);
}

/** 按结构名取折旧率。kind ∈ container_owned/container_unowned/rampart/wall/road_plain/road_swamp/road_wall。 */
function decayHitsPerTick(kind, trafficParts) {
    const k = String(kind || '');
    if (k === 'container_owned') return containerHitsPerTick(true);
    if (k === 'container_unowned') return containerHitsPerTick(false);
    if (k === 'rampart') return rampartHitsPerTick();
    if (k === 'wall') return wallHitsPerTick();
    if (k.indexOf('road_') === 0) return roadHitsPerTick(k.slice(5), trafficParts);
    return 0;
}

/** 单个结构每 tick 的维护能量：hit/tick × REPAIR_COST（1 能量 = 100 hits）。 */
function decayEnergyPerTick(kind, trafficParts) {
    return decayHitsPerTick(kind, trafficParts) * K('REPAIR_COST');
}

/**
 * 一组结构每 tick 的维护负债（e/tick，fig83）。
 * structs 例：{ container_owned: 3, rampart: 8, road_plain: 24, road_swamp: 0, wall: 0 }
 * 可选 traffic：踩格部件数（road 的交通项；缺省 0 = 只算自然折旧）。
 */
function upkeepDebt(structs, traffic) {
    if (!structs) return 0;
    const trafficParts = Math.max(0, Number(traffic) || 0);
    let total = 0;
    for (const kind in structs) {
        if (!Object.prototype.hasOwnProperty.call(structs, kind)) continue;
        const n = Number(structs[kind]) || 0;
        if (n <= 0) continue;
        total += n * upkeepUnit(kind, trafficParts);
    }
    return total;
}

/**
 * 单件维护成本（e/tick）：**config.core.upkeepUnit 优先，缺项回退公式**。
 *
 * config.js 的 core.upkeepUnit = { rampart: 0.03, container: 0.10, road: 0.0015 }
 * 是 L2 反解"最多养几段"用的口径（fig83）：0.03 / 0.10 与公式完全一致，
 * road 取 0.0015 而不是平地时间项 0.001，是因为它已经含了一点典型交通量。
 * 这里保留公式作为唯一的物理来源，只在对外报"维护负债"时套 config 的口径，
 * 这样 decayEnergyPerTick() 仍然可以逐项与 modeling/models/upkeep.py 对拍。
 */
function upkeepUnit(kind, trafficParts) {
    const cu = (config && config.core && config.core.upkeepUnit) || null;
    const traffic = Math.max(0, Number(trafficParts) || 0);
    if (cu) {
        if (kind === 'container_owned' && cu.container !== undefined) return num0(cu.container);
        if (kind === 'rampart' && cu.rampart !== undefined) return num0(cu.rampart);
        // road 的 config 口径是"平地 + 典型交通"，真实交通量在此基础上按 (1+Λ) 缩放
        if (kind === 'road_plain' && cu.road !== undefined) return num0(cu.road) * (1 + traffic);
    }
    return decayEnergyPerTick(kind, traffic);
}

function num0(v) { const n = Number(v); return isFinite(n) && n >= 0 ? n : 0; }

/** 修 hits 点血要花多少能量（1 能量 = 100 hits）。 */
function repairCostPerTick(hitsPerTick) {
    return Math.max(0, Number(hitsPerTick) || 0) * K('REPAIR_COST');
}

/** 把结构从 0 补到满血/满上限要多少能量（D15：墙不是免费的）。 */
function fullRepairEnergy(kind) {
    const k = String(kind || '');
    const cost = K('REPAIR_COST');
    if (k === 'container_owned' || k === 'container_unowned') return K('CONTAINER_HITS') * cost;
    if (k === 'rampart') {
        const max = K('RAMPART_HITS_MAX');
        return (max[4] || max[8] || 0) * cost;       // 缺省按 RCL4 的上限
    }
    if (k === 'wall') return K('WALL_HITS_MAX') * cost;
    if (k === 'road_plain') return K('ROAD_HITS') * cost;
    if (k === 'road_swamp') return K('ROAD_HITS') * K('CONSTRUCTION_COST_ROAD_SWAMP_RATIO') * cost;
    if (k === 'road_wall') return K('ROAD_HITS') * K('CONSTRUCTION_COST_ROAD_WALL_RATIO') * cost;
    return 0;
}

/* ------------------------------ link（M13 / fig85） ------------------------------ */

/**
 * link 稳态吞吐（e/tick）：一次送 800、实收 97%、冷却 = 距离格数 tick。
 *
 *     Thr(d) = 800 × (1 − 0.03) / d = 776 / d
 *
 * 所以 d=8 是 97 e/tick，d=24 只有 32 e/tick —— link 不是"无损瞬移"。
 */
function linkThroughput(distance) {
    const d = Math.max(1, Number(distance) || 1);
    return K('LINK_CAPACITY') * (1 - K('LINK_LOSS_RATIO')) / d;
}

/* ------------------------------ 顺带的几个常用量 ------------------------------ */

/** source 库存上限按房间状态取（M08）：'neutral' 1500 / 'owned' 3000 / 'keeper' 4000。 */
function sourceCapacity(state) {
    const s = String(state || 'owned').toLowerCase();
    if (s === 'neutral' || s === 'unreserved') return K('SOURCE_ENERGY_NEUTRAL_CAPACITY');
    if (s === 'keeper' || s === 'center' || s === 'sk') return K('SOURCE_ENERGY_KEEPER_CAPACITY');
    return K('SOURCE_ENERGY_CAPACITY');
}

/** 孵化时间：3 tick/部件（M04）。 */
function spawnTicks(parts) {
    return K('CREEP_SPAWN_TIME') * bodySize(parts);
}

/** 摊销成本（e/tick）：cost / 1500（M06）。 */
function amortizedCost(parts) {
    return bodyCost(parts) / K('CREEP_LIFE_TIME');
}

/**
 * 续命一次的 TTL 增量与能耗（M06，官方 renewCreep 正文）：
 *   TTL += floor(600 / body_size)     能量 = ceil(cost / 2.5 / body_size)
 */
function renewStep(parts) {
    const n = bodySize(parts);
    if (n <= 0) return { ttl: 0, energy: 0 };
    return { ttl: Math.floor(600 / n), energy: Math.ceil(bodyCost(parts) / 2.5 / n) };
}

/** 回收返还上限：125 能量/部件（M07 / CREEP_PART_MAX_ENERGY）。 */
function recycleRefundCap(parts) {
    return K('CREEP_PART_MAX_ENERGY') * bodySize(parts);
}

module.exports = {
    // 契约要求的 10 个（ARCHITECTURE_V2.md §3）
    yieldOf: yieldOf,
    workFor: workFor,
    bodyCost: bodyCost,
    bodyWeight: bodyWeight,
    tileTicks: tileTicks,
    tripTicks: tripTicks,
    throughput: throughput,
    haulersFor: haulersFor,
    upkeepDebt: upkeepDebt,
    linkThroughput: linkThroughput,
    repairCostPerTick: repairCostPerTick,
    // 支撑函数（纯函数，L2/L3 直接用，别在别处重写）
    countParts: countParts,
    bodySize: bodySize,
    terrainCost: terrainCost,
    tripTicksDetail: tripTicksDetail,
    defaultHaulerBody: defaultHaulerBody,
    containerHitsPerTick: containerHitsPerTick,
    rampartHitsPerTick: rampartHitsPerTick,
    roadHitsPerTick: roadHitsPerTick,
    decayHitsPerTick: decayHitsPerTick,
    decayEnergyPerTick: decayEnergyPerTick,
    upkeepUnit: upkeepUnit,
    fullRepairEnergy: fullRepairEnergy,
    sourceCapacity: sourceCapacity,
    spawnTicks: spawnTicks,
    amortizedCost: amortizedCost,
    renewStep: renewStep,
    recycleRefundCap: recycleRefundCap,
    OFFICIAL: OFFICIAL,
};

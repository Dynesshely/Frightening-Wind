/**
 * fw.store —— 能量流：库存读写、采集、取货、交付、倾倒。
 *
 * 负责：
 *   - 库存读写原语：storeOf / usedCap / usedEnergy / freeCap / freeEnergyCap；
 *   - 工作状态机：isWorking（空手→装满，接近满载→交付，滞回避免来回抖）；
 *   - 采集：pickSource（粘性选源）/ harvestSource；
 *   - 取货：nearestLooseEnergy / nearestEnergyStore / withdrawEnergy / transferFrom；
 *   - 交付：deliverEnergy / transferTo / dumpSurplus / spawnSurplus。
 *
 * 不该放进来：
 *   - 建造 / 维修 / 升级控制器（fw.build）；
 *   - 身体组装与角色推断（fw.body）；
 *   - 房间快照与敌对分级（fw.room）、地形判定（fw.geo）；
 *   - 位移策略：本模块只调用 fw.nav 的 moveTo，绝不直接写 creep.moveTo / creep.move。
 *
 * 依赖：fw.log（计数 + 说话）、fw.nav（唯一移动入口）。不依赖 utils（避免循环 require）。
 */
const log = require('fw.log');
const nav = require('fw.nav');

// 与 utils 门面同一套实现：说话走 fw.log，位移走 fw.nav。
const say = log.say;
const bump = log.ct;
const moveTo = nav.moveTo;

/* ------------------------------ 库存 ------------------------------ */

function storeOf(target) {
    if (!target) return null;
    if (target.store) return target.store;
    return null;
}

function usedCap(creep) {
    if (creep.store) return creep.store.getUsedCapacity() || 0;
    return _.sum(creep.carry) || 0;
}

function usedEnergy(creep) {
    if (creep.store) return creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    return creep.carry[RESOURCE_ENERGY] || 0;
}

function freeCap(creep) {
    if (creep.store) return creep.store.getFreeCapacity() || 0;
    return creep.carryCapacity - (_.sum(creep.carry) || 0);
}

function freeEnergyCap(target) {
    if (!target || !target.store) return 0;
    return target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
}

/**
 * 工作状态机：空手 → 先去装满；干活干到空手 → 再回去装。
 * 没有这个状态机，creep 会在"刚交掉一点货有空格"时立刻掉头回矿源，
 * 造成来回长跑却几乎不产出（RCL1 卡住的主因）。
 */
function isWorking(creep) {
    const used = usedCap(creep);
    const capacity = (creep.store ? creep.store.getCapacity() : creep.carryCapacity) || 0;

    // 滞回状态机：只有接近满载才转"交付"，只有完全空才转"采集"。
    // 旧实现"有 1 点能量就判满"会让 creep 在矿源和交付点之间来回抖动（线上实测 1 格反复横跳）。
    if (creep.memory.working === undefined) creep.memory.working = false;
    if (capacity > 0 && used >= capacity * 0.8) creep.memory.working = true;
    else if (used === 0) creep.memory.working = false;
    return creep.memory.working === true;
}

/* ------------------------------ 采集 ------------------------------ */

/**
 * 选一个"人最少"的矿源，并粘在 creep.memory.sourceId 上
 */
function pickSource(creep, data) {
    if (!data.sources.length) return null;

    // 统计每个矿源当前分配的活着的 creep 数量
    const load = {};
    for (const s of data.sources) load[s.id] = 0;
    for (const c of data.creeplist) {
        if (c.name === creep.name) continue;
        const sid = c.memory && c.memory.sourceId;
        if (sid !== undefined && load[sid] !== undefined) load[sid]++;
    }

    let best = data.sources[0];
    for (const s of data.sources) {
        if (load[s.id] < load[best.id]) best = s;
    }

    const id = creep.memory.sourceId;
    const current = id ? Game.getObjectById(id) : null;

    // 粘性：已经有矿源且负载不明显失衡 -> 继续挖原来的
    if (current && load[current.id] !== undefined && load[current.id] <= load[best.id] + 1) {
        return current;
    }

    creep.memory.sourceId = best.id;
    return best;
}

function harvestSource(creep, data) {
    const source = pickSource(creep, data);
    if (!source) return false;
    say(creep, '⛏');
    const hr = creep.harvest(source);
    if (hr === OK) bump('harvest');
    else if (hr === ERR_NOT_IN_RANGE) moveTo(creep, source);
    else bump('harvestErr_' + hr);
    return true;
}

/* ------------------------------ 取能量 ------------------------------ */

function hasEnergyIn(store) {
    if (!store) return false;
    return (store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0;
}

function nearestLooseEnergy(creep, data) {
    let best = null;
    let bestDist = 999;
    const consider = (obj, amount) => {
        if (amount < 20) return;
        const d = creep.pos.getRangeTo(obj);
        if (d < bestDist) { bestDist = d; best = obj; }
    };
    for (const d of data.dropped) {
        if (d.resourceType === RESOURCE_ENERGY) consider(d, d.amount);
    }
    for (const t of data.tombstones) consider(t, t.store.getUsedCapacity(RESOURCE_ENERGY) || 0);
    for (const r of data.ruins) consider(r, r.store.getUsedCapacity(RESOURCE_ENERGY) || 0);
    return best;
}

/**
 * 找最近的、有能量的容器/仓储。
 * excludeController=true 时跳过"控制器旁边的容器"（那是留给升级者的口粮，
 * 搬运工去取会和升级者形成来回搬运的循环）。
 */
function nearestEnergyStore(creep, data, minAmount, excludeController) {
    const controller = data.room.controller;
    let best = null;
    let bestDist = 999;
    const consider = obj => {
        if ((obj.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < minAmount) return;
        if (excludeController && controller && obj.pos.getRangeTo(controller) <= 3) return;
        const d = creep.pos.getRangeTo(obj);
        if (d < bestDist) { bestDist = d; best = obj; }
    };
    if (data.storage) consider(data.storage);
    for (const c of data.containers) consider(c);
    if (data.links) for (const l of data.links) consider(l);
    return best;
}

/**
 * 取能量：掉落/墓碑顺路就捡；否则在"容器/仓储"与"矿源"之间挑更近的那个。
 * 返回 true 表示本 tick 已经处理过（在采或在路上）。
 */
function withdrawEnergy(creep, data) {
    const loose = nearestLooseEnergy(creep, data);
    if (loose && creep.pos.getRangeTo(loose) <= 6) {
        return transferFrom(creep, loose);
    }

    const store = nearestEnergyStore(creep, data, 50);
    const source = pickSource(creep, data);

    if (store && !source) return transferFrom(creep, store);
    if (store && source) {
        const ds = creep.pos.getRangeTo(store);
        const dsrc = creep.pos.getRangeTo(source);
        if (ds + 2 < dsrc) return transferFrom(creep, store);
    }

    if (source) return harvestSource(creep, data);
    if (store) return transferFrom(creep, store);
    if (loose) return transferFrom(creep, loose);
    return false;
}

function transferFrom(creep, target) {
    say(creep, '📦');
    // 地上的掉落物只能用 pickup()，withdraw 会返回 ERR_INVALID_TARGET
    const isDropped = target && !target.store;
    const r = isDropped ? creep.pickup(target) : creep.withdraw(target, RESOURCE_ENERGY);
    if (r === ERR_NOT_IN_RANGE) {
        moveTo(creep, target);
        return true;
    }
    if (r === OK) bump('withdraw');
    else bump('withdrawErr_' + r);
    return r === OK;
}

/* ------------------------------ 交付能量 ------------------------------ */

/**
 * 把能量交给最需要的地方：spawn/extension → tower → storage/container
 * 返回 true 表示已经处理
 */
function deliverEnergy(creep, data) {
    const targets = [];

    for (const s of data.spawns) {
        if (freeEnergyCap(s) > 0) targets.push(s);
    }
    for (const e of data.extensions) {
        if (freeEnergyCap(e) > 0) targets.push(e);
    }

    if (targets.length) {
        targets.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
        return transferTo(creep, targets[0]);
    }

    // 塔
    for (const t of data.towers) {
        if (freeEnergyCap(t) > 0) return transferTo(creep, t);
    }

    return false;
}

function transferTo(creep, target) {
    say(creep, '🚚');
    const r = creep.transfer(target, RESOURCE_ENERGY);
    if (r === ERR_NOT_IN_RANGE) {
        moveTo(creep, target);
        return true;
    }
    if (r === OK) bump('transfer');
    else bump('transferErr_' + r);
    return r === OK;
}

/**
 * 富余能量倾倒点：控制器 3 格内的容器。
 * 这样升级者不用跑到矿源去取能量，直接在控制器旁边就能续杯。
 */
function dumpSurplus(creep, data) {
    let best = null;
    let bestDist = 999;

    // storage 优先（容量大、不会像容器那样被工人顺手抽走）
    if (data.storage && freeEnergyCap(data.storage) > 0) {
        best = data.storage;
        bestDist = creep.pos.getRangeTo(data.storage);
    }

    // 其次：控制器旁的容器（就地喂升级者）
    const controller = data.room.controller;
    if (controller) {
        for (const c of data.containers) {
            if (c.pos.getRangeTo(controller) > 3) continue;
            if (freeEnergyCap(c) <= 0) continue;
            const d = creep.pos.getRangeTo(c);
            if (d < bestDist) { bestDist = d; best = c; }
        }
    }

    if (!best) return false;
    return transferTo(creep, best);
}

/**
 * spawn/扩展已满仓时，把"暂时用不到的"能量搬出去升级。
 * 只在 spawn 完全满时启用，避免影响造兵。
 */
function spawnSurplus(creep, data) {
    let fullSpawn = null;
    for (const s of data.spawns) {
        if ((s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) === 0) { fullSpawn = s; break; }
    }
    if (!fullSpawn) return false;

    // 先从扩展里拿，再动 spawn 本身
    let best = null;
    let bestDist = 999;
    for (const e of data.extensions) {
        if ((e.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < 50) continue;
        const d = creep.pos.getRangeTo(e);
        if (d < bestDist) { bestDist = d; best = e; }
    }
    if (best) return transferFrom(creep, best);
    if ((fullSpawn.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= 200) {
        return transferFrom(creep, fullSpawn);
    }
    return false;
}

module.exports = {
    storeOf,
    usedCap,
    usedEnergy,
    freeCap,
    freeEnergyCap,
    isWorking,
    pickSource,
    harvestSource,
    nearestLooseEnergy,
    nearestEnergyStore,
    withdrawEnergy,
    transferFrom,
    deliverEnergy,
    transferTo,
    dumpSurplus,
    spawnSurplus,
};

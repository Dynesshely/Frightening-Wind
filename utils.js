/**
 * 通用工具函数集合（不修改 Creep/Room 原型，全部是纯函数）
 */
const config = require('config');

/* ------------------------------ 缓存 ------------------------------ */

function tickCache() {
    if (!global.__fwCache) global.__fwCache = { tick: -1, rooms: {} };
    const c = global.__fwCache;
    if (c.tick !== Game.time) {
        c.tick = Game.time;
        c.rooms = {};
    }
    return c;
}

/**
 * 老版本服务器缺少某些 FIND_* 常量时安全返回空数组
 */
function findSafe(room, type) {
    if (type === null || type === undefined) return [];
    try {
        return room.find(type);
    } catch (e) {
        return [];
    }
}

/**
 * 每 tick 每个房间只做一次 find，得到房间快照
 */
function roomData(room) {
    const cache = tickCache();
    let d = cache.rooms[room.name];
    if (d) return d;

    d = {
        room: room,
        level: room.controller ? room.controller.level : 0,
        sources: room.find(FIND_SOURCES),
        mineral: findSafe(room, typeof FIND_MINERALS !== 'undefined' ? FIND_MINERALS : null)[0] || null,
        spawns: room.find(FIND_MY_SPAWNS),
        structures: room.find(FIND_MY_STRUCTURES),
        allStructures: findSafe(room, FIND_STRUCTURES),
        sites: room.find(FIND_CONSTRUCTION_SITES),
        sitesMine: [],
        creeplist: room.find(FIND_MY_CREEPS),
        hostiles: room.find(FIND_HOSTILE_CREEPS),
        dropped: findSafe(room, typeof FIND_DROPPED_RESOURCES !== 'undefined' ? FIND_DROPPED_RESOURCES : null),
        tombstones: findSafe(room, typeof FIND_TOMBSTONES !== 'undefined' ? FIND_TOMBSTONES : null),
        ruins: findSafe(room, typeof FIND_RUINS !== 'undefined' ? FIND_RUINS : null),
    };
    d.sitesMine = d.sites;
    d.extensions = d.structures.filter(s => s.structureType === STRUCTURE_EXTENSION);
    d.towers = d.structures.filter(s => s.structureType === STRUCTURE_TOWER);
    d.storage = d.structures.filter(s => s.structureType === STRUCTURE_STORAGE)[0] || null;

    // 容器 / 道路 / 墙 / rampart 属于中立结构，不在 FIND_MY_STRUCTURES 里
    d.containers = d.allStructures.filter(s => s.structureType === STRUCTURE_CONTAINER);
    d.roads = d.allStructures.filter(s => s.structureType === STRUCTURE_ROAD);
    d.walls = d.allStructures.filter(s => s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART);
    d.damageable = d.structures.concat(d.containers, d.roads);
    d.spawnList = d.spawns;

    // 按角色统计本房 creep
    d.creepsByRole = {};
    for (const c of d.creeplist) {
        const r = (c.memory && c.memory.role) || 'unknown';
        d.creepsByRole[r] = (d.creepsByRole[r] || 0) + 1;
    }

    cache.rooms[room.name] = d;
    return d;
}

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

    if (creep.memory.working === undefined) creep.memory.working = used > 0;
    if (used === 0) creep.memory.working = false;
    else if (used >= capacity) creep.memory.working = true;
    return creep.memory.working === true;
}

/* ------------------------------ 计数 ------------------------------ */

function bump(name) {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.ct) Memory.fw.ct = { since: Game.time };
    Memory.fw.ct[name] = (Memory.fw.ct[name] || 0) + 1;
    Memory.fw.ct.until = Game.time;
}

/* ------------------------------ 移动 ------------------------------ */

function moveTo(creep, target, opts) {
    if (!target) return false;
    const options = Object.assign({ reusePath: config.pathReuse, ignoreCreeps: false }, opts || {});
    const r = creep.moveTo(target, options);
    if (r === OK) bump('move');
    else if (r === ERR_NO_PATH) bump('noPath');
    else if (r === ERR_TIRED) bump('tired');
    else bump('moveErr_' + r);
    return r === OK || r === ERR_TIRED || r === ERR_NO_PATH;
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
    const r = creep.withdraw(target, RESOURCE_ENERGY);
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
    const controller = data.room.controller;
    if (!controller) return false;
    let best = null;
    let bestDist = 999;
    for (const c of data.containers) {
        if (c.pos.getRangeTo(controller) > 3) continue;
        if (freeEnergyCap(c) <= 0) continue;
        const d = creep.pos.getRangeTo(c);
        if (d < bestDist) { bestDist = d; best = c; }
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

/* ------------------------------ 建造 / 维修 / 升级 ------------------------------ */

/**
 * 工地优先级：数字越小越先建。
 * 矿源旁容器（直接提升产能）最优先；控制器容器/仓储（只是缓冲）靠后。
 */
function sitePriority(site, data) {
    switch (site.structureType) {
        case STRUCTURE_CONTAINER:
            for (const s of (data.sources || [])) {
                if (site.pos.getRangeTo(s.pos) <= 2) return 1;
            }
            return 5;
        case STRUCTURE_TOWER: return 2;
        case STRUCTURE_EXTENSION: return 3;
        case STRUCTURE_STORAGE: return 5;
        case STRUCTURE_LINK: return 5;
        case STRUCTURE_ROAD: return 7;
        default: return 6;
    }
}

function buildSomething(creep, data) {
    if (!data.sites.length) return false;
    let best = null;
    let bestDist = 999;
    let bestPri = 99;
    // 先按结构类型优先级，再按距离
    // 评分 = 类型优先级 * 8 + 距离：优先级仍然重要，但不会为了优先级跑 30 格
    let bestScore = Infinity;
    for (const s of data.sites) {
        const pri = sitePriority(s, data);
        const d = creep.pos.getRangeTo(s);
        const score = pri * 8 + d;
        if (score < bestScore) {
            bestScore = score;
            bestPri = pri;
            bestDist = d;
            best = s;
        }
    }
    if (!best) return false;
    say(creep, '🔨');
    const r = creep.build(best);
    if (r === ERR_NOT_IN_RANGE) moveTo(creep, best);
    else if (r === OK) { creep.memory.task = 'building'; bump('build'); }
    return true;
}

/**
 * 只建造附近（range 内）的工地，避免为了建造跑远路
 */
function buildNearby(creep, data, range) {
    let best = null;
    let bestPri = 99;
    let bestDist = 99;
    for (const s of data.sites) {
        const d = creep.pos.getRangeTo(s);
        if (d > range) continue;
        const pri = sitePriority(s, data);
        if (pri < bestPri || (pri === bestPri && d < bestDist)) {
            bestPri = pri;
            bestDist = d;
            best = s;
        }
    }
    if (!best) return false;
    say(creep, '🔨');
    const r = creep.build(best);
    if (r === ERR_NOT_IN_RANGE) moveTo(creep, best);
    else if (r === OK) bump('build');
    return true;
}

function repairSomething(creep, data) {
    const urgent = [];
    const normal = [];

    const candidatesForRepair = data.damageable || data.structures;
    for (const s of candidatesForRepair) {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) continue;
        if (!s.hits || !s.hitsMax) continue;
        const ratio = s.hits / s.hitsMax;
        if (ratio >= config.repairThreshold) continue;
        if (ratio < config.repairUrgent) urgent.push(s);
        else normal.push(s);
    }

    const list = urgent.length ? urgent : normal;
    if (!list.length) return false;

    list.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
    const target = list[0];
    say(creep, '🔧');
    const r = creep.repair(target);
    if (r === ERR_NOT_IN_RANGE) moveTo(creep, target);
    else if (r === OK) creep.memory.task = 'repairing';
    return true;
}

function upgradeController(creep, room) {
    const controller = room.controller;
    if (!controller || !controller.my) return false;
    say(creep, '⚡');
    const r = creep.upgradeController(controller);
    if (r === OK) bump('upgrade');
    else if (r === ERR_NOT_IN_RANGE) moveTo(creep, controller);
    else bump('upgradeErr_' + r);
    return true;
}

/* ------------------------------ 身体规划 ------------------------------ */

const PART_COST = (function () {
    const map = {};
    map[WORK] = 100;
    map[CARRY] = 50;
    map[MOVE] = 50;
    map[ATTACK] = 80;
    map[RANGED_ATTACK] = 150;
    map[HEAL] = 250;
    map[TOUGH] = 10;
    map[CLAIM] = 600;
    return map;
})();

function bodyCost(body) {
    let c = 0;
    for (const p of body) c += PART_COST[p] || 0;
    return c;
}

/**
 * 在给定能量预算内，尽可能造出最大的身体
 */
function planBody(role, energy) {
    const def = config.bodies[role];
    if (!def) return null;

    const body = [];
    let cost = 0;
    let units = 0;

    while (units < def.maxUnits && body.length + def.unit.length <= 50) {
        const unitCost = bodyCost(def.unit);
        if (cost + unitCost > energy) break;
        for (const p of def.unit) body.push(p);
        cost += unitCost;
        units++;
    }

    if (units === 0) return null;

    // 剩余能量：保持"每个非 MOVE 零件都有 MOVE 背"的平衡（疲劳=0 才能满速移动）
    const filler = def.filler || ['work', 'carry', 'move'];
    let guard = 0;
    while (body.length < 50 && guard++ < 80) {
        const moves = body.filter(p => p === MOVE).length;
        const weight = body.length - moves;
        const needMoves = Math.ceil(weight / 2);

        // 先补齐移速
        if (moves < needMoves && cost + PART_COST[MOVE] <= energy) {
            body.push(MOVE);
            cost += PART_COST[MOVE];
            continue;
        }

        // 再加一个普通零件，且必须同时付得起"它需要的额外 MOVE"
        let added = false;
        for (const token of filler) {
            const part = PART[token.toUpperCase()];
            if (part === undefined || part === MOVE) continue;
            const c = PART_COST[part];
            const neededAfter = Math.ceil((weight + 1) / 2);
            const extraMoves = Math.max(0, neededAfter - moves);
            const totalCost = c + extraMoves * PART_COST[MOVE];
            if (cost + totalCost <= energy) {
                body.push(part);
                cost += c;
                for (let i = 0; i < extraMoves; i++) {
                    body.push(MOVE);
                    cost += PART_COST[MOVE];
                }
                added = true;
                break;
            }
        }
        if (!added) break;
    }

    // 排序：非 MOVE 在前，MOVE 在后（不影响移速，但符合常规习惯）
    const moves = body.filter(p => p === MOVE);
    const others = body.filter(p => p !== MOVE);
    return others.concat(moves);
}

const PART = { WORK: WORK, CARRY: CARRY, MOVE: MOVE };

/* ------------------------------ 说话 ------------------------------ */

function say(creep, text) {
    if (creep.memory.lastSay !== text) {
        creep.memory.lastSay = text;
        creep.say(text);
    }
}

/* ------------------------------ 角色 ---------------------------------- */

function inferRole(creep) {
    const body = creep.body || [];
    const hasWork = body.some(p => p.type === WORK);
    const hasCarry = body.some(p => p.type === CARRY);
    if (hasWork && hasCarry) return 'harvester';
    if (hasCarry && !hasWork) return 'hauler';
    return 'harvester';
}

function countRole(data, role) {
    return data.creepsByRole[role] || 0;
}

module.exports = {
    roomData,
    storeOf,
    usedCap,
    usedEnergy,
    freeCap,
    freeEnergyCap,
    moveTo,
    pickSource,
    harvestSource,
    withdrawEnergy,
    deliverEnergy,
    transferTo,
    transferFrom,
    dumpSurplus,
    spawnSurplus,
    nearestLooseEnergy,
    nearestEnergyStore,
    buildSomething,
    buildNearby,
    repairSomething,
    upgradeController,
    planBody,
    bodyCost,
    say,
    isWorking,
    inferRole,
    countRole,
};
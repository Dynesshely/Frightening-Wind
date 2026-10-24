/**
 * 各角色的行为实现
 */
const config = require('config');
const utils = require('utils');

/* ------------------------------ 通用小工具 ------------------------------ */

function pickupLoose(creep, data) {
    return utils.withdrawEnergy(creep, data);
}

/* ------------------------------ 采集者 ------------------------------ */

function harvester(creep, data) {
    if (!utils.isWorking(creep)) {
        // 采集者只顺路捡掉落物/墓碑，不抢容器里的存量（那是升级者/建造者的口粮）
        const loose = utils.nearestLooseEnergy(creep, data);
        if (loose && creep.pos.getRangeTo(loose) <= 4) {
            utils.transferFrom(creep, loose);
            return;
        }
        utils.harvestSource(creep, data);
        return;
    }

    // 满载：优先补给 spawn/扩展/塔
    if (utils.deliverEnergy(creep, data)) return;
    // 顺手建"就在身边"的工地（矿源旁的容器）：把交付路程直接变成建造进度
    if (utils.buildNearby(creep, data, 4)) return;
    // 再倒给控制器旁的容器（喂升级者），最后自己升级
    if (utils.dumpSurplus(creep, data)) return;
    utils.upgradeController(creep, data.room);
}

/* ------------------------------ 静态矿工 ------------------------------ */

/**
 * 站在矿源/容器上一直挖，满了就倒进旁边的容器。
 * 容器没空间或丢失时退化为：送到 spawn/扩展 → 升级。
 */
function miner(creep, data) {
    const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
    if (!source) {
        // 矿源丢了：退回通用采集逻辑
        if (utils.freeCap(creep) > 0) { utils.harvestSource(creep, data); return; }
        if (utils.deliverEnergy(creep, data)) return;
        utils.upgradeController(creep, data.room);
        return;
    }

    if (!utils.isWorking(creep)) {
        utils.say(creep, '⛏');
        const hr = creep.harvest(source);
        if (hr === ERR_NOT_IN_RANGE) utils.moveTo(creep, source);
        return;
    }

    // 满了：优先倒进矿源旁的 link（瞬时传送），其次容器
    let link = null;
    let linkDist = 999;
    if (data.links) {
        for (const l of data.links) {
            if (l.pos.getRangeTo(source.pos) > 3) continue;
            if (utils.freeEnergyCap(l) <= 0) continue;
            const d = creep.pos.getRangeTo(l);
            if (d < linkDist) { linkDist = d; link = l; }
        }
    }
    if (link) {
        utils.transferTo(creep, link);
        return;
    }

    let container = null;
    let bestDist = 3;
    for (const c of data.containers) {
        const d = c.pos.getRangeTo(source.pos);
        if (d <= 2) {
            const dc = creep.pos.getRangeTo(c);
            if (dc < bestDist) { bestDist = dc; container = c; }
        }
    }
    if (container && utils.freeEnergyCap(container) > 0) {
        utils.transferTo(creep, container);
        return;
    }
    if (utils.deliverEnergy(creep, data)) return;
    utils.upgradeController(creep, data.room);
}

/* ------------------------------ 搬运工 ------------------------------ */

/**
 * 从容器/仓储把能量搬到 spawn/扩展/塔；没有缺口就倒给控制器容器或自己升级。
 */
function hauler(creep, data) {
    const capacity = creep.store.getCapacity(RESOURCE_ENERGY) || 50;
    const energy = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

    if (utils.isWorking(creep)) {
        if (utils.deliverEnergy(creep, data)) return;
        if (utils.dumpSurplus(creep, data)) return;
        // 搬运工没有 WORK 部件，升级/建造都做不了 —— 就地待命等下游腾出空间
        utils.say(creep, '💤');
        const waitSpot = data.storage || data.spawns[0];
        if (waitSpot && creep.pos.getRangeTo(waitSpot) > 2) utils.moveTo(creep, waitSpot, { range: 2 });
        return;
    }

    // 取货：离得近的容器/仓储有能量就去搬（跳过控制器旁容器，那是升级者的口粮）
    const store = utils.nearestEnergyStore(creep, data, 50, true);
    if (store) {
        utils.transferFrom(creep, store);
        return;
    }

    // 容器里没货：手上有点能量就先交货，否则去矿源边等/自己挖
    if (energy > 0) {
        if (utils.deliverEnergy(creep, data)) return;
        if (utils.dumpSurplus(creep, data)) return;
        utils.upgradeController(creep, data.room);
        return;
    }
    utils.say(creep, '💤');
}

/* ------------------------------ 建造者 ------------------------------ */

function builder(creep, data) {
    if (!utils.isWorking(creep)) {
        if (pickupLoose(creep, data)) return;
        utils.harvestSource(creep, data);
        return;
    }

    if (utils.buildSomething(creep, data)) return;
    if (utils.repairSomething(creep, data)) return;
    if (utils.deliverEnergy(creep, data)) return;
    utils.upgradeController(creep, data.room);
}

/* ------------------------------ 升级者 ------------------------------ */

function upgrader(creep, data) {
    if (!utils.isWorking(creep)) {
        // 1) 就近有存量的容器/仓储 -> 取
        const near = utils.nearestEnergyStore(creep, data, 50, false);
        if (near && creep.pos.getRangeTo(near) <= 8) {
            utils.transferFrom(creep, near);
            return;
        }
        if (pickupLoose(creep, data)) return;
        // 2) spawn 满仓时搬它的闲置能量
        const spare = utils.spawnSurplus(creep, data);
        if (spare) return;

        // 3) 控制器旁有容器（哪怕一时空着）：原地等搬运工送货，
        //    不要跑 20+ 格去矿源自己挖——那样往返一次只升级 50 点，血亏
        const controller = data.room.controller;
        if (controller) {
            let waitingSpot = null;
            for (const c of data.containers) {
                if (c.pos.getRangeTo(controller) <= 3) { waitingSpot = c; break; }
            }
            if (waitingSpot) {
                utils.say(creep, '💤');
                if (creep.pos.getRangeTo(waitingSpot) > 1) utils.moveTo(creep, waitingSpot);
                return;
            }
        }

        // 4) 实在没有补给点才自己去采
        utils.harvestSource(creep, data);
        return;
    }
    // 满载：升级就是它的工作，直接升级（别再走回去把能量倒给 spawn）
    if (utils.upgradeController(creep, data.room)) return;
    // 控制器不可用（没视野/不是我的）才退回补给与建造
    if (utils.deliverEnergy(creep, data)) return;
    utils.buildSomething(creep, data);
}

/* ------------------------------ 远程采集者 ------------------------------ */

/**
 * 去相邻房间挖矿再把能量背回来。
 * 只在"本房间已经饱和"时启用（远距离往返效率天然比本地低，是增量而不是主力）。
 */
function remoteHarvester(creep, data) {
    const home = creep.memory.home || creep.room.name;
    const targetRoom = creep.memory.targetRoom;
    if (!targetRoom) {
        utils.say(creep, '❓');
        return;
    }

    if (!utils.isWorking(creep)) {
        if (creep.room.name !== targetRoom) {
            utils.say(creep, '➡');
            utils.moveToRoom(creep, targetRoom);
            return;
        }
        let source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
        if (!source) {
            const sources = creep.room.find(FIND_SOURCES);
            if (!sources.length) return;
            source = sources[0];
            creep.memory.sourceId = source.id;
        }
        utils.say(creep, '⛏');
        const r = creep.harvest(source);
        if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, source);
        return;
    }

    if (creep.room.name !== home) {
        utils.say(creep, '🏠');
        utils.moveToRoom(creep, home);
        return;
    }

    if (utils.deliverEnergy(creep, data)) return;
    if (utils.dumpSurplus(creep, data)) return;
    // 实在没地方放：在 spawn 附近等，别乱跑
    if (data.spawns[0]) utils.moveTo(creep, data.spawns[0], { range: 2 });
}

/* ------------------------------ 占领者 ------------------------------ */

/**
 * 去相邻房间预定控制器（reserve）：GCL 1 时还占不了房，
 * 但预定能拿到房间视野、并在规则上锁住这块地不被别人先占。
 */
function reserver(creep, data) {
    const targetRoom = creep.memory.targetRoom;
    const home = creep.memory.home || creep.room.name;
    if (!targetRoom) {
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }

    if (creep.room.name !== targetRoom) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, targetRoom);
        return;
    }

    const controller = creep.room.controller;
    if (!controller) return;

    // 已经是自己的：占完就该回收（留在原地纯浪费 TTL）
    if (controller.my) {
        utils.say(creep, '✅');
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }

    if (controller.owner) {
        // 被别人占了，放弃这个目标
        utils.say(creep, '❌');
        creep.memory.targetRoom = undefined;
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }

    utils.say(creep, '🚩');
    const r = creep.reserveController(controller);
    if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, controller, { range: 1 });
    else if (r === OK) utils.recordIntel(creep.room);
    else if (r === ERR_INVALID_TARGET) {
        // 敌方预定中，留着继续观察
        utils.recordIntel(creep.room);
    }
}

/* ------------------------------ 占房者 ------------------------------ */

function claimer(creep, data) {
    const target = creep.memory.targetRoom;
    const home = creep.memory.home || creep.room.name;
    if (!target) {
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }
    if (creep.room.name !== target) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, target);
        return;
    }
    const ctrl = creep.room.controller;
    if (!ctrl) return;
    if (ctrl.my) {
        // 已经拿下了：记录情报，回家（后续交给开拓者）
        utils.recordIntel(creep.room);
        console.log('[FW] 占领成功: ' + target);
        creep.memory.targetRoom = undefined;
        utils.moveToRoom(creep, home);
        return;
    }
    if (ctrl.owner) {
        console.log('[FW] 放弃目标（已被占）: ' + target);
        creep.memory.targetRoom = undefined;
        utils.moveToRoom(creep, home);
        return;
    }
    utils.say(creep, '🚩');
    const r = creep.claimController(ctrl);
    if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, ctrl, { range: 1 });
    else if (r === OK) { console.log('[FW] 已占领 ' + target); utils.recordIntel(creep.room); }
    else if (r === ERR_GCL_NOT_ENOUGH) {
        console.log('[FW] GCL 不足，暂时占不了 ' + target);
        Memory.fw.gclBlocked = Game.time;
        creep.memory.targetRoom = undefined;
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
    }
}

/* ------------------------------ 士兵 ------------------------------ */

function soldier(creep, data) {
    // 1) 本房间有敌人：直接上
    if (data.hostiles && data.hostiles.length) {
        const target = creep.pos.findClosestByRange(data.hostiles);
        if (target) {
            utils.say(creep, '⚔');
            creep.memory.noEnemySince = undefined;
            const r = creep.attack(target);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, target);
            return;
        }
    }

    // 2) 有指定的"清场目标"（例如准备占领的房间里有敌人）：跨房间去打
    const clearRoom = Memory.fw && Memory.fw.clearTarget;
    if (clearRoom) {
        if (creep.room.name !== clearRoom) {
            utils.say(creep, '➡');
            utils.moveToRoom(creep, clearRoom);
            return;
        }
        const enemy = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (enemy) {
            utils.say(creep, '⚔');
            const r = creep.attack(enemy);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, enemy);
            return;
        }
        // 清完了
        utils.recordIntel(creep.room);
        Memory.fw.clearTarget = undefined;
    }

    // 3) 和平时期：先帮忙清路（有 WORK 就拆障），别站着发呆
    if (creep.body && creep.body.some(p => p.type === WORK)) {
        const blockers = keyNodes(creep.room);
        for (let i = 0; i < blockers.length; i++) {
            const st = firstBlocker(creep.room, blockers[i].pos, blockers[i].deep || 1);
            if (st) {
                utils.say(creep, '🚧');
                const dr = creep.dismantle(st);
                if (dr === ERR_NOT_IN_RANGE) utils.moveTo(creep, st);
                return;
            }
        }
    }

    // 4) 无事可做：留 1 个常备军，多余的回收
    const soldiers = data.creeplist.filter(c => c.memory && c.memory.role === 'soldier').length;
    creep.memory.noEnemySince = creep.memory.noEnemySince || Game.time;
    const spawn = data.spawns[0];
    if (!spawn) return;

    if (soldiers > 1 && Game.time - creep.memory.noEnemySince > 150) {
        if (creep.pos.getRangeTo(spawn) > 1) utils.moveTo(creep, spawn);
        else if (spawn.recycleCreep(creep) === OK) console.log('[FW] 回收闲置士兵 ' + creep.name);
        return;
    }
    if (creep.pos.getRangeTo(spawn) > 3) utils.moveTo(creep, spawn, { range: 3 });
}

/* ------------------------------ 道路通畅维保员 ------------------------------ */

const WALKABLE_TYPES = (function () {
    const m = {};
    m[STRUCTURE_ROAD] = true;
    m[STRUCTURE_CONTAINER] = true;
    m[STRUCTURE_RAMPART] = true;
    return m;
})();

/** 关键节点：spawn / 容器 / 控制器 / 矿源 —— 四邻必须通畅 */
function keyNodes(room) {
    const nodes = [];
    // spawn：正交四向要深查到 3 格（基地主通道，最容易被扩展堵死）
    try { for (const s of room.find(FIND_MY_SPAWNS)) nodes.push({ pos: s.pos, deep: 3 }); } catch (e) { }
    try {
        for (const s of room.find(FIND_STRUCTURES)) {
            if (s.structureType === STRUCTURE_CONTAINER) nodes.push({ pos: s.pos, deep: 1 });
        }
    } catch (e) { }
    if (room.controller) nodes.push({ pos: room.controller.pos, deep: 1 });
    try { for (const s of room.find(FIND_SOURCES)) nodes.push({ pos: s.pos, deep: 1 }); } catch (e) { }
    return nodes;
}

/**
 * 道路通畅维保员：定时巡检关键节点，四邻里只要有"可破坏的阻塞结构"就拆掉。
 * 房间边界/地形墙不可破坏 -> 不管。
 */
/**
 * 找出"必须清掉"的阻塞结构（地形感知）：
 * 沿上下左右四个方向逐格看，一旦遇到地形墙 → 该方向被山挡住，不再要求通畅，直接放弃这个方向；
 * 遇到可走结构（路/容器/rampart）→ 继续往里看；遇到不可走的建筑 → 就是它，要拆掉。
 */
function firstBlocker(room, node, deep) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const terrain = room.getTerrain();
    for (let j = 0; j < dirs.length; j++) {
        for (let step = 1; step <= deep; step++) {
            const x = node.x + dirs[j][0] * step;
            const y = node.y + dirs[j][1] * step;
            if (x < 1 || x > 48 || y < 1 || y > 48) break;
            // 山体：这个方向地形上本来就过不去，不用管
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) break;
            let found = [];
            try { found = room.lookForAt(LOOK_STRUCTURES, x, y) || []; } catch (e) { found = []; }
            if (!found.length) continue;
            const st = found[0];
            if (WALKABLE_TYPES[st.structureType]) continue;
            if (st.structureType === STRUCTURE_SPAWN) continue;
            if (st.structureType === STRUCTURE_WALL) continue;
            return st;
        }
    }
    return null;
}

function roadKeeper(creep, data) {
    const room = creep.room;
    const nodes = keyNodes(room);

    for (let i = 0; i < nodes.length; i++) {
        const st = firstBlocker(room, nodes[i].pos, nodes[i].deep || 1);
        if (st) {
            utils.say(creep, '🚧');
            const r = creep.dismantle(st);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, st);
            return;
        }
    }

    utils.say(creep, '✅');
    const sp = data.spawns && data.spawns[0];
    if (sp && creep.pos.getRangeTo(sp) > 3) utils.moveTo(creep, sp, { range: 3 });
}

/* ------------------------------ 开拓者（新房间建设） ------------------------------ */

/**
 * 开拓者：在家里的 spawn 孵化，但 memory.home 指向"待开发的新房间"。
 * 到地方后：先建 spawn 工地 -> 再把控制器升到 RCL1 -> 之后采能维持。
 */
function pioneer(creep, data) {
    const target = creep.memory.home;
    if (!target) return;
    if (creep.room.name !== target) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, target);
        return;
    }

    const sites = creep.room.find(FIND_CONSTRUCTION_SITES);
    if (sites.length) {
        if (utils.isWorking(creep)) {
            if (utils.buildSomething(creep, data)) return;
        }
        // 没能量：就近采/取
        if (utils.withdrawEnergy(creep, data)) return;
        utils.harvestSource(creep, data);
        return;
    }

    const ctrl = creep.room.controller;
    if (ctrl && ctrl.my && ctrl.level < 1) {
        if (utils.isWorking(creep)) {
            utils.say(creep, '⚡');
            if (ctrl && creep.upgradeController(ctrl) === ERR_NOT_IN_RANGE) utils.moveTo(creep, ctrl, { range: 3 });
            return;
        }
        if (utils.withdrawEnergy(creep, data)) return;
        utils.harvestSource(creep, data);
        return;
    }

    // spawn 已经起来了：就地当普通工人
    if (!utils.isWorking(creep)) {
        if (utils.withdrawEnergy(creep, data)) return;
        utils.harvestSource(creep, data);
        return;
    }
    if (utils.buildSomething(creep, data)) return;
    if (utils.deliverEnergy(creep, data)) return;
    utils.upgradeController(creep, creep.room);
}

/* ------------------------------ 侦察兵（敌区情报） ------------------------------ */

/**
 * 侦察兵：专门去"可能有敌人/别人的房间"拿情报。
 * 原则只有一条：信息到手立刻走人——进入房间当 tick 就记录情报，最多停 reconStayTicks 就转向下一个目标。
 */
function recon(creep, data) {
    const home = creep.memory.home || creep.room.name;
    const stay = config.reconStayTicks;

    // 到了目标房间：记录情报 -> 立刻离开
    const target = creep.memory.reconTarget;
    if (target && creep.room.name === target) {
        utils.recordIntel(creep.room);
        creep.memory.reconTarget = undefined;
        creep.memory.reconSince = Game.time;
        utils.say(creep, '🔍');
        // 立刻往房间外侧/老家方向撤
        creep.memory.reconBack = true;
        return;
    }

    // 撤离中：先离开这个房间（回老家或去下一个目标）
    if (creep.memory.reconBack) {
        const next = pickReconTarget(home);
        if (next && next !== creep.room.name) {
            creep.memory.reconBack = undefined;
            creep.memory.reconTarget = next;
            utils.say(creep, '➡');
            utils.moveToRoom(creep, next);
            return;
        }
        if (creep.room.name !== home) {
            utils.say(creep, '🏠');
            utils.moveToRoom(creep, home);
            creep.memory.reconBack = undefined;
            return;
        }
        creep.memory.reconBack = undefined;
        creep.memory.reconTarget = undefined;
        utils.say(creep, '💤');
        return;
    }

    const next = pickReconTarget(home);
    if (!next) {
        // 没有值得侦察的目标：回老家待命
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        else utils.say(creep, '💤');
        return;
    }
    creep.memory.reconTarget = next;
    utils.say(creep, '➡');
    utils.moveToRoom(creep, next);
}

/**
 * 侦察目标：相邻房间里"情报过期 + 危险/有主"的那些（纯 scout 只管无主房间，recon 专啃硬骨头）
 */
function pickReconTarget(homeName) {
    if (!homeName) return null;
    let exits = {};
    try {
        exits = Game.map.describeExits(homeName) || {};
    } catch (e) {
        return null;
    }
    let best = null;
    for (const dir in exits) {
        const name = exits[dir];
        if (!name || name === homeName) continue;
        const info = utils.getIntel(name);
        const age = info ? (Game.time - info.t) : 9999999;
        if (age < config.reconStaleTicks) continue;
        // 危险房间优先（有主 / 见过敌人），这样才值得派侦察兵
        let score = age / 1000;
        if (info) {
            if (info.controller && info.controller.owner) score += 5;
            if (info.hostiles > 0) score += 5;
        }
        if (!best || score > best.score) best = { name: name, score: score };
    }
    return best ? best.name : null;
}

/* ------------------------------ 边防巡逻队 ------------------------------ */

function attackParts(creep) {
    let n = 0;
    for (const p of creep.body) {
        if (p.type === ATTACK) n++;
        else if (p.type === RANGED_ATTACK) n += 2;
    }
    return n;
}

/**
 * 巡逻路线：相邻房间，优先"无主 + 矿源多"的（那些是我们准备占的地盘）
 */
function patrolRoute(home) {
    if (!Memory.fw) Memory.fw = {};
    const cached = Memory.fw.patrolRoute;
    if (cached && Game.time - cached.t < 500 && cached.rooms && cached.rooms.length && cached.home === home) {
        return cached.rooms;
    }
    let exits = {};
    try {
        exits = Game.map.describeExits(home) || {};
    } catch (e) {
        exits = {};
    }
    const rooms = [];
    for (const dir in exits) {
        const name = exits[dir];
        if (!name || name === home) continue;
        const info = utils.getIntel(name);
        let score = 0;
        if (info) {
            if (info.controller && !info.controller.owner) score += 10;
            score += Math.min(6, (info.sources || []).length * 3);
            if (info.hostiles > 0) score += 5;   // 有敌人的更要去看看
        }
        rooms.push({ name: name, score: score });
    }
    rooms.sort((a, b) => b.score - a.score);
    const list = rooms.slice(0, config.patrolRooms).map(r => r.name);
    Memory.fw.patrolRoute = { t: Game.time, home: home, rooms: list };
    return list;
}

/**
 * 边防巡逻兵：
 *  - 老家有敌人 -> 立刻回防
 *  - 所在房间有敌人 -> 评估战力后交战（打不过就撤）
 *  - 血量低 -> 回老家塔下治疗
 *  - 否则按路线逐房间巡逻，每间驻留 patrolStayTicks 扫荡
 */
function patroller(creep, data) {
    const home = creep.memory.home || creep.room.name;
    const hostiles = data.hostiles || [];

    // 1) 老家被袭：优先回防
    const homeHostiles = (creep.room.name === home) ? hostiles : [];
    if (creep.room.name !== home) {
        const homeInfo = null;
        // 用 Memory 里记录的"老家有敌人"信号（由 soldier / defense 写入）
        if (Memory.fw && Memory.fw.homeUnderAttack && Memory.fw.homeUnderAttack === home) {
            utils.say(creep, '🏠');
            utils.moveToRoom(creep, home);
            return;
        }
    }

    // 2) 血量不健康：回老家塔下补血
    if (creep.hits < creep.hitsMax * config.patrolHealRatio) {
        utils.say(creep, '🩹');
        if (creep.room.name !== home) {
            utils.moveToRoom(creep, home);
        } else if (data.spawns[0]) {
            utils.moveTo(creep, data.spawns[0], { range: 3 });
        }
        return;
    }

    // 3) 当前房间有敌人：打
    if (hostiles.length) {
        let target = null;
        let bestDist = 999;
        for (const h of hostiles) {
            const d = creep.pos.getRangeTo(h);
            if (d < bestDist) { bestDist = d; target = h; }
        }
        if (target) {
            const mine = attackParts(creep);
            const theirs = attackParts(target);
            // 打不过（对方火力是我们的 2 倍以上）就撤回老家，别送
            if (theirs > mine * 2 + 1) {
                utils.say(creep, '🏃');
                if (creep.room.name !== home) utils.moveToRoom(creep, home);
                else if (data.spawns[0]) utils.moveTo(creep, data.spawns[0], { range: 3 });
                if (Memory.fw) Memory.fw.threatSeen = Game.time;
                return;
            }
            utils.say(creep, '⚔');
            const r = creep.attack(target);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, target);
            if (Memory.fw) Memory.fw.threatSeen = Game.time;
            return;
        }
    }

    let route = patrolRoute(home);
    // 分扇区：每个巡逻兵只负责自己那几段边境，保证同一时刻边境有一半以上房间有人
    if (route.length > 1) {
        const squad = Math.max(1, Math.min(route.length, Memory.fw && Memory.fw.patrolSquad || 2));
        const sector = (creep.memory.sector || 0) % squad;
        const mine = route.filter((r, i) => i % squad === sector);
        if (mine.length) route = mine;
    }
    if (!route.length) {
        // 没有相邻房间可巡逻：在老家门口待命
        if (data.spawns[0] && creep.pos.getRangeTo(data.spawns[0]) > 3) {
            utils.moveTo(creep, data.spawns[0], { range: 3 });
        }
        return;
    }

    // 4) 巡逻推进
    const idx = creep.memory.patrolIndex === undefined ? 0 : creep.memory.patrolIndex;
    const targetRoom = route[idx % route.length];

    if (creep.room.name !== targetRoom) {
        // 路上顺手清掉当前房间的敌人（上面已处理）；没敌人就去目标房间
        utils.say(creep, '➡');
        utils.moveToRoom(creep, targetRoom);
        if (creep.memory.patrolEntered !== creep.room.name) {
            creep.memory.patrolEntered = creep.room.name;
            creep.memory.patrolSince = Game.time;
        }
        return;
    }

    // 已在目标房间：驻留扫荡
    creep.memory.patrolSince = creep.memory.patrolSince || Game.time;
    if (Game.time - creep.memory.patrolSince < config.patrolStayTicks) {
        utils.say(creep, '👁');
        // 往房间中心/另一侧走，扩大视野
        const cx = 25, cy = 25;
        if (creep.pos.getRangeTo(new RoomPosition(cx, cy, creep.room.name)) > 5) {
            try { creep.moveTo(new RoomPosition(cx, cy, creep.room.name), { reusePath: 10 }); } catch (e) { }
        }
        return;
    }

    // 驻留结束：去下一个房间
    creep.memory.patrolIndex = (idx + 1) % route.length;
    creep.memory.patrolSince = Game.time;
    creep.memory.patrolEntered = undefined;
    utils.moveToRoom(creep, route[creep.memory.patrolIndex]);
}

/* ------------------------------ 侦查兵 ------------------------------ */

/**
 * 挑一个"情报缺失/过期"的相邻房间。
 * 返回房间名，全部都很新时返回 null。
 */
function pickScoutTarget(homeName) {
    if (!homeName) return null;
    let exits;
    try {
        exits = Game.map.describeExits(homeName) || {};
    } catch (e) {
        return null;
    }
    let best = null;
    for (const dir in exits) {
        const name = exits[dir];
        if (!name || name === homeName) continue;
        const info = utils.getIntel(name);
        const age = info ? (Game.time - info.t) : 9999999;
        if (age < config.intelStaleTicks) continue;
        if (!best || age > best.age) best = { name: name, age: age };
    }
    return best ? best.name : null;
}

function scout(creep, data) {
    const home = creep.memory.home || creep.room.name;

    // 人在外地：顺手刷新当前房间情报
    if (creep.room.name !== home) {
        const info = utils.getIntel(creep.room.name);
        if (!info || Game.time - info.t > 200) utils.recordIntel(creep.room);
    }

    let target = creep.memory.scoutTarget;

    // 到达目标：记录情报
    if (target && creep.room.name === target) {
        utils.recordIntel(creep.room);
        creep.memory.scoutTarget = undefined;
        target = undefined;
        utils.say(creep, '🔍');
    }

    if (!target) target = pickScoutTarget(home);

    if (!target) {
        // 情报都很新：回老家待命；待太久就回收（名额让给经济单位）
        if (creep.room.name !== home) {
            utils.say(creep, '🏠');
            creep.memory.idleSince = undefined;
            utils.moveToRoom(creep, home);
            return;
        }
        utils.say(creep, '💤');
        creep.memory.idleSince = creep.memory.idleSince || Game.time;
        if (Game.time - creep.memory.idleSince > 250) {
            const spawn = data.spawns[0];
            if (spawn) {
                if (creep.pos.getRangeTo(spawn) > 1) utils.moveTo(creep, spawn);
                else if (spawn.recycleCreep(creep) === OK) console.log('[FW] 回收闲置侦查兵 ' + creep.name);
            }
        }
        return;
    }
    creep.memory.idleSince = undefined;

    creep.memory.scoutTarget = target;
    if (creep.room.name !== target) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, target);
    }
}

/* ------------------------------ 分发 ------------------------------ */

const BEHAVIORS = {
    soldier: soldier,
    patroller: patroller,
    scout: scout,
    recon: recon,
    pioneer: pioneer,
    roadKeeper: roadKeeper,
    claimer: claimer,
    reserver: reserver,
    harvester: harvester,
    remoteHarvester: remoteHarvester,
    miner: miner,
    hauler: hauler,
    builder: builder,
    upgrader: upgrader,
};

function bumpDemolish(creep) {
    creep.memory.demolishTicks = (creep.memory.demolishTicks || 0) + 1;
    if (creep.memory.demolishTicks > 400) { creep.memory.demolish = undefined; creep.memory.demolishTicks = 0; }
}

function run(creep) {
    if (creep.spawning) return;

    // 拆障（抢险用）：memory.demolish = {x,y}，拆掉那格结构，腾出路
    if (creep.memory && creep.memory.demolish) {
        const d = creep.memory.demolish;
        let target = null;
        const found = creep.room.lookForAt(LOOK_STRUCTURES, d.x, d.y);
        if (found && found.length) target = found[0];
        if (!target) { creep.memory.demolish = undefined; return; }
        utils.say(creep, '🔨');
        const r = creep.dismantle(target);
        if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, target);
        else if (r === OK) bumpDemolish(creep);
        return;
    }

    // 待回收：回 spawn 换能量，把名额让给紧缺岗位
    if (creep.memory && creep.memory.recycle) {
        const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS) || Game.spawns[Object.keys(Game.spawns)[0]];
        if (!spawn) { creep.memory.recycle = undefined; return; }
        if (creep.pos.getRangeTo(spawn) <= 1) {
            const r = spawn.recycleCreep(creep);
            if (r === OK) console.log('[FW] 已回收 ' + creep.name);
            else if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, spawn);
            return;
        }
        utils.moveTo(creep, spawn);
        return;
    }

    if (!creep.memory) creep.memory = {};
    if (!creep.memory.role || !BEHAVIORS[creep.memory.role]) {
        creep.memory.role = utils.inferRole(creep);
    }

    const data = utils.roomData(creep.room);
    const fn = BEHAVIORS[creep.memory.role] || harvester;
    fn(creep, data);
}

module.exports = { run, pickScoutTarget, pickReconTarget, patrolRoute };

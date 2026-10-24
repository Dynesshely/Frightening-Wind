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
        // 优先吃控制器旁边容器里的能量（搬运工会往里倒），其次矿源侧容器，最后自己采
        const near = utils.nearestEnergyStore(creep, data, 50, false);
        if (near && creep.pos.getRangeTo(near) <= 8) {
            utils.transferFrom(creep, near);
            return;
        }
        if (pickupLoose(creep, data)) return;
        // spawn 已满 = 暂时不需要造兵，里面的能量闲着也是闲着，搬去升级
        const spare = utils.spawnSurplus(creep, data);
        if (spare) return;
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

    // 3) 和平时期：留 1 个常备军，多余的回收，避免白吃能量
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

    const route = patrolRoute(home);
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
    reserver: reserver,
    harvester: harvester,
    remoteHarvester: remoteHarvester,
    miner: miner,
    hauler: hauler,
    builder: builder,
    upgrader: upgrader,
};

function run(creep) {
    if (creep.spawning) return;

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

module.exports = { run, pickScoutTarget, patrolRoute };

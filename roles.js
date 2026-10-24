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

    // 满了：优先倒进矿源旁的容器
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
        if (utils.buildSomething(creep, data)) return;
        utils.upgradeController(creep, data.room);
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

/* ------------------------------ 防御者 ------------------------------ */

function defender(creep, data) {
    if (!data.hostiles || !data.hostiles.length) {
        // 没敌人：常备军保留 1 个，其余在 spawn 附近待命一段时间后回收
        const defenders = data.creeplist.filter(c => c.memory && c.memory.role === 'defender').length;
        creep.memory.noEnemySince = creep.memory.noEnemySince || Game.time;
        if (defenders > 1 && Game.time - creep.memory.noEnemySince > 150) {
            const spawn = data.spawns[0];
            if (spawn) {
                if (creep.pos.getRangeTo(spawn) > 1) {
                    utils.moveTo(creep, spawn);
                } else {
                    const r = spawn.recycleCreep(creep);
                    if (r === OK) console.log('[FW] 回收闲置防御者 ' + creep.name);
                }
            }
        } else {
            const spawn = data.spawns[0];
            if (spawn && creep.pos.getRangeTo(spawn) > 3) utils.moveTo(creep, spawn, { range: 3 });
        }
        return;
    }

    creep.memory.noEnemySince = undefined;
    const target = creep.pos.findClosestByRange(data.hostiles);
    if (!target) return;
    utils.say(creep, '⚔');
    const r = creep.attack(target);
    if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, target);
}

/* ------------------------------ 分发 ------------------------------ */

const BEHAVIORS = {
    defender: defender,
    harvester: harvester,
    miner: miner,
    hauler: hauler,
    builder: builder,
    upgrader: upgrader,
};

function run(creep) {
    if (creep.spawning) return;

    if (!creep.memory) creep.memory = {};
    if (!creep.memory.role || !BEHAVIORS[creep.memory.role]) {
        creep.memory.role = utils.inferRole(creep);
    }

    const data = utils.roomData(creep.room);
    const fn = BEHAVIORS[creep.memory.role] || harvester;
    fn(creep, data);
}

module.exports = { run };

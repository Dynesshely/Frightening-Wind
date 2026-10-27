/**
 * role.upgrader —— 升级者（把能量变成控制器进度）
 *
 * 本模块负责：
 *   - 空包时的补给顺序：就近容器/仓储 → 顺手捡漏 → spawn 闲置能量 →
 *     控制器旁容器原地等搬运工送货 → 实在没有补给点才自己去采；
 *   - 满载时直接升级；控制器不可用（无视野/不归我）才退回交付与建造。
 *
 * 为什么"控制器旁有容器就原地等"：跑 20+ 格去矿源自采，往返一次只升级 50 点，血亏。
 *
 * 不该放进来：控制器的升级速率/等级策略（economy / quota 侧），
 * 建造者职责（role.builder），跨房间升级（role.pioneer）。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');
// pickupLoose 是"顺手捡漏"的公共小工具，放在 role.harvester 里统一维护。
const harvesterMod = require('role.harvester');

/**
 * 升级者的合法货源：只认 storage 与"控制器 3 格内的容器"。
 *
 * 为什么不能就近取任意容器：矿源旁的容器是搬运工的转运站。
 * 旧实现用阈值 50 就近取，而搬运工要攒到 100 才动 —— 升级者总先一步把货抽干，
 * 运输队永远等不到整车（优先级倒挂，见 docs/OPTIMIZATION.md F3）。
 */
function pickUpgradeSupply(creep, data) {
    // 1) storage：量大、本来就是为了沉淀能量而建
    if (data.storage && utils.usedEnergy(data.storage) > 300) {
        utils.transferFrom(creep, data.storage);
        return true;
    }

    // 2) 控制器 3 格内的容器：专门喂升级者的"就近续杯点"
    const controller = data.room.controller;
    let best = null;
    let bestDist = 999;
    if (controller) {
        for (const c of data.containers) {
            if (c.pos.getRangeTo(controller) > 3) continue;
            if (utils.usedEnergy(c) < 50) continue;
            const d = creep.pos.getRangeTo(c);
            if (d < bestDist) { bestDist = d; best = c; }
        }
        if (best) { utils.transferFrom(creep, best); return true; }
    }

    // 3) 兜底：控制器旁还没有容器时，可以从任意容器取，但**按"总路程"挑**而不是"离自己近"。
    //    真正付出去的是"走到容器 + 从容器走回控制器"这一段，离自己近不代表划算。
    //    （本地推演实测：容器在离控制器 8~12 格处，升级者每趟只升 50 点，效率掉到 5%）
    for (const c of data.containers) {
        if (utils.usedEnergy(c) < 30) continue;
        const toCtrl = controller ? c.pos.getRangeTo(controller) : 0;
        const score = creep.pos.getRangeTo(c) + toCtrl * 1.5;
        if (score < bestDist) { bestDist = score; best = c; }
    }
    if (best) { utils.transferFrom(creep, best); return true; }

    // 4) 最后兜底：spawn/扩展里囤了很多（说明孵化和升级抢同一笔钱），
    //    取一点出来升级，避免"spawn 满着、控制器却在掉级"。
    let spawnStored = 0;
    for (const s of data.spawns) spawnStored += utils.usedEnergy(s);
    if (spawnStored >= 300 && data.spawns.length) {
        utils.transferFrom(creep, data.spawns[0]);
        return true;
    }
    return false;
}

function upgrader(creep, data) {
    if (!utils.isWorking(creep)) {
        // 1) 只从"合法货源"取（storage / 控制器旁容器），不碰矿源旁的转运容器
        if (pickUpgradeSupply(creep, data)) return;
        // 注意：这里不能用 pickupLoose —— 它内部是 withdrawEnergy，会在"容器比矿源远"时
        // 直接转去 harvestSource，把升级者变成矿工（线上实测两个升级者跑去抢矿位）。
        const loose = utils.nearestLooseEnergy(creep, data);
        if (loose && creep.pos.getRangeTo(loose) <= 6) {
            if (utils.transferFrom(creep, loose)) return;
        }
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

        // 4) 完全没有补给点：在控制器旁待命。
        //    坚决不去采矿源 —— 实测两个升级者跑到 (43,28)/(43,29) 和矿工抢同一条矿脉，
        //    升级者只有 1 个 WORK（采 2 e/tick），抢走的是矿工的站位，净损失。
        if (controller) {
            utils.say(creep, '💤');
            if (creep.pos.getRangeTo(controller) > 3) utils.moveTo(creep, controller, { range: 3 });
            return;
        }
        utils.harvestSource(creep, data);
        return;
    }
    // 满载：升级就是它的工作，直接升级（别再走回去把能量倒给 spawn）
    if (utils.upgradeController(creep, data.room)) return;
    // 控制器不可用（没视野/不是我的）才退回补给与建造
    if (utils.deliverEnergy(creep, data)) return;
    utils.buildSomething(creep, data);
}

module.exports = {
    upgrader,
    pickUpgradeSupply,
};

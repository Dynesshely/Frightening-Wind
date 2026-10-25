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

function upgrader(creep, data) {
    if (!utils.isWorking(creep)) {
        // 1) 就近有存量的容器/仓储 -> 取
        const near = utils.nearestEnergyStore(creep, data, 50, false);
        if (near && creep.pos.getRangeTo(near) <= 8) {
            utils.transferFrom(creep, near);
            return;
        }
        if (harvesterMod.pickupLoose(creep, data)) return;
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

module.exports = {
    upgrader,
};

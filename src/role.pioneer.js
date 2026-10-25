/**
 * role.pioneer —— 开拓者（新占房间建设）
 *
 * 本模块负责：从老家 spawn 孵化、memory.home 指向"待开发的新房间"的单位如何建设：
 * 到场先建 spawn 工地 → 把控制器升到 RCL1 → 之后就地当普通工人（建造 / 送能 / 升级）。
 *
 * 不该放进来：作战与护航（role.soldier）、巡逻与清障（role.patrol）、
 * 情报侦察（role.scout / role.recon）。能量获取、搬运、建造、升级等通用动作
 * 全部复用 utils 的现成函数，不要在这里另写一套。
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');

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

module.exports = {
    pioneer: pioneer,
};

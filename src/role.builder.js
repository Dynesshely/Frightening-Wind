/**
 * role.builder —— 建造者（工地建造 + 结构维修）
 *
 * 本模块负责：
 *   - 空包时先顺手捡漏（复用 role.harvester 的 pickupLoose），捡不到再自己去采矿源；
 *   - 满载时按 建造工地 → 维修受损结构 → 交付 spawn/扩展/塔 → 自己升级 的顺序做事。
 *
 * 不该放进来：工地的优先级与选址（construction.js / fw.build），
 * 升级者的"控制器旁等货"策略（role.upgrader），跨房间建设（role.pioneer）。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');
// pickupLoose 是"顺手捡漏"的公共小工具，放在 role.harvester 里统一维护。
const harvesterMod = require('role.harvester');

function builder(creep, data) {
    if (!utils.isWorking(creep)) {
        if (harvesterMod.pickupLoose(creep, data)) return;
        utils.harvestSource(creep, data);
        return;
    }

    if (utils.buildSomething(creep, data)) return;
    if (utils.repairSomething(creep, data)) return;
    if (utils.deliverEnergy(creep, data)) return;
    utils.upgradeController(creep, data.room);
}

module.exports = {
    builder,
};

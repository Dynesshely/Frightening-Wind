/**
 * role.harvester —— 通用采集者（自采自送） + "顺手捡漏"小工具
 *
 * 本模块负责：
 *   harvester    空包时先捡 4 格内的掉落物/墓碑，捡不到再去采矿源；
 *                满载时按 spawn/扩展/塔 → 身边工地 → 控制器旁容器 → 自己升级 的顺序交付。
 *   pickupLoose  通用"顺手捡一点散落能量"，建造者（role.builder）与升级者
 *                （role.upgrader）也复用它，所以由本模块导出，避免各写一份。
 *
 * 不该放进来：站定挖矿（role.miner）、跨房间采集与接驳（role.remote）、
 * 周边整理与拆障（role.tidy）；能量调度的算法本身在 fw.store，本文件只调用 utils.* 门面。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');

/* ------------------------------ 通用小工具 ------------------------------ */

/**
 * 顺手捡漏：从最近的掉落物 / 墓碑 / 就近容器取一点能量（实现见 fw.store）。
 * 刻意保持成一行委托：真正的取货优先级在 utils.withdrawEnergy 里，不在角色层。
 */
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

module.exports = {
    harvester,
    pickupLoose,
};

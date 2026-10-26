/**
 * role.hauler —— 本地搬运工（容器/仓储 → spawn/扩展/塔）
 *
 * 本模块负责：
 *   - 空包时去最近的容器/仓储取货（跳过控制器旁容器：那是升级者的口粮）；
 *   - 满载时先交付 spawn/扩展/塔，没有缺口就倒给控制器旁容器 / 自己升级；
 *   - 没货可搬时回老家待命，绝不在矿区原地堵路（线上踩过：3 个搬运工把矿源通道堵死）。
 *
 * 不该放进来：跨房间接驳（role.remote 的 remoteHauler）、取货/交付的选点算法
 * （在 fw.store，本文件只调用 utils.* 门面）。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');

/**
 * 从容器/仓储把能量搬到 spawn/扩展/塔；没有缺口就倒给控制器旁容器或自己升级。
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

    // 取货前先看有没有白捡的（掉落物 / 墓碑 / 废墟）：
    // 搬运工原来是全库唯一不碰散落能量的角色，阵亡单位的遗产全靠采集者顺路，
    // 而采集者又只在空手时才会弯腰 —— 实际上大部分墓碑是被浪费掉的。
    const loose = utils.nearestLooseEnergy(creep, data);
    if (loose && creep.pos.getRangeTo(loose) <= 8) {
        utils.transferFrom(creep, loose);
        return;
    }

    // 取货阈值跟着自身运力走：低于"半车"才不值得跑。
    // 旧值固定 100，而实测容器均值只有 75 —— 运输队大部分时间在等一整车，
    // 这是 53% 空手率的主因（docs/OPTIMIZATION.md F2）。
    const threshold = Math.max(30, Math.floor(capacity * 0.4));
    const store = utils.nearestEnergyStore(creep, data, threshold, true);
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
    // 没货可搬：守在最近的转运容器旁等货，别跑回老家。
    // 老家到远端容器一来一回 40+ tick，纯浪费时间——货就出在容器里，守着才接得到。
    utils.say(creep, '💤');
    const stash = utils.nearestEnergyStore(creep, data, 0, false);
    const waitSpot = stash || data.storage || data.spawns[0];
    if (waitSpot && creep.pos.getRangeTo(waitSpot) > 2) utils.moveTo(creep, waitSpot, { range: 2 });
}

module.exports = {
    hauler,
};

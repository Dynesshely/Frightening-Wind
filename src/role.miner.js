/**
 * role.miner —— 静态矿工（站在矿源旁的专属站位格上一直挖）
 *
 * 本模块负责：
 *   - 按 memory.sourceId 认领矿源，站到 utils.ensureSlot 分配的专属站位（同源矿工各站一格）；
 *   - 挖满后优先倒给矿源旁的 link（瞬时传送），其次矿源旁的容器；
 *   - 容器/站位都不可用时退化：送 spawn/扩展 → 自己升级（绝不原地发呆）。
 *
 * 不该放进来：通用自采自送（role.harvester）、跨房间采集（role.remote）、
 * 站位分配算法本身（在 fw.slot，本文件只通过 utils.ensureSlot 调用）。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');

/**
 * 站在矿源/容器上一直挖，满了就倒进旁边的容器。
 * 容器没空间或丢失时退化为：送到 spawn/扩展 → 升级。
 */
function miner(creep, data) {
    let source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
    if (source && source.pos.roomName !== creep.room.name) source = null;   // 源不在本房：回退重选
    if (!source) {
        // 矿源丢了：退回通用采集逻辑
        if (utils.freeCap(creep) > 0) { utils.harvestSource(creep, data); return; }
        if (utils.deliverEnergy(creep, data)) return;
        utils.upgradeController(creep, data.room);
        return;
    }

    if (!utils.isWorking(creep)) {
        utils.say(creep, '⛏');
        // 站到自己的专属站位格上，再采集（同一矿源的矿工各站一格，不排队）
        const slot = utils.ensureSlot(creep, source);
        if (!slot) {
            // 该矿源的站位已经满了：**绝不能回退成自由采集**。
            // 线上事故：抢不到槽位的矿工挤到矿源旁边，把占位矿工挤走，双方来回抖动，
            // 整条采集链直接崩掉（容器长期 0，搬运工全部待命）。
            // 正确做法是让它去干搬运/交付，等多余的人口自然淘汰。
            if (utils.deliverEnergy(creep, data)) return;
            if (utils.dumpSurplus(creep, data)) return;
            utils.upgradeController(creep, data.room);
            return;
        }
        if (slot) {
            const rp = new RoomPosition(slot.x, slot.y, creep.room.name);
            if (creep.pos.getRangeTo(rp) > 0) {
                utils.moveTo(creep, rp);
                if (creep.pos.getRangeTo(source.pos) > 1) return;
            }
        }
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

module.exports = {
    miner,
};

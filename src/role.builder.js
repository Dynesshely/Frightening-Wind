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

/**
 * 紧急维修目标：血量已经掉到危险线以下的核心结构。
 *
 * 为什么必须排在建造之前：container 是 250,000 hits，有主房间每 500 tick 掉 5,000
 * （= 10 hits/tick），不修的话 25,000 tick 就**直接消失**。
 * 线上/本地推演都踩过同一个坑：只要还有工地，建造者就永远在建造，
 * 容器一路掉到 0 → 采集链断 → 再造一个新的 → 无限循环。
 * 这不是"维护成本高"，是**资产在消失**（modeling D2/D3 的实装版本）。
 */
function urgentRepairTarget(creep, data) {
    let best = null;
    let bestRatio = 1;
    for (const s of (data.structures || [])) {
        if (!s || !s.hits || !s.hitsMax) continue;
        const t = s.structureType;
        // 只保核心物流/防御结构；墙和 rampart 是另一套策略，交给塔/专门逻辑
        if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_ROAD && t !== STRUCTURE_TOWER) continue;
        const ratio = s.hits / s.hitsMax;
        if (ratio > 0.4) continue;
        if (ratio < bestRatio) { bestRatio = ratio; best = s; }
    }
    return best;
}

function builder(creep, data) {
    if (!utils.isWorking(creep)) {
        if (harvesterMod.pickupLoose(creep, data)) return;
        utils.harvestSource(creep, data);
        return;
    }

    // 1) 先救火：核心结构快坏了就修，别管工地
    const urgent = urgentRepairTarget(creep, data);
    if (urgent) {
        const r = creep.repair(urgent);
        if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, urgent);
        else if (r === OK) utils.say(creep, '🔧');
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

/**
 * role.recon —— 侦察兵（进危险 / 有主房间做短期侦察）
 *
 * 本模块负责：
 *   - pickReconTarget()：相邻房间里"情报过期 + 危险 / 有主"的打分挑目标（专啃硬骨头）；
 *   - recon()：进房当 tick 记录情报立刻撤离，撤离途中顺便挑下一个目标。
 *
 * 与 role.scout 的分工：scout 只按情报新鲜度扫无主房间；recon 才进"可能有敌人"的房间，
 * 所以目标挑选规则不同（recon 会把有主 / 见过敌人加分），因此不合并。
 *
 * 不该放进来：巡逻与清障（role.patrol）、作战（role.soldier）、新房间建设（role.pioneer）。
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const config = require('config');
const utils = require('utils');

/**
 * 侦察兵：专门去"可能有敌人/别人的房间"拿情报。
 * 原则只有一条：信息到手立刻走人——进入房间当 tick 就记录情报，最多停 reconStayTicks 就转向下一个目标。
 */
function recon(creep, data) {
    const home = creep.memory.home || creep.room.name;
    const stay = config.reconStayTicks;

    // 到了目标房间：记录情报 -> 立刻离开
    const target = creep.memory.reconTarget;
    if (target && creep.room.name === target) {
        utils.recordIntel(creep.room);
        creep.memory.reconTarget = undefined;
        creep.memory.reconSince = Game.time;
        utils.say(creep, '🔍');
        // 立刻往房间外侧/老家方向撤
        creep.memory.reconBack = true;
        return;
    }

    // 撤离中：先离开这个房间（回老家或去下一个目标）
    if (creep.memory.reconBack) {
        const next = pickReconTarget(home);
        if (next && next !== creep.room.name) {
            creep.memory.reconBack = undefined;
            creep.memory.reconTarget = next;
            utils.say(creep, '➡');
            utils.moveToRoom(creep, next);
            return;
        }
        if (creep.room.name !== home) {
            utils.say(creep, '🏠');
            utils.moveToRoom(creep, home);
            creep.memory.reconBack = undefined;
            return;
        }
        creep.memory.reconBack = undefined;
        creep.memory.reconTarget = undefined;
        utils.say(creep, '💤');
        return;
    }

    const next = pickReconTarget(home);
    if (!next) {
        // 没有值得侦察的目标：回老家待命
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        else utils.say(creep, '💤');
        return;
    }
    creep.memory.reconTarget = next;
    utils.say(creep, '➡');
    utils.moveToRoom(creep, next);
}

/**
 * 侦察目标：相邻房间里"情报过期 + 危险/有主"的那些（纯 scout 只管无主房间，recon 专啃硬骨头）
 */
function pickReconTarget(homeName) {
    if (!homeName) return null;
    let exits = {};
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
        if (age < config.reconStaleTicks) continue;
        // 危险房间优先（有主 / 见过敌人），这样才值得派侦察兵
        let score = age / 1000;
        if (info) {
            if (info.controller && info.controller.owner) score += 5;
            if (info.hostiles > 0) score += 5;
        }
        if (!best || score > best.score) best = { name: name, score: score };
    }
    return best ? best.name : null;
}

module.exports = {
    pickReconTarget: pickReconTarget,
    recon: recon,
};

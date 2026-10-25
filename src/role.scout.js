/**
 * role.scout —— 侦查兵（去无主 / 情报缺失的相邻房间拿情报）
 *
 * 本模块负责：
 *   - pickScoutTarget()：挑一个情报过期最久的相邻房间（只看"情报新鲜度"）；
 *   - scout()：到目标房间当 tick 记录情报，情报都新了就回老家待命，闲置太久自动回收。
 *
 * 不该放进来：危险 / 有主房间的硬骨头侦察（role.recon，那边按危险度打分）、
 * 巡逻与清障（role.patrol）、作战（role.soldier）、新房间建设（role.pioneer）。
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const config = require('config');
const utils = require('utils');

/**
 * 挑一个"情报缺失/过期"的相邻房间。
 * 返回房间名，全部都很新时返回 null。
 */
function pickScoutTarget(homeName) {
    if (!homeName) return null;
    let exits;
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
        if (age < config.intelStaleTicks) continue;
        if (!best || age > best.age) best = { name: name, age: age };
    }
    return best ? best.name : null;
}

function scout(creep, data) {
    const home = creep.memory.home || creep.room.name;

    // 人在外地：顺手刷新当前房间情报
    if (creep.room.name !== home) {
        const info = utils.getIntel(creep.room.name);
        if (!info || Game.time - info.t > 200) utils.recordIntel(creep.room);
    }

    let target = creep.memory.scoutTarget;

    // 到达目标：记录情报
    if (target && creep.room.name === target) {
        utils.recordIntel(creep.room);
        creep.memory.scoutTarget = undefined;
        target = undefined;
        utils.say(creep, '🔍');
    }

    if (!target) target = pickScoutTarget(home);

    if (!target) {
        // 情报都很新：回老家待命；待太久就回收（名额让给经济单位）
        if (creep.room.name !== home) {
            utils.say(creep, '🏠');
            creep.memory.idleSince = undefined;
            utils.moveToRoom(creep, home);
            return;
        }
        utils.say(creep, '💤');
        creep.memory.idleSince = creep.memory.idleSince || Game.time;
        if (Game.time - creep.memory.idleSince > 250) {
            const spawn = data.spawns[0];
            if (spawn) {
                if (creep.pos.getRangeTo(spawn) > 1) utils.moveTo(creep, spawn);
                else if (spawn.recycleCreep(creep) === OK) console.log('[FW] 回收闲置侦查兵 ' + creep.name);
            }
        }
        return;
    }
    creep.memory.idleSince = undefined;

    creep.memory.scoutTarget = target;
    if (creep.room.name !== target) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, target);
    }
}

module.exports = {
    pickScoutTarget: pickScoutTarget,
    scout: scout,
};

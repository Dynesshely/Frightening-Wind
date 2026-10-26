/**
 * fw.build —— 建造、维修、升级（把能量换成进度）。
 *
 * 负责：
 *   - sitePriority：工地优先级评分（矿源旁容器最优先，控制器缓冲靠后）；
 *   - buildSomething / buildNearby：在给定工地列表里挑一个并执行；
 *   - repairSomething：按血量比例挑维修目标（wall/rampart 不修）；
 *   - upgradeController：升级控制器。
 *
 * 不该放进来：
 *   - "该不该建 / 建什么"的规划（construction）与配额（quota）；
 *   - 能量获取与交付（fw.store）—— 本模块只消费 creep 身上已有的能量；
 *   - 位移策略：只调用 fw.nav 的 moveTo，绝不直接写 creep.moveTo / creep.move。
 *
 * 依赖：config（维修阈值）、fw.log（计数 + 说话）、fw.nav（唯一移动入口）。
 * 不依赖 utils（避免循环 require）。
 */
const config = require('config');
const log = require('fw.log');
const nav = require('fw.nav');

const say = log.say;
const bump = log.ct;
const moveTo = nav.moveTo;

/* ------------------------------ 建造 ------------------------------ */

/**
 * 工地优先级：数字越小越先建。
 * 矿源旁容器（直接提升产能）最优先；控制器容器/仓储（只是缓冲）靠后。
 */
function sitePriority(site, data) {
    switch (site.structureType) {
        case STRUCTURE_CONTAINER: {
            for (const s of (data.sources || [])) {
                if (site.pos.getRangeTo(s.pos) <= 2) return 1;
            }
            // 控制器旁容器 = 升级者的唯一供能点，没它升级直接停摆，所以排最前
            const ctrl = data.room && data.room.controller;
            if (ctrl && site.pos.getRangeTo(ctrl.pos) <= 3) return 1;
            return 5;
        }
        case STRUCTURE_TOWER: return 2;
        case STRUCTURE_EXTENSION: return 3;
        case STRUCTURE_STORAGE: {
            // storage 是 30000 hit 的大工程，相当于 30000 能量。
            // 实测：房间产出 4~5 e/tick，3 个建造者灌进去之后升级直接停摆。
            // 能量不到容量的 60% 就先放着，等 RCL5 产能上来再建。
            const room = data.room;
            const avail = room ? (room.energyAvailable || 0) : 0;
            const cap = room ? (room.energyCapacityAvailable || 300) : 300;
            return avail < cap * 0.6 ? 99 : 6;
        }
        case STRUCTURE_LINK: return 5;
        case STRUCTURE_ROAD: return 7;
        default: return 6;
    }
}

function buildSomething(creep, data) {
    if (!data.sites.length) return false;
    let best = null;
    let bestDist = 999;
    let bestPri = 99;
    // 先按结构类型优先级，再按距离
    // 评分 = 类型优先级 * 8 + 距离：优先级仍然重要，但不会为了优先级跑 30 格
    let bestScore = Infinity;
    for (const s of data.sites) {
        const pri = sitePriority(s, data);
        const d = creep.pos.getRangeTo(s);
        const score = pri * 8 + d;
        if (score < bestScore) {
            bestScore = score;
            bestPri = pri;
            bestDist = d;
            best = s;
        }
    }
    if (!best) return false;
    say(creep, '🔨');
    const r = creep.build(best);
    if (r === ERR_NOT_IN_RANGE) moveTo(creep, best);
    else if (r === OK) { creep.memory.task = 'building'; bump('build'); }
    return true;
}

/**
 * 只建造附近（range 内）的工地，避免为了建造跑远路
 */
function buildNearby(creep, data, range) {
    let best = null;
    let bestPri = 99;
    let bestDist = 99;
    for (const s of data.sites) {
        const d = creep.pos.getRangeTo(s);
        if (d > range) continue;
        const pri = sitePriority(s, data);
        if (pri < bestPri || (pri === bestPri && d < bestDist)) {
            bestPri = pri;
            bestDist = d;
            best = s;
        }
    }
    if (!best) return false;
    say(creep, '🔨');
    const r = creep.build(best);
    if (r === ERR_NOT_IN_RANGE) moveTo(creep, best);
    else if (r === OK) bump('build');
    return true;
}

/* ------------------------------ 维修 / 升级 ------------------------------ */

function repairSomething(creep, data) {
    const urgent = [];
    const normal = [];

    const candidatesForRepair = data.damageable || data.structures;
    for (const s of candidatesForRepair) {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) continue;
        if (!s.hits || !s.hitsMax) continue;
        const ratio = s.hits / s.hitsMax;
        if (ratio >= config.repairThreshold) continue;
        if (ratio < config.repairUrgent) urgent.push(s);
        else normal.push(s);
    }

    const list = urgent.length ? urgent : normal;
    if (!list.length) return false;

    list.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
    const target = list[0];
    say(creep, '🔧');
    const r = creep.repair(target);
    if (r === ERR_NOT_IN_RANGE) moveTo(creep, target);
    else if (r === OK) creep.memory.task = 'repairing';
    return true;
}

function upgradeController(creep, room) {
    const controller = room.controller;
    if (!controller || !controller.my) return false;
    say(creep, '⚡');
    const r = creep.upgradeController(controller);
    if (r === OK) bump('upgrade');
    else if (r === ERR_NOT_IN_RANGE) moveTo(creep, controller);
    else bump('upgradeErr_' + r);
    return true;
}

module.exports = { sitePriority, buildSomething, buildNearby, repairSomething, upgradeController };

/**
 * role.soldier —— 士兵（正面作战 / 跨房间清场 / 护航）
 *
 * 本模块负责"带攻击部件的单位怎么打"：
 *   - soldier：本房敌人（按威胁分级挑目标）→ Memory.fw.clearTarget 跨房间清场 →
 *     和平时期顺手拆障 → 最后转交边防巡逻（士兵不许原地发呆）；
 *   - escort：贴身护航同老家的 remoteHarvester / remoteHauler，遇敌就打。
 *
 * 不该放进来：巡逻路线与驻留巡游、关键节点清障原语（role.patrol）、
 * 情报目标挑选（role.scout / role.recon）、新房间建设（role.pioneer）。
 * 依赖方向单向：soldier -> patrol，patrol 不反 require 本模块。
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');
const patrol = require('role.patrol');

function soldier(creep, data) {
    // 1) 本房间有敌人：直接上
    if (data.hostiles && data.hostiles.length) {
        // P1 威胁分级：先打有攻击力的，再打拆家兵，无害的最后
        const tiers = utils.classifyHostiles(data.hostiles);
        const pool = tiers.damage.length ? tiers.damage : (tiers.structure.length ? tiers.structure : tiers.harmless);
        const target = creep.pos.findClosestByRange(pool);
        if (target) {
            utils.say(creep, '⚔');
            creep.memory.noEnemySince = undefined;
            const r = creep.attack(target);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, target);
            return;
        }
    }

    // 2) 有指定的"清场目标"（例如准备占领的房间里有敌人）：跨房间去打
    const clearRoom = Memory.fw && Memory.fw.clearTarget;
    if (clearRoom) {
        if (creep.room.name !== clearRoom) {
            utils.say(creep, '➡');
            utils.moveToRoom(creep, clearRoom);
            return;
        }
        const enemy = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (enemy) {
            utils.say(creep, '⚔');
            const r = creep.attack(enemy);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, enemy);
            return;
        }
        // 清完了
        utils.recordIntel(creep.room);
        Memory.fw.clearTarget = undefined;
    }

    // 3) 和平时期：先帮忙清路（有 WORK 就拆障），别站着发呆
    if (creep.body && creep.body.some(p => p.type === WORK)) {
        const blockers = patrol.keyNodes(creep.room);
        for (let i = 0; i < blockers.length; i++) {
            const st = patrol.firstBlocker(creep.room, blockers[i].pos, blockers[i].deep || 1);
            if (st) {
                utils.say(creep, '🚧');
                const dr = creep.dismantle(st);
                if (dr === ERR_NOT_IN_RANGE) utils.moveTo(creep, st);
                return;
            }
        }
    }

    // 3.5) 没有障碍可拆：全部派出去做领地巡逻（士兵不许原地发呆）
    patrol.patroller(creep, data);
    return;

    // 4) 无事可做：留 1 个常备军，多余的回收
    // 注意：本段在 3.5) 的 patroller + return 之后，实际不可达（原有实现如此）。
    // 本次是纯结构拆分，不在此处改逻辑；仅保留原样以免行为变化。
    const soldiers = data.creeplist.filter(c => c.memory && c.memory.role === 'soldier').length;
    creep.memory.noEnemySince = creep.memory.noEnemySince || Game.time;
    const spawn = data.spawns[0];
    if (!spawn) return;

    if (soldiers > 1 && Game.time - creep.memory.noEnemySince > 150) {
        if (creep.pos.getRangeTo(spawn) > 1) utils.moveTo(creep, spawn);
        else if (spawn.recycleCreep(creep) === OK) console.log('[FW] 回收闲置士兵 ' + creep.name);
        return;
    }
    if (creep.pos.getRangeTo(spawn) > 3) utils.moveTo(creep, spawn, { range: 3 });
}

/**
 * 护航兵：跟着远程采集/接驳单位跑，遇敌就打，没敌就贴身保护。
 * 远程采矿最怕的就是路上被 harass 兵点掉，所以护航走"贴身"而不是"巡逻"。
 */
function escort(creep, data) {
    // 本地有敌人优先
    if (data.hostiles && data.hostiles.length) {
        const t = creep.pos.findClosestByRange(data.hostiles);
        if (t) {
            utils.say(creep, '⚔');
            const r = creep.attack(t);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, t);
            return;
        }
    }

    // 找到要护送的同伴（同老家的远程单位）
    let ward = null;
    let bestD = 9999;
    for (const n in Game.creeps) {
        const c = Game.creeps[n];
        if (!c.memory || !c.memory.home) continue;
        if (c.memory.role !== 'remoteHarvester' && c.memory.role !== 'remoteHauler') continue;
        if (c.memory.home !== creep.memory.home) continue;
        const dd = creep.pos.getRangeTo(c);
        if (creep.room.name === c.room.name && dd < bestD) { bestD = dd; ward = c; }
        else if (!ward) ward = c;
    }
    if (!ward) {
        // 没有远程单位：回防老家
        const sp = data.spawns[0];
        if (sp && creep.pos.getRangeTo(sp) > 4) utils.moveTo(creep, sp, { range: 4 });
        return;
    }
    if (creep.room.name !== ward.room.name) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, ward.room.name);
        return;
    }
    if (creep.pos.getRangeTo(ward) > 3) {
        utils.say(creep, '🛡');
        utils.moveTo(creep, ward);
    } else {
        utils.say(creep, '🛡');
    }
}

module.exports = {
    soldier: soldier,
    escort: escort,
};

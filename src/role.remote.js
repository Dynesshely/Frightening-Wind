/**
 * role.remote —— 远程采集队（remoteHarvester 远程矿工 + remoteHauler 远程接驳工）
 *
 * 本模块负责"相邻房间的增量产能"：
 *   remoteHarvester  去 targetRoom 采矿；先立矿源旁的容器工地（就地倾倒），
 *                    满载后倒进远程容器，不自己跑长途；目标丢失时自动转职回本地采集。
 *   remoteHauler     只负责"远程容器 → 老家"这段批量运输，把原来的"矿工自己跑 70 格"
 *                    拆成"矿工站定 + 接驳工批量搬"；目标丢失时转职回本地搬运。
 *
 * 不可达止损不在角色层：fw.nav 连续寻路失败会拉黑房间，quota.pickRemoteTarget 会避开。
 * 角色层只做"没目标就转职"，绝不只 say('❓') 然后 return（那样角色会永远站在原地发呆）。
 *
 * 不该放进来：目标房间的挑选与配额（quota.js）、本地搬运（role.hauler）、
 * 护航作战（role.soldier 的 escort，它反过来跟着这两个角色走）。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');

/* ------------------------------ 远程采集者 ------------------------------ */

/**
 * 去相邻房间挖矿再把能量背回来。
 * 只在"本房间已经饱和"时启用（远距离往返效率天然比本地低，是增量而不是主力）。
 */
function remoteHarvester(creep, data) {
    const home = creep.memory.home || creep.room.name;
    const targetRoom = creep.memory.targetRoom;

    // 不可达止损已上移到导航层（fw.nav 连续寻路失败会拉黑房间，
    // quota.pickRemoteTarget 会自动避开）。角色层只负责"没目标就转职"。

    if (!targetRoom) {
        // 目标丢失（可能被抖动检测/不可达止损清掉）：就地转职为本地采集。
        // 绝不能只 say('❓') 然后 return —— 那样角色会永远站在原地发呆。
        creep.memory.role = 'harvester';
        creep.memory.roleSince = Game.time;
        creep.memory.sourceId = undefined;
        creep.memory.targetRoom = undefined;
        creep.memory.working = undefined;
        console.log('[FW] ' + creep.name + ' 远程目标丢失，转回本地采集');
        return;
    }

    if (!utils.isWorking(creep)) {
        if (creep.room.name !== targetRoom) {
            utils.say(creep, '➡');
            utils.moveToRoom(creep, targetRoom);
            return;
        }
        let source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
        if (!source) {
            const sources = creep.room.find(FIND_SOURCES);
            if (!sources.length) return;
            source = sources[0];
            creep.memory.sourceId = source.id;
        }
        // 远程采矿 2.0：先把矿源旁的容器工地立起来（有工地就顺手建，建好后就地倾倒）
        const boxInfo = utils.remoteBoxStatus(creep.room, source);
        if (!boxInfo.hasBox) {
            if (boxInfo.site) {
                utils.say(creep, '🔨');
                const br = creep.build(boxInfo.site);
                if (br === ERR_NOT_IN_RANGE) utils.moveTo(creep, boxInfo.site);
                return;
            }
            if (boxInfo.canBuild) {
                const created = utils.createRemoteBox(creep.room, source);
                if (created) console.log('[FW] ' + creep.room.name + ' 远程容器工地已开: ' + created);
            }
        }
        utils.say(creep, '⛏');
        const r = creep.harvest(source);
        if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, source);
        return;
    }

    // 满载：如果远程房间里有容器 -> 就地倒进去（自己不再跑长途，交给接驳工）
    const src = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
    if (creep.room.name === targetRoom) {
        let box = null;
        try {
            for (const s of creep.room.find(FIND_STRUCTURES)) {
                if (s.structureType === STRUCTURE_CONTAINER && (!src || s.pos.getRangeTo(src.pos) <= 2)) { box = s; break; }
            }
        } catch (e) { }
        if (box) {
            utils.transferTo(creep, box);
            return;
        }
    }

    if (creep.room.name !== home) {
        utils.say(creep, '🏠');
        utils.moveToRoom(creep, home);
        return;
    }

    if (utils.deliverEnergy(creep, data)) return;
    if (utils.dumpSurplus(creep, data)) return;
    if (data.spawns[0]) utils.moveTo(creep, data.spawns[0], { range: 2 });
}

/* ------------------------------ 远程接驳工 ------------------------------ */

/**
 * 远程接驳工：只负责"远程容器 -> 老家"这一段短途批量运输。
 * 和远程矿工配合，把原来的"矿工自己跑 70 格"拆成"矿工站定 + 接驳工批量搬"。
 */
function remoteHauler(creep, data) {
    const home = creep.memory.home || creep.room.name;
    const target = creep.memory.targetRoom;
    if (!target) {
        // 目标丢失：转回本地搬运，别站着
        creep.memory.role = 'hauler';
        creep.memory.roleSince = Game.time;
        creep.memory.working = undefined;
        return;
    }

    if (!utils.isWorking(creep)) {
        // 去远程房间取货
        if (creep.room.name !== target) { utils.moveToRoom(creep, target); return; }
        let box = null;
        try {
            for (const s of creep.room.find(FIND_STRUCTURES)) {
                if (s.structureType === STRUCTURE_CONTAINER && (s.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= 50) { box = s; break; }
            }
        } catch (e) { }
        if (box) { utils.transferFrom(creep, box); return; }
        utils.say(creep, '💤');
        return;
    }

    if (creep.room.name !== home) { utils.say(creep, '🏠'); utils.moveToRoom(creep, home); return; }
    if (utils.deliverEnergy(creep, data)) return;
    if (utils.dumpSurplus(creep, data)) return;
    if (data.spawns[0]) utils.moveTo(creep, data.spawns[0], { range: 2 });
}

module.exports = {
    remoteHarvester,
    remoteHauler,
};

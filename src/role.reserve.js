/**
 * role.reserve —— 控制器预定 / 占领（reserver 预定者 + claimer 占房者）
 *
 * 本模块负责"去别人的空地占位"这一类一次性的扩张动作：
 *   reserver  GCL 不够时先 reserveController 预定（拿视野 + 规则上锁住这块地）；
 *             发现已经被别人占了就放弃目标回老家，绝不站着浪费 TTL。
 *   claimer   真正 claimController 占房；GCL 不足时记录 Memory.fw.gclBlocked 并回家。
 *
 * 目标是相邻房间（memory.targetRoom），老家是 memory.home。
 * 情报记录统一走 utils.recordIntel（→ fw.intel）。
 *
 * 不该放进来：目标房间怎么挑（quota.js）、占下来之后的建设（role.pioneer）、
 * 清场作战（role.soldier）。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');

/* ------------------------------ 占领者 ------------------------------ */

/**
 * 去相邻房间预定控制器（reserve）：GCL 1 时还占不了房，
 * 但预定能拿到房间视野、并在规则上锁住这块地不被别人先占。
 */
function reserver(creep, data) {
    const targetRoom = creep.memory.targetRoom;
    const home = creep.memory.home || creep.room.name;
    if (!targetRoom) {
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }

    if (creep.room.name !== targetRoom) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, targetRoom);
        return;
    }

    const controller = creep.room.controller;
    if (!controller) return;

    // 已经是自己的：占完就该回收（留在原地纯浪费 TTL）
    if (controller.my) {
        utils.say(creep, '✅');
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }

    if (controller.owner) {
        // 被别人占了，放弃这个目标
        utils.say(creep, '❌');
        creep.memory.targetRoom = undefined;
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }

    utils.say(creep, '🚩');
    const r = creep.reserveController(controller);
    if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, controller, { range: 1 });
    else if (r === OK) utils.recordIntel(creep.room);
    else if (r === ERR_INVALID_TARGET) {
        // 敌方预定中，留着继续观察
        utils.recordIntel(creep.room);
    }
}

/* ------------------------------ 占房者 ------------------------------ */

function claimer(creep, data) {
    const target = creep.memory.targetRoom;
    const home = creep.memory.home || creep.room.name;
    if (!target) {
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
        return;
    }
    if (creep.room.name !== target) {
        utils.say(creep, '➡');
        utils.moveToRoom(creep, target);
        return;
    }
    const ctrl = creep.room.controller;
    if (!ctrl) return;
    if (ctrl.my) {
        // 已经拿下了：记录情报，回家（后续交给开拓者）
        utils.recordIntel(creep.room);
        console.log('[FW] 占领成功: ' + target);
        creep.memory.targetRoom = undefined;
        utils.moveToRoom(creep, home);
        return;
    }
    if (ctrl.owner) {
        console.log('[FW] 放弃目标（已被占）: ' + target);
        creep.memory.targetRoom = undefined;
        utils.moveToRoom(creep, home);
        return;
    }
    utils.say(creep, '🚩');
    const r = creep.claimController(ctrl);
    if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, ctrl, { range: 1 });
    else if (r === OK) { console.log('[FW] 已占领 ' + target); utils.recordIntel(creep.room); }
    else if (r === ERR_GCL_NOT_ENOUGH) {
        console.log('[FW] GCL 不足，暂时占不了 ' + target);
        Memory.fw.gclBlocked = Game.time;
        creep.memory.targetRoom = undefined;
        if (creep.room.name !== home) utils.moveToRoom(creep, home);
    }
}

module.exports = {
    reserver,
    claimer,
};

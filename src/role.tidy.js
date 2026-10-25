/**
 * role.tidy —— 周边整理与拆障辅助（抱团时的"扫地"职责）
 *
 * 本模块负责三件与具体角色无关的杂活：
 *   tidyNearby       顺手拆掉身边 3 格内挡路的非关键结构（路/容器/rampart 保留），
 *                    自带 120 tick 冷却（memory.tidyNext）。当前 BEHAVIORS 未注册它，
 *                    按原实现原样保留，供后续接入或手动调用。
 *   bumpDemolish     累计"防洪拆障"进度：超过 400 tick 自动放弃标记，防止拆不动还一直磨。
 *   runDemolishTask  抢险拆障任务本体：memory.demolish = {x,y} 指到哪拆到哪。
 *                    由 roles.run() 在分发角色行为之前统一调用（任何角色都可能被指派）。
 *
 * 不该放进来：统一的角色分发与发呆兜底（留在 roles.js）、
 * 城墙/rampart 的规划与维修（mgr.wall）、巡逻清障路线（role.patrol）。
 *
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const utils = require('utils');

/* ------------------------------ 周边整理 ------------------------------ */

/**
 * 顺手清理脚边挡路的结构（3 格范围，带 120 tick 冷却）。
 * 不碰路 / 容器 / rampart（这些是自己要的），也不碰 spawn / controller（拆不得）。
 * 返回 true 表示这一 tick 已经在拆东西了。
 */
function tidyNearby(creep) {
    const m = creep.memory;
    if (Game.time < (m.tidyNext || 0)) return false;
    m.tidyNext = Game.time + 120;
    let found = [];
    try {
        found = creep.room.lookForAtArea(LOOK_STRUCTURES,
            Math.max(1, creep.pos.y - 3), Math.max(1, creep.pos.x - 3),
            Math.min(48, creep.pos.y + 3), Math.min(48, creep.pos.x + 3), true) || [];
    } catch (e) { return false; }
    for (const item of found) {
        const st = item.structure;
        if (!st) continue;
        const t = st.structureType;
        if (t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER || t === STRUCTURE_RAMPART) continue;
        if (t === STRUCTURE_SPAWN || t === STRUCTURE_CONTROLLER) continue;
        utils.say(creep, '🧹');
        const r = creep.dismantle(st);
        if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, st);
        return true;
    }
    return false;
}

/* ------------------------------ 拆障辅助 ------------------------------ */

/**
 * 拆障计数：连续拆超过 400 tick 就放弃这个目标（多半是血太厚/拆不动），
 * 把 memory.demolish 清掉，交还给正常的角色行为。
 */
function bumpDemolish(creep) {
    creep.memory.demolishTicks = (creep.memory.demolishTicks || 0) + 1;
    if (creep.memory.demolishTicks > 400) { creep.memory.demolish = undefined; creep.memory.demolishTicks = 0; }
}

/**
 * 拆障任务（抢险用）：memory.demolish = {x,y}，拆掉那格结构，腾出路。
 * 一格都没有就直接清标记；走不到就走过去；拆成功了才累加计数。
 * 由 roles.run() 在角色分发之前调用，调用方负责 return（本函数不再返回）。
 */
function runDemolishTask(creep) {
    const d = creep.memory.demolish;
    let target = null;
    const found = creep.room.lookForAt(LOOK_STRUCTURES, d.x, d.y);
    if (found && found.length) target = found[0];
    if (!target) { creep.memory.demolish = undefined; return; }
    utils.say(creep, '🔨');
    const r = creep.dismantle(target);
    if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, target);
    else if (r === OK) bumpDemolish(creep);
}

module.exports = {
    tidyNearby,
    bumpDemolish,
    runDemolishTask,
};

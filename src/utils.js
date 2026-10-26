/**
 * utils —— 门面层（只做聚合 / 转出，不实现业务）。
 *
 * 历史原因全库都以 utils.xxx 调用，这里保留全部键名不变；具体实现已按职责拆到：
 *   fw.room    房间快照缓存（每 tick 每房间一次 find） + 敌对单位威胁分级
 *   fw.geo     地形 / 可达性（accessCount、wouldBlockAccess）
 *   fw.store   库存读写与能量调度（采集 / 取货 / 交付 / 倾倒）
 *   fw.build   建造 / 维修 / 升级控制器
 *   fw.body    身体组装与角色推断（PART_COST、planBody、inferRole、countRole）
 * 另外 fw.slot（采集站位）/ fw.intel（房间情报）这两个更早拆出去的模块也在这里聚合。
 *
 * 仍然留在本文件里的只有三个委托门面：
 *   moveTo / moveToRoom —— 委托 fw.nav（全库唯一移动入口）
 *   say                 —— 委托 fw.log
 * 它们是"纪律入口"，不要搬走，也不要在这两个函数里加任何防抖/防卡补丁。
 *
 * 不该放进来：任何具体实现。新增能力请写进对应的 fw.* 模块，再由本文件转出；
 * 也不要在这里 require 上层模块（economy / roles / defense），避免循环依赖。
 */
const log = require('fw.log');
const nav = require('fw.nav');

const roomMod = require('fw.room');
const geoMod = require('fw.geo');
const storeMod = require('fw.store');
const buildMod = require('fw.build');
const bodyMod = require('fw.body');
const slotMod = require('fw.slot');
const intelMod = require('fw.intel');

/* ------------------------------ 移动（门面，实现见 fw.nav） ------------------------------ */

// 所有移动逻辑集中在 fw.nav：意图模型 + 出口格锁定 + 停滞/振荡处理。
// 这里只保留门面，历史调用点无需改动。
//
// 重要：不要再往这两个函数里加任何"防抖 / 防卡 / 防越界"补丁。
// 分散在各处、彼此不知情的补丁正是上一版边界横跳越修越乱的根源 ——
// 这类逻辑只允许存在于 fw.nav 一处。
function moveTo(creep, target, opts) {
    return nav.moveTo(creep, target, opts);
}

/**
 * 跨房间移动：只要进入目标房间就算到达。
 *
 * 具体怎么走（逐房间推进、锁定"下一房间的入口格"）全部由 fw.nav 负责 ——
 * 这里不要试图自己算出口，那样会造出第二套导航逻辑，正是上一版边界横跳的成因。
 */
function moveToRoom(creep, roomName) {
    return nav.moveToRoom(creep, roomName);
}

/* ------------------------------ 说话 ------------------------------ */

// 说话同时写 memory.lastSay，供外部采样脚本判断角色状态。
const say = log.say;

/* ------------------------------ 站位与情报 ------------------------------ */

// 实现在 fw.slot / fw.intel，这里只做聚合（外部调用保持 utils.xxx 不变）

module.exports = Object.assign({
    roomData: roomMod.roomData,
    storeOf: storeMod.storeOf,
    usedCap: storeMod.usedCap,
    usedEnergy: storeMod.usedEnergy,
    freeCap: storeMod.freeCap,
    freeEnergyCap: storeMod.freeEnergyCap,
    moveTo,
    pickSource: storeMod.pickSource,
    harvestSource: storeMod.harvestSource,
    withdrawEnergy: storeMod.withdrawEnergy,
    deliverEnergy: storeMod.deliverEnergy,
    transferTo: storeMod.transferTo,
    transferFrom: storeMod.transferFrom,
    dumpSurplus: storeMod.dumpSurplus,
    retire: storeMod.retire,
    tileTime: storeMod.tileTime,
    spawnSurplus: storeMod.spawnSurplus,
    nearestLooseEnergy: storeMod.nearestLooseEnergy,
    nearestEnergyStore: storeMod.nearestEnergyStore,
    buildSomething: buildMod.buildSomething,
    buildNearby: buildMod.buildNearby,
    repairSomething: buildMod.repairSomething,
    upgradeController: buildMod.upgradeController,
    planBody: bodyMod.planBody,
    bodyCost: bodyMod.bodyCost,
    say,
    // 横跳兜底：角色层检测到单位在两房间之间往返时，冻结它的跨房间移动
    freezeTravel: nav.freeze,
    travelFrozen: nav.frozen,
    isWorking: storeMod.isWorking,
    moveToRoom,
    classifyHostiles: roomMod.classifyHostiles,
    accessCount: geoMod.accessCount,
    wouldBlockAccess: geoMod.wouldBlockAccess,
    chokePoints: geoMod.chokePoints,
    inferRole: bodyMod.inferRole,
    countRole: bodyMod.countRole,
}, slotMod, intelMod);

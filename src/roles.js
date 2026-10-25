/**
 * roles —— 经济角色注册表 / 分发门面
 *
 * 原 485 行巨石已按职责拆分为（每个角色一个文件）：
 *   role.harvester.js  harvester（自采自送） + pickupLoose（顺手捡漏，建造者/升级者复用）
 *   role.miner.js      miner（站定专属站位挖矿，满了倒 link / 容器）
 *   role.hauler.js     hauler（容器 → spawn/扩展/塔 的本地搬运）
 *   role.builder.js    builder（建造 / 维修）
 *   role.upgrader.js   upgrader（控制器升级，控制器旁容器等货）
 *   role.remote.js     remoteHarvester + remoteHauler（远程采集与接驳）
 *   role.reserve.js    reserver + claimer（预定 / 占领控制器）
 *   role.tidy.js       tidyNearby + bumpDemolish + runDemolishTask（周边整理、拆障辅助）
 * 军事与扩张角色仍由 roles.military 汇总（soldier / escort / patrol / scout / recon / pioneer）。
 *
 * 本文件只保留三件事：
 *   1. run() 的跨角色分发：拆障任务 → 回收任务 → 按角色调用 BEHAVIORS；
 *   2. BEHAVIORS 注册表（键名与拆分前完全一致，拼装顺序也不变）；
 *   3. ★ 发呆兜底（config.idleTicksBeforeHome）—— 见 run() 里的注释，逻辑一字未改。
 *
 * 不该放进来：任何具体角色策略（去对应的 role.*.js）、战术与配额（quota / war），
 * 也不要在这里 require 上层模块（economy / main），避免循环依赖。
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const config = require('config');
const utils = require('utils');

const harvesterMod = require('role.harvester');
const minerMod = require('role.miner');
const haulerMod = require('role.hauler');
const builderMod = require('role.builder');
const upgraderMod = require('role.upgrader');
const remoteMod = require('role.remote');
const reserveMod = require('role.reserve');
const tidy = require('role.tidy');

/* ------------------------------ 角色注册表 ------------------------------ */

const military = require('roles.military');

// 经济角色在本地，军事/扩张角色来自 roles.military
const BEHAVIORS = Object.assign({
    reserver: reserveMod.reserver,
    claimer: reserveMod.claimer,
    harvester: harvesterMod.harvester,
    remoteHarvester: remoteMod.remoteHarvester,
    remoteHauler: remoteMod.remoteHauler,
    miner: minerMod.miner,
    hauler: haulerMod.hauler,
    builder: builderMod.builder,
    upgrader: upgraderMod.upgrader,
}, military.BEHAVIORS);

/* ------------------------------ 统一分发 ------------------------------ */

function run(creep) {
    if (creep.spawning) return;

    // 拆障（抢险用）：memory.demolish = {x,y}，拆掉那格结构，腾出路。
    // 这是跨角色的临时任务（任何单位都可能被指派），实现见 role.tidy。
    if (creep.memory && creep.memory.demolish) {
        tidy.runDemolishTask(creep);
        return;
    }

    // 待回收：回 spawn 换能量，把名额让给紧缺岗位
    if (creep.memory && creep.memory.recycle) {
        const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS) || Game.spawns[Object.keys(Game.spawns)[0]];
        if (!spawn) { creep.memory.recycle = undefined; return; }
        if (creep.pos.getRangeTo(spawn) <= 1) {
            const r = spawn.recycleCreep(creep);
            if (r === OK) console.log('[FW] 已回收 ' + creep.name);
            else if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, spawn);
            return;
        }
        utils.moveTo(creep, spawn);
        return;
    }

    if (!creep.memory) creep.memory = {};
    if (!creep.memory.role || !BEHAVIORS[creep.memory.role]) {
        creep.memory.role = utils.inferRole(creep);
    }

    // ---- 房间横跳兜底（最后一道防线）----
    // 正常情况下 fw.nav 的意图模型已经保证"一次只做一个决定"，不会横跳。
    // 但只要角色层还有分支能绕过导航层反复改主意（线上真实发生过：侦察兵每 tick 往返两个房间），
    // 就必须有一个不依赖导航层被调用的刹车。这里直接看"房间序列"：
    // 24 tick 内换了 5 次房间，就冻结它的跨房间移动一段时间，让它在本房间里待着。
    const roomNow = creep.room.name;
    if (creep.memory._rr !== roomNow) {
        creep.memory._rr = roomNow;
        let trail = creep.memory._rrT;
        if (!trail) trail = creep.memory._rrT = [];
        trail.push(Game.time);
        if (trail.length > 6) trail.shift();
        if (trail.length >= 5 && (Game.time - trail[0]) <= 24) {
            trail.length = 0;
            utils.freezeTravel(creep, config.nav.holdTicks);
        }
    }

    const data = utils.roomData(creep.room);
    const fn = BEHAVIORS[creep.memory.role] || harvesterMod.harvester;
    const before = creep.memory.lastSay;
    fn(creep, data);

    // ---- 发呆兜底 ----
    // 判定"这一 tick 完全没有产出"：位置没变，提示语也没换。
    // 这种单位通常是卡在一个永远到不了的目标上，或者等一个永远不会来的条件。
    // 没有这条兜底时，它们会站在房间边界一动不动几百 tick —— 也就是玩家看到的"单位堵在边境"。
    //
    // 注意位置键里带房间名：跨房间瞬移时 x/y 可能恰好相同，只比坐标会漏判。
    //
    // 光看"没动 + 提示语没变"是不够的：矿工站在矿位上挖矿、升级者站在控制器旁
    // 升级，都是静止但完全正常的。用"背包储量有没有变化"作为"是否真在干活"的信号 ——
    // 挖矿会让它涨、建造/升级/搬运会让它掉，发呆则纹丝不动。
    const posKey = creep.room.name + ':' + creep.pos.x + ',' + creep.pos.y;
    const storeNow = utils.usedCap(creep);
    const storeChanged = creep.memory._st !== storeNow;
    creep.memory._st = storeNow;
    const noChange = creep.memory.lastSay === before
        && creep.memory._ik === posKey
        && !storeChanged;
    creep.memory._ik = posKey;
    creep.memory._idleTicks = noChange ? (creep.memory._idleTicks || 0) + 1 : 0;

    // 正在赶路（有未过期的跨房间意图）时不要抢方向盘：
    // 真实引擎里 creep.pos 在整 tick 内不变，被地形/同伴拖慢时连续几个 tick 位置一样，
    // 会被误判成"发呆"，然后被推回老家 —— 而角色下一 tick 又把它派出去，来回拉扯。
    const trip = creep.memory.nav;
    const travelling = !!(trip && trip.u && Game.time <= trip.u && trip.r && trip.r !== creep.room.name);
    if (travelling) creep.memory._idleTicks = 0;

    if (creep.memory._idleTicks >= config.idleTicksBeforeHome && !travelling) {
        creep.memory._idleTicks = 0;
        const home = creep.memory.home || creep.room.name;
        if (creep.room.name !== home) {
            utils.moveToRoom(creep, home);
        } else {
            // 已经在老家：别贴着边界站着，回停产点附近待命
            const anchor = data.spawns[0] || data.controller || null;
            if (anchor) utils.moveTo(creep, anchor, { range: 6 });
            else utils.moveTo(creep, new RoomPosition(25, 25, creep.room.name), { range: 6 });
        }
    }
}

module.exports = {
    run,
    BEHAVIORS,
    pickScoutTarget: military.pickScoutTarget,
    pickReconTarget: military.pickReconTarget,
    patrolRoute: military.patrolRoute,
};

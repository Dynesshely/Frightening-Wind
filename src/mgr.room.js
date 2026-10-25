/**
 * mgr.room —— 单房间层面的调度辅助（房间侧逻辑）。
 *
 * 负责：
 *   1. 能量流水账 trackLedger：矿源能量下降算收入，控制器/工地进度差分算支出，
 *      每 50 tick 结一次 Memory.fw.ledgerLast，用来定位"未核销"差额（P0 排障用）；
 *   2. 房间信号记录 recordThreatSignals：巡逻队规模（Memory.fw.patrolSquad）、
 *      最近一次敌人方位（lastHostile）、"老家被袭"信号（homeUnderAttack / homeAttackAt）；
 *   3. 诊断快照 writeDiag：每 50 tick 把配额/容器化/结构/工地/角色统计写进 Memory.fw.diag；
 *   4. 矿源分配 assignSource：给采集类岗位挑"当前分到的人最少"的矿源。
 *
 * 不该放进来：
 *   - 孵化、命名、身体与 spawn 利用率（mgr.spawn）；
 *   - 人口重排 / 转职 / 回收（mgr.roster）；
 *   - runRoom 的编排骨架 —— 它保留在 economy.js（门面/入口层），这里只放它调用的房间侧步骤；
 *   - 任何移动：本模块不移动 creep，也不允许出现 creep.moveTo / creep.move。
 *
 * 依赖：config / utils / construction（源是否有容器）/ quota（诊断用的配额）。
 */

const config = require('config');
const utils = require('utils');
const construction = require('construction');
const quotaMod = require('quota');

/* ------------------------------ 能量流水账 ------------------------------ */

/**
 * P0 能量流水账：把能量去向记账，定位"未核销"差额。
 * 收入用矿源能量下降量估算（最可靠，不依赖动作计数），支出用控制器进度/工地进度差分。
 */
function trackLedger(room, data) {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.ledger) Memory.fw.ledger = { t: Game.time, income: 0, upgrade: 0, build: 0, store: 0, src: {}, prog: 0, siteProg: 0 };
    const L = Memory.fw.ledger;
    if (!L.src) L.src = {};

    let store = 0;
    for (const c of data.creeplist) if (c.store) store += c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    for (const s of data.allStructures) if (s.store) store += s.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

    for (const src of data.sources) {
        const prev = L.src[src.id];
        if (prev !== undefined && prev > src.energy) L.income += (prev - src.energy);
        L.src[src.id] = src.energy;
    }

    const ctrl = room.controller;
    if (ctrl) {
        if (L.prog !== undefined && ctrl.progress > L.prog) L.upgrade += (ctrl.progress - L.prog);
        L.prog = ctrl.progress;
    }

    let siteProg = 0;
    for (const s of data.sites) siteProg += (s.progress || 0);
    if (L.siteProg !== undefined && siteProg > L.siteProg) L.build += (siteProg - L.siteProg);
    L.siteProg = siteProg;

    const elapsed = Game.time - L.t;
    if (elapsed >= 50) {
        const delta = store - (L.store || 0);
        Memory.fw.ledgerLast = {
            t: Game.time, ticks: elapsed,
            income: L.income, upgrade: L.upgrade, build: L.build,
            storeDelta: delta,
            unaccounted: L.income - L.upgrade - L.build - delta,
        };
        L.t = Game.time; L.income = 0; L.upgrade = 0; L.build = 0; L.store = store;
    }
}

/* ------------------------------ 房间信号 ------------------------------ */

/**
 * 记录本房的巡逻规模与威胁方位。调用点在 runRoom 里、塔与防御之后、角色重排之前，
 * 顺序不能变（角色重排会改 creepsByRole，诊断快照要看到重排后的结果）。
 */
function recordThreatSignals(room, data) {
    // 巡逻队规模（巡逻兵按扇区切分路线时要用）
    const patrolCount = utils.countRole(data, 'patroller') + utils.countRole(data, 'soldier');
    if (!Memory.fw) Memory.fw = {};
    Memory.fw.patrolSquad = Math.max(1, patrolCount);

    // 记录最近一次敌人的方位（塔防选址按"来敌方向"布防）
    if (data.hostiles && data.hostiles.length > 0) {
        let nearest = data.hostiles[0];
        for (const h of data.hostiles) {
            if (data.spawns[0] && h.pos.getRangeTo(data.spawns[0]) < nearest.pos.getRangeTo(data.spawns[0])) nearest = h;
        }
        Memory.fw.lastHostile = { x: nearest.pos.x, y: nearest.pos.y, t: Game.time };
    }

    // 记录"老家被袭"信号：巡逻兵看到就会立刻回防
    if (data.hostiles && data.hostiles.length > 0) {
        Memory.fw.homeUnderAttack = room.name;
        Memory.fw.homeAttackAt = Game.time;
    } else if (Memory.fw && Memory.fw.homeUnderAttack === room.name && Game.time - (Memory.fw.homeAttackAt || 0) > 50) {
        Memory.fw.homeUnderAttack = undefined;
    }
}

/* ------------------------------ 诊断快照 ------------------------------ */

/**
 * 诊断信息（每 50 tick 写一次 Memory，外部可读）。非采样 tick 直接返回。
 */
function writeDiag(room, data) {
    if (Game.time % 50 !== 0) return;
    const q = quotaMod.computeQuota(room, data);
    Memory.fw.diag = {
        t: Game.time,
        quota: q,
        containerized: data.sources.filter(s => construction.sourceHasContainer(data, s)).length,
        containers: data.containers.length,
        structures: data.structures.length,
        structureTypes: data.structures.map(s => s.structureType),
        sites: data.sites.length,
        creeps: data.creeplist.length,
        roles: data.creepsByRole,
    };
}

/* ------------------------------ 矿源分配 ------------------------------ */

/**
 * 给采集类岗位挑矿源：优先"分到的人最少"的那个（同一 tick 内多次调用会偏向下一个）。
 * onlyContainerized=true 时只在"已经有容器"的矿源里挑（矿工必须站在容器上）。
 */
function assignSource(room, data, onlyContainerized) {
    if (!data.sources.length) return null;
    const candidates = onlyContainerized
        ? data.sources.filter(s => construction.sourceHasContainer(data, s))
        : data.sources;
    if (!candidates.length) return null;

    const load = {};
    for (const s of candidates) load[s.id] = 0;
    for (const c of data.creeplist) {
        const sid = c.memory && c.memory.sourceId;
        if (sid && load[sid] !== undefined) load[sid]++;
    }
    let best = candidates[0];
    for (const s of candidates) {
        if (load[s.id] < load[best.id]) best = s;
    }
    return best;
}

/* ------------------------------ 历史遗留（无调用点） ------------------------------ */

/**
 * 早期的塔驱动实现。现在塔由 defense.run → mgr.tower.runTowers 统一驱动，
 * 本函数已无任何调用点，也不再对外导出。
 * 保留原实现只为"结构重构不删策略代码"；确认无人依赖后可删除（删前请再 grep 一次 runTowers）。
 */
function runTowers(room, data) {
    if (!data.towers.length) return;

    for (const tower of data.towers) {
        if (data.hostiles.length) {
            const target = tower.pos.findClosestByRange(data.hostiles);
            if (target && tower.pos.getRangeTo(target) <= 10) {
                tower.attack(target);
                continue;
            }
        }

        // 治疗受伤的 creep
        const wounded = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: c => c.hits < c.hitsMax,
        });
        if (wounded) {
            tower.heal(wounded);
            continue;
        }

        // 维修（能量充足时）
        const capacity = tower.store.getCapacity(RESOURCE_ENERGY) || 0;
        const energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (capacity <= 0 || energy / capacity < config.towerRepairEnergyRatio) continue;

        const damaged = tower.pos.findClosestByRange(FIND_STRUCTURES, {
            filter: s => s.structureType !== STRUCTURE_WALL
                && s.structureType !== STRUCTURE_RAMPART
                && s.hits < s.hitsMax * config.repairThreshold,
        });
        if (damaged) tower.repair(damaged);
    }
}

module.exports = {
    trackLedger,
    recordThreatSignals,
    writeDiag,
    assignSource,
};

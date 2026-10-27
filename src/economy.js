/**
 * economy —— 房间经济门面（facade）。
 *
 * 本文件保留三件事（其余已按职责拆到子模块，导出键名与拆分前完全一致）：
 *   1. housekeeping()   每 tick 一次的全局清理 / 迁移 / 角色兜底；
 *   2. ownedRooms()     我方房间列表（控制器视野 + spawn 兜底）；
 *   3. runRoom()        单房间每 tick 的编排骨架（顺序即语义，不要随意调整）。
 *
 * 子模块分工：
 *   mgr.room.js    房间侧逻辑：能量流水账 trackLedger、房间信号 recordThreatSignals、
 *                  诊断快照 writeDiag、矿源分配 assignSource
 *   mgr.spawn.js   孵化与身体：tagSpawns（贴标 + 利用率）、runSpawns（选兵/造兵/初始 memory）、
 *                  spawnSurplus（富余能量孵化）
 *   mgr.roster.js  人口与角色重排：rebalanceRoles（缺口对比 + 就地转职）、recycleSurplus、
 *                  canDo（身体能力判定）
 *   quota.js       配额与目标房间计算（computeQuota / creepCap / pickSpawnRole …）
 *
 * 依赖方向（单向，无循环）：
 *   economy → defense / construction / mgr.room / mgr.spawn / mgr.roster / quota
 *   mgr.spawn → mgr.room；mgr.roster → quota / construction；子模块之间不互相 require 上层。
 *   新逻辑请加到对应子模块，不要往门面里堆。
 *
 * ★ housekeeping() 里的 Memory 迁移必须保持"只跑一次"（Memory.fw.migratedV6 门控）★
 *   这些字段里有 roles.run 正在用的位置快照，每 tick 清一次会让"发呆兜底"永远失效
 *   （踩过：哨兵在房间边界站了 250 tick）。改动本函数前先想清楚这一点。
 */

const config = require('config');
const utils = require('utils');
const defense = require('defense');
const construction = require('construction');
const quotaMod = require('quota');
const roomMgr = require('mgr.room');
const spawnMgr = require('mgr.spawn');
const rosterMgr = require('mgr.roster');
// V2 预算驱动架构（docs/ARCHITECTURE_V2.md）。config.core.v2=false 时这三个模块完全不参与。
const ledger = require('core.ledger');
const budgetMod = require('core.budget');
const policyMod = require('core.policy');

/* ------------------------------ 全局清理 ------------------------------ */

function housekeeping() {
    if (!Memory.creeps) Memory.creeps = {};
    if (!Memory.fw) Memory.fw = { version: config.version, stats: {} };

    // 清理已死亡 creep 的 Memory
    for (const name in Memory.creeps) {
        if (!Game.creeps[name]) delete Memory.creeps[name];
    }

    // 迁移：旧版移动补丁留下的 per-creep 字段已由 fw.nav 统一接管。
    // 它们一旦残留就会永久占用 Memory（每个 creep 十几个键），必须主动清掉。
    // 注意不能动 _move —— 那是引擎自己的路径缓存。
    // ★ 必须只跑一次 ★：这些字段里有 roles.run 正在用的位置快照，
    //   每 tick 清一次会让"发呆兜底"永远失效（踩过：哨兵在边界站了 250 tick）。
    if (!Memory.fw.migratedV6) {
        Memory.fw.migratedV6 = true;
        // 旧导航层那些"到不了就拉黑房间"的记录，是它自己跨房间失败留下的假情报
        // （它把 creep 停在边界格上，永远进不去，于是把能到的房间也拉黑了）。
        // 新导航层重写后必须清空，否则远程采集/巡逻会被一段毫无意义的黑名单挡住 3000 tick。
        if (Memory.fw.unreachable) Memory.fw.unreachable = undefined;
        if (Memory.fw.alerts) Memory.fw.alerts = undefined;
        for (const name in Game.creeps) {
        const m = Game.creeps[name].memory;
        if (!m) continue;
        if (m._lastPos !== undefined) m._lastPos = undefined;
        if (m._lastPosX !== undefined) m._lastPosX = undefined;
        if (m._lastPosY !== undefined) m._lastPosY = undefined;
        if (m._lpos !== undefined) m._lpos = undefined;
        if (m._stuck !== undefined) m._stuck = undefined;
        if (m._still !== undefined) m._still = undefined;
        if (m._edgeStuck !== undefined) m._edgeStuck = undefined;
        if (m._posHist !== undefined) m._posHist = undefined;
        if (m._jitter !== undefined) m._jitter = undefined;
        if (m._rmRoom !== undefined) m._rmRoom = undefined;
        if (m._rmTrail !== undefined) m._rmTrail = undefined;
        if (m._rmCool !== undefined) m._rmCool = undefined;
        if (m._noPath !== undefined) m._noPath = undefined;
            if (m.forceHome !== undefined) m.forceHome = undefined;
            if (m.moveRoom !== undefined) m.moveRoom = undefined;
        }
    }

    // 旧版本/旧骨架留下的角色迁移到新角色体系
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep.memory) creep.memory = {};
        // 旧角色名迁移（defender -> soldier）
        if (creep.memory.role === 'defender') creep.memory.role = 'soldier';
        if (!creep.memory.role || !config.bodies[creep.memory.role]) {
            creep.memory.role = utils.inferRole(creep);
        }
        if (!creep.memory.home) creep.memory.home = creep.room.name;
    }

    Memory.fw.version = config.version;
}

function ownedRooms() {
    const rooms = [];
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (room.controller && room.controller.my) rooms.push(room);
    }
    // 兜底：控制器视野不在时，用我方 spawn 所在房间
    if (!rooms.length) {
        for (const name in Game.spawns) {
            const room = Game.spawns[name].room;
            if (rooms.indexOf(room) === -1) rooms.push(room);
        }
    }
    return rooms;
}

/* ------------------------------ V2 预算驱动 ------------------------------ */

/**
 * 每 tick 记录账本并求解配置（docs/ARCHITECTURE_V2.md 第 4、5、7 节）。
 *
 * 只在 config.core.v2 为真时运行；关闭时一个字段都不写，行为与重构前完全一致。
 * 产出 data.v2plan = { roles, bodies, etaMode, upkeepCap, target }，供 mgr.spawn 使用。
 */
function runCore(room, data) {
    if (!config.core || !config.core.v2) return;
    try {
        const entry = buildLedgerEntry(room, data);
        ledger.record(room.name, entry);
        const snap = ledger.snapshot(room.name);
        const bud = budgetMod.allocate(room, data, snap);
        const plan = policyMod.plan(room, data, snap, bud);
        data.v2snap = snap;
        data.v2budget = bud;
        data.v2plan = plan;
    } catch (e) {
        // 决策层出错不能拖垮经济：记录一次并回退到旧配额
        if (!Memory.fw) Memory.fw = {};
        if (!Memory.fw.v2Errors) Memory.fw.v2Errors = [];
        Memory.fw.v2Errors.push({ t: Game.time, m: String(e && e.message || e) });
        if (Memory.fw.v2Errors.length > 20) Memory.fw.v2Errors.shift();
        data.v2plan = null;
    }
}

/**
 * 构造一条账本流水。
 *
 * 收入用 Memory.fw.ct 的累计计数差值反推（每次 harvest 产出 2 能量），
 * 支出暂时只统计"库存净变化"能解释的部分 —— 更精确的分项等实测校准后再补。
 */
function buildLedgerEntry(room, data) {
    const ct = (Memory.fw && Memory.fw.ct) || {};
    if (!Memory.fw.counters) Memory.fw.counters = {};
    const p = Memory.fw.counters;
    const last = p[room.name] || { harvest: ct.harvest || 0, upgrade: ct.upgrade || 0, build: ct.build || 0 };
    const dHarvest = Math.max(0, (ct.harvest || 0) - (last.harvest || 0));
    const dUpgrade = Math.max(0, (ct.upgrade || 0) - (last.upgrade || 0));
    p[room.name] = { harvest: ct.harvest || 0, upgrade: ct.upgrade || 0, build: ct.build || 0 };

    let stored = 0;
    for (const s of data.spawns) stored += s.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    for (const e of data.extensions) stored += e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    for (const c of data.containers) stored += c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (data.storage) stored += data.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

    let carried = 0;
    let workActive = 0;
    for (const c of data.creeplist) {
        carried += c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        for (const part of (c.body || [])) if (part.type === WORK) workActive++;
    }

    // ---- 用能量守恒反推总支出去向 ----
    // 恒等式：本 tick 库存 + 收入 - 消耗 = 下 tick 库存。
    // 以前 spend 只填了 upgrade，其余全 0，导致 net 系统性偏高（预算层据此超额分配）。
    const storedNow = stored + carried;
    if (!Memory.fw.ledgerStored) Memory.fw.ledgerStored = {};
    const prev = Memory.fw.ledgerStored[room.name];
    Memory.fw.ledgerStored[room.name] = storedNow;

    const incomeHarvest = dHarvest * 2;
    // 注意：creep 死亡会带走能量（尸体只留 20%），那部分也会算进"消耗"，
    // 属于可接受的噪声 —— 它确实是从房间能量池里消失的。
    const spendTotal = (prev === undefined)
        ? Math.max(0, dUpgrade)
        : Math.max(0, prev + incomeHarvest - storedNow);

    // 已知分项：升级是 1:1；建造按"每次 build 调用消耗 1 能量"近似（1 WORK 建 5 hit / 5 能量）
    const dBuild = Math.max(0, (ct.build || 0) - (last.build || 0));
    p[room.name].build = ct.build || 0;
    const spendUpgrade = Math.min(spendTotal, dUpgrade);
    const spendBuild = Math.min(spendTotal - spendUpgrade, dBuild);
    const spendOther = Math.max(0, spendTotal - spendUpgrade - spendBuild);

    return {
        income: { harvest: incomeHarvest, passive: 0, link: 0 },
        spend: {
            spawn: spendOther,          // 孵化 / 塔 / 维护等未细分项先归到这里
            upkeep: 0,
            upgrade: spendUpgrade,
            build: spendBuild,
            tower: 0,
        },
        state: { stored: storedNow, creepCount: data.creeplist.length, workActive: workActive },
    };
}

/* ------------------------------ 房间主流程 ------------------------------ */

/**
 * 每 tick 每间我方房间调用一次。顺序即语义：
 *   贴标 → 记账 → 防御（塔/安全模式/逃跑/工事）→ link → 威胁信号 → 角色重排
 *   → 诊断 → 建造规划 → 孵化
 */
function runRoom(room) {
    const data = utils.roomData(room);
    spawnMgr.tagSpawns([room]);
    roomMgr.trackLedger(room, data);
    defense.run(room, data);                   // 塔 / 安全模式 / 逃跑 / 防御工事
    construction.runLinks(room, data);         // RCL5+ 的 link 瞬移

    // 巡逻规模、最近来敌方位、"老家被袭"信号
    roomMgr.recordThreatSignals(room, data);
    rosterMgr.rebalanceRoles(room, data);      // 容器体系建好后，把多余的自采工人转成矿工/搬运工

    // V2：账本 → 预算 → 配置求解。结果挂在 data.v2plan 上，由 mgr.spawn 消费。
    runCore(room, data);

    // 诊断信息（每 50 tick 写一次 Memory，外部可读）
    roomMgr.writeDiag(room, data);

    construction.planConstruction(room, data);
    spawnMgr.runSpawns(room, data);
}

/* ------------------------------ 门面导出 ------------------------------ */

module.exports = {
    housekeeping,
    ownedRooms,
    runRoom,
    runSpawns: spawnMgr.runSpawns,
    computeQuota: quotaMod.computeQuota,
    creepCap: quotaMod.creepCap,
};

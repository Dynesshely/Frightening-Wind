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

/**
 * 防御模块：塔控制 / 紧急安全模式 / 逃跑 / 防御工事规划
 *
 * 设计原则：
 *  1. 每一次游戏 API 调用都有返回值检查或 try/catch —— 任何一步失败都只降级、不抛异常。
 *     主循环虽然会兜住异常，但每 tick 抛一次会刷屏控制台并刷爆 Memory.fw.errors。
 *  2. 不修改 Creep/Room 原型；不往 Memory 里存游戏对象，只存 tick 数字、id 字符串和 {x,y} 坐标。
 *  3. 重活（防御工事规划）有前置门槛：没有威胁历史且 RCL<5 时完全不花能量。
 *
 * 导出：
 *  run(room, data)                  每 tick 每间我方房间调用一次，内部依次执行下面四项
 *  runTowers(room, data)            塔：打敌人 / 治疗 / 维修
 *  activateSafeModeIfNeeded(room, data)  紧急安全模式
 *  fleeIfNeeded(room, data)         敌人靠近时逃跑
 *  planDefense(room, data)          防御工事（rampart）规划
 *  isFleeing(creep)                 给 roles.js 用：本 tick 该 creep 是否处于逃跑状态
 */
const config = require('config');
const utils = require('utils');

/* ------------------------------ 常量 ------------------------------ */

// 塔的射程：Screeps 里塔的 attack/heal/repair 射程都是 20 格
const TOWER_ATTACK_RANGE = 20;
// 塔的治疗距离
const TOWER_HEAL_RANGE = 20;
// 塔的维修距离
const TOWER_REPAIR_RANGE = 20;
// 安全模式最短重试间隔（安全模式本身有 500 tick 冷却，重复尝试只会刷屏）
const SAFE_MODE_COOLDOWN = 500;
// 敌人在该距离内就触发逃跑
const FLEE_TRIGGER_RANGE = 4;
// 逃跑状态至少保持的 tick 数（避免"敌人退一步就立刻回去送死"的抖动）
const FLEE_KEEP_TICKS = 8;
// 逃跑落点的重算间隔
const FLEE_RETARGET_TICKS = 4;
// 防御模块自己占用的工地配额上限（Lead 的总配额由 config.maxSitesPerRoom 控制）
const DEFENSE_SITE_CAP = 2;
// 威胁记忆时长：这么久内见过敌人就算"有威胁历史"
const THREAT_MEMORY_TICKS = 2000;
// 房间防御记忆的保留时长
const DEFENSE_MEM_TICKS = 10000;
// 错误记录的最小间隔（同一时段只留一条，防止 Memory 膨胀）
const ERROR_MIN_GAP = 200;

// 跑向 spawn 的经济角色（它们没有战斗力，且 spawn 周围有塔覆盖）
const ECONOMIC_ROLES = { harvester: true, miner: true, hauler: true, builder: true, upgrader: true };

/* ------------------------------ 记忆 ------------------------------ */

function gameTime() {
    try {
        return (typeof Game !== 'undefined' && Game.time) || 0;
    } catch (e) {
        return 0;
    }
}

/**
 * Memory.fw 的安全访问。Memory 理论上一定存在，但防御式写法在任何环境都能跑。
 */
function fwMemory() {
    try {
        if (typeof Memory === 'undefined' || !Memory) return null;
        if (!Memory.fw) Memory.fw = {};
        return Memory.fw;
    } catch (e) {
        return null;
    }
}

/**
 * 每间房间的防御记忆：
 *   { lastThreat, safeModeAt, exitDir:{x,y}, lastSeen }
 * 只放数字/字符串/小对象，保证 Memory 可序列化且体积可控。
 */
function defenseMemory(roomName) {
    const fw = fwMemory();
    if (!fw || !roomName) return {};
    if (!fw.defense) fw.defense = {};
    if (!fw.defense.rooms) fw.defense.rooms = {};
    let d = fw.defense.rooms[roomName];
    if (!d || typeof d !== 'object') {
        d = {};
        fw.defense.rooms[roomName] = d;
    }
    return d;
}

/**
 * 记录一条错误（同一时段最多一条），避免异常时把 Memory 刷爆。
 */
function noteError(e) {
    try {
        const fw = fwMemory();
        if (!fw) return;
        if (!fw.defense) fw.defense = {};
        const now = gameTime();
        if (fw.defense.errAt && now - fw.defense.errAt < ERROR_MIN_GAP) return;
        fw.defense.errAt = now;
        let msg;
        try {
            msg = e && e.message ? String(e.message) : String(e);
        } catch (inner) {
            msg = 'unknown error';
        }
        fw.defense.lastError = msg.slice(0, 180);
    } catch (ignored) {
        // 打日志本身失败也只能放弃，绝不能把异常抛给主循环
    }
}

/**
 * 包一层 try/catch：失败返回 fallback，永远不抛。
 */
function attempt(fn, fallback) {
    try {
        const r = fn();
        return r === undefined ? fallback : r;
    } catch (e) {
        noteError(e);
        return fallback;
    }
}

/* ------------------------------ 小工具 ------------------------------ */

function posOf(obj) {
    if (!obj) return null;
    return obj.pos ? obj.pos : (typeof obj.x === 'number' && typeof obj.y === 'number' ? obj : null);
}

/**
 * 切比雪夫距离（Screeps 的 range）。任何异常都返回 -1，调用方按"不可达"处理。
 */
function rangeTo(a, b) {
    const pa = posOf(a);
    const pb = posOf(b);
    if (!pa || !pb) return -1;
    if (typeof pa.getRangeTo === 'function') {
        try {
            return pa.getRangeTo(pb);
        } catch (e) {
            // 落到下面的手算
        }
    }
    if (typeof pa.x === 'number' && typeof pb.x === 'number') {
        return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
    }
    return -1;
}

function terrainOf(room) {
    return attempt(function () {
        return room && typeof room.getTerrain === 'function' ? room.getTerrain() : null;
    }, null);
}

function isWall(terrain, x, y) {
    if (!terrain || typeof terrain.get !== 'function') return false;
    return attempt(function () {
        return terrain.get(x, y) === TERRAIN_MASK_WALL;
    }, false);
}

function makePos(room, x, y) {
    return attempt(function () {
        if (typeof RoomPosition !== 'function') return { x: x, y: y };
        return new RoomPosition(x, y, room.name);
    }, null);
}

/**
 * 列出距离 from 在 range 内最近的对象（不依赖 findClosestByRange，mock 也能跑）。
 */
function nearestInRange(from, list, range) {
    if (!list || !list.length) return null;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
        const obj = list[i];
        if (!obj) continue;
        const d = rangeTo(from, obj);
        if (d < 0 || d > range) continue;
        if (d < bestDist) {
            bestDist = d;
            best = obj;
        }
    }
    return best;
}

function nearestOf(from, list) {
    if (!list || !list.length) return null;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
        const obj = list[i];
        if (!obj) continue;
        const d = rangeTo(from, obj);
        if (d < 0) continue;
        if (d < bestDist) {
            bestDist = d;
            best = obj;
        }
    }
    return best;
}

function isAliveCreep(creep) {
    return !!creep && creep.spawning !== true;
}

/* ------------------------------ 塔 ------------------------------ */

/**
 * 塔当前能量比例。读不到就当作 100%（宁可多修一点也不要不修）。
 */
function towerEnergyRatio(tower) {
    return attempt(function () {
        if (tower.store && typeof tower.store.getCapacity === 'function') {
            const cap = tower.store.getCapacity(RESOURCE_ENERGY) || 0;
            if (cap > 0) {
                return (tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0) / cap;
            }
        }
        if (typeof tower.energyCapacity === 'number' && tower.energyCapacity > 0) {
            return (tower.energy || 0) / tower.energyCapacity;
        }
        return 1;
    }, 1);
}

/**
 * 挑一个最该修的结构：优先"核心结构且血量很低"的，其次按距离。
 * 跳过 wall / rampart（那是 Lead 的 rampart 维护策略，塔修墙是能量黑洞）。
 */
function pickRepairTarget(tower, data) {
    const structures = (data && data.structures) || [];
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s || !s.hits || !s.hitsMax) continue;
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) continue;
        const ratio = s.hits / s.hitsMax;
        if (ratio >= config.repairThreshold) continue;
        const d = rangeTo(tower, s);
        if (d < 0 || d > TOWER_REPAIR_RANGE) continue;
        // 血量比例越低越急，距离越近越划算
        const urgent = ratio < config.repairUrgent ? 1000 : 0;
        const score = urgent + (1 - ratio) * 100 - d;
        if (score > bestScore) {
            bestScore = score;
            best = s;
        }
    }
    return best;
}

/**
 * 塔控制：敌人 → 治疗 → 维修，逐级降级。
 * 返回统计对象，方便外部观测（不参与游戏逻辑）。
 */
function runTowers(room, data) {
    const result = { towers: 0, attacked: 0, healed: 0, repaired: 0 };
    const towers = (data && data.towers) || [];
    if (!towers.length) return result;

    const hostiles = (data && data.hostiles) || [];
    const creeps = (data && data.creeplist) || [];

    for (let i = 0; i < towers.length; i++) {
        const tower = towers[i];
        if (!tower) continue;
        result.towers++;

        // 1) 打敌人：射程内最近的那个
        if (hostiles.length) {
            const target = nearestInRange(tower, hostiles, TOWER_ATTACK_RANGE);
            if (target) {
                const r = attempt(function () { return tower.attack(target); }, ERR_INVALID_TARGET);
                if (r === OK) {
                    result.attacked++;
                    continue;
                }
                // 攻击失败（能量不足等）就别在同一个塔上继续浪费，换下一个塔
                if (r === ERR_NOT_ENOUGH_ENERGY) continue;
            }
        }

        // 2) 治疗受伤的我方 creep
        const wounded = (function () {
            let best = null;
            let bestDist = Infinity;
            for (let j = 0; j < creeps.length; j++) {
                const c = creeps[j];
                if (!c || !c.hits || !c.hitsMax || c.hits >= c.hitsMax) continue;
                const d = rangeTo(tower, c);
                if (d < 0 || d > TOWER_HEAL_RANGE) continue;
                // 血量比例最低的优先，同比例时近的优先
                const score = (c.hits / c.hitsMax) * 1000 + d;
                if (score < bestDist) {
                    bestDist = score;
                    best = c;
                }
            }
            return best;
        })();
        if (wounded) {
            const r = attempt(function () { return tower.heal(wounded); }, ERR_INVALID_TARGET);
            if (r === OK) {
                result.healed++;
                continue;
            }
            if (r === ERR_NOT_ENOUGH_ENERGY) continue;
        }

        // 3) 维修：能量 > 70% 才修，避免和造兵抢能量
        if (towerEnergyRatio(tower) <= config.towerRepairEnergyRatio) continue;
        const damaged = pickRepairTarget(tower, data);
        if (!damaged) continue;
        const r = attempt(function () { return tower.repair(damaged); }, ERR_INVALID_TARGET);
        if (r === OK) result.repaired++;
    }

    return result;
}

/* ------------------------------ 紧急安全模式 ------------------------------ */

/**
 * 判断危险等级：有敌人 且 满足任一条件
 *   - 任一 spawn 血量 < 50%
 *   - 敌人数量 >= 3
 *   - 任一我方 creep 血量 < 50%
 */
function isEmergency(data) {
    const spawns = (data && data.spawns) || [];
    const creeps = (data && data.creeplist) || [];
    const hostiles = (data && data.hostiles) || [];

    for (let i = 0; i < spawns.length; i++) {
        const s = spawns[i];
        if (!s || !s.hits || !s.hitsMax) continue;
        if (s.hits / s.hitsMax < 0.5) return true;
    }
    if (hostiles.length >= 3) return true;
    for (let i = 0; i < creeps.length; i++) {
        const c = creeps[i];
        if (!c || !c.hits || !c.hitsMax) continue;
        if (c.hits / c.hitsMax < 0.5) return true;
    }
    return false;
}

/**
 * 紧急安全模式。冷却写在 Memory.fw.safeModeAt（全局）与房间记忆里，
 * 至少 500 tick 内不重复尝试，激活失败也记时间戳（否则会每 tick 调一次）。
 */
function activateSafeModeIfNeeded(room, data) {
    const hostiles = (data && data.hostiles) || [];
    if (!hostiles.length) return false;

    const controller = (data && data.room ? data.room.controller : (room ? room.controller : null));
    if (!controller || !controller.my) return false;
    if (typeof controller.activateSafeMode !== 'function') return false;
    if (controller.safeModeAvailable === 0) return false;   // 没有存量，别浪费调用
    if (controller.safeModeCooldown) return false;          // 还在冷却

    const now = gameTime();
    const fw = fwMemory();
    if (fw && fw.safeModeAt && now - fw.safeModeAt < SAFE_MODE_COOLDOWN) return false;

    const name = (room && room.name) || (data.room && data.room.name) || '';
    const mem = defenseMemory(name);
    if (mem.safeModeAt && now - mem.safeModeAt < SAFE_MODE_COOLDOWN) return false;

    if (!isEmergency(data)) return false;

    // 先记时间戳再调用：即使 API 抛异常，也不会下一 tick 再来一遍
    if (fw) fw.safeModeAt = now;
    mem.safeModeAt = now;

    const r = attempt(function () { return controller.activateSafeMode(); }, ERR_INVALID_TARGET);
    if (r === OK) {
        attempt(function () {
            console.log('[FW] ' + name + ' 紧急安全模式已激活 (tick ' + now + ', 敌人 ' + hostiles.length + ')');
        }, null);
        return true;
    }
    return false;
}

/* ------------------------------ 逃跑 ------------------------------ */

/**
 * 给逃跑中的 creep 找一个落点：优先朝 spawn（己方防御圈内），否则朝远离敌人的方向。
 * 返回 RoomPosition（或 null）。动作本身在调用方做，这里只算坐标。
 */
function chooseFleeTarget(room, data, creep, hostile, spawn) {
    const terrain = terrainOf(room);
    const cp = posOf(creep);
    const hp = posOf(hostile);
    if (!cp || !hp) return spawn ? posOf(spawn) : null;

    const dHostileNow = rangeTo(cp, hp);

    // 1) 经济单位：如果 spawn 比当前位置离敌人更远，就往 spawn 跑（塔/rampart 会护住它）
    if (spawn && ECONOMIC_ROLES[(creep.memory && creep.memory.role) || '']) {
        const sp = posOf(spawn);
        if (sp && rangeTo(sp, hp) > dHostileNow) {
            const dSpawn = rangeTo(cp, sp);
            // 已经贴到 spawn 就不用再挤了，留给"远离敌人"的逻辑
            if (dSpawn > 2) return makePos(room, sp.x, sp.y);
        }
    }

    // 2) 朝远离敌人的方向找落点：16 个方向 x 由远及近的距离，取"离敌人最远、离 spawn 最近"的
    const spawnPos = spawn ? posOf(spawn) : null;
    for (let step = 7; step >= 2; step--) {
        let best = null;
        let bestScore = -Infinity;
        for (let k = 0; k < 16; k++) {
            const angle = (k * Math.PI) / 8;
            const x = Math.round(cp.x + Math.cos(angle) * step);
            const y = Math.round(cp.y + Math.sin(angle) * step);
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (isWall(terrain, x, y)) continue;
            const dHostile = Math.max(Math.abs(x - hp.x), Math.abs(y - hp.y));
            if (dHostile <= dHostileNow) continue;
            let score = dHostile * 10;
            if (spawnPos) score -= Math.max(Math.abs(x - spawnPos.x), Math.abs(y - spawnPos.y));
            if (score > bestScore) {
                bestScore = score;
                best = { x: x, y: y };
            }
        }
        if (best) return makePos(room, best.x, best.y);
    }
    return null;
}

/**
 * 清掉一个 creep 的逃跑痕迹（只删小字段，不碰其它 memory）。
 */
function clearFleeMemory(creep) {
    return attempt(function () {
        const m = creep && creep.memory;
        if (!m) return null;
        delete m.fleeUntil;
        delete m.fleeFrom;
        delete m.fleeTarget;
        delete m.fleeTargetAt;
        if (m.task === 'fleeing') m.task = 'idle';
        return m;
    }, null);
}

/**
 * 逃跑：敌人在 FLEE_TRIGGER_RANGE 内就设定 fleeUntil，并朝安全方向移动。
 * 落点缓存在 creep.memory.fleeTarget（只存 {x,y}，不存对象），避免每 tick 重算。
 * 返回 { fleeing, started }。
 */
function fleeIfNeeded(room, data) {
    const result = { fleeing: 0, started: 0 };
    const creeps = (data && data.creeplist) || [];
    const hostiles = (data && data.hostiles) || [];
    if (!creeps.length) return result;

    const now = gameTime();
    const spawn = ((data && data.spawns) || [])[0] || null;

    // 房间里没敌人：只清理过期的逃跑痕迹，其余什么都不做
    // （否则 Memory 会一直留着 fleeUntil / fleeTarget，越积越多）
    if (!hostiles.length) {
        for (let i = 0; i < creeps.length; i++) {
            const creep = creeps[i];
            if (!creep || !creep.memory) continue;
            const m = creep.memory;
            if (!m.fleeUntil) continue;
            if (now < m.fleeUntil) continue;   // 还在逃跑期，等它自然结束
            clearFleeMemory(creep);
        }
        return result;
    }

    for (let i = 0; i < creeps.length; i++) {
        const creep = creeps[i];
        if (!isAliveCreep(creep)) continue;

        const mem = attempt(function () {
            if (!creep.memory) creep.memory = {};
            return creep.memory;
        }, null);
        if (!mem) continue;

        const nearest = nearestOf(creep, hostiles);
        const dist = nearest ? rangeTo(creep, nearest) : -1;
        const inDanger = dist >= 0 && dist <= FLEE_TRIGGER_RANGE;
        const stillFleeing = mem.fleeUntil && now < mem.fleeUntil;

        if (!inDanger && !stillFleeing) {
            // 威胁解除：清掉逃跑痕迹，避免 Memory 越积越多
            if (mem.fleeUntil) clearFleeMemory(creep);
            continue;
        }

        if (inDanger) {
            if (!stillFleeing) result.started++;
            mem.fleeUntil = now + FLEE_KEEP_TICKS;
            if (nearest && nearest.id) mem.fleeFrom = nearest.id;
        }
        result.fleeing++;
        if (mem.task !== 'fleeing') mem.task = 'fleeing';

        // 敌人：优先用视线内的最近敌人；只按 id 找回（Memory 里不存对象）
        let hostile = nearest;
        if (!hostile && mem.fleeFrom && typeof Game !== 'undefined' && Game.getObjectById) {
            hostile = attempt(function () { return Game.getObjectById(mem.fleeFrom); }, null);
        }
        if (!hostile) hostile = nearest;

        // 落点缓存：有效且没过期就复用
        let target = null;
        const cached = mem.fleeTarget;
        const cachedAt = mem.fleeTargetAt || 0;
        const cacheFresh = cached && typeof cached.x === 'number' && typeof cached.y === 'number'
            && now - cachedAt < FLEE_RETARGET_TICKS && rangeTo(creep, cached) > 1;
        if (cacheFresh) {
            target = makePos(room, cached.x, cached.y);
        } else if (hostile) {
            const spot = chooseFleeTarget(room, data, creep, hostile, spawn);
            target = spot;
            if (spot) {
                mem.fleeTarget = { x: spot.x, y: spot.y };
                mem.fleeTargetAt = now;
            }
        } else if (cached && typeof cached.x === 'number') {
            target = makePos(room, cached.x, cached.y);
        }

        if (target) {
            utils.moveTo(creep, target, { reusePath: 2, ignoreCreeps: true, maxRooms: 1, range: 0 });
        }
    }

    return result;
}

/**
 * 给 roles.js 用：这个 creep 本 tick 是否应该跳过正常行为（正在逃跑）。
 */
function isFleeing(creep) {
    if (!creep || !creep.memory) return false;
    const until = creep.memory.fleeUntil;
    return typeof until === 'number' && until > gameTime();
}

/* ------------------------------ 防御工事规划 ------------------------------ */

const NEIGHBORS = [
    { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
    { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];

function occupiedSet(room, data) {
    const set = {};
    const add = function (p) {
        if (p && typeof p.x === 'number' && typeof p.y === 'number') set[p.x + ',' + p.y] = true;
    };
    const structures = (data && data.structures) || [];
    for (let i = 0; i < structures.length; i++) add(structures[i] && structures[i].pos);
    const sites = (data && data.sites) || [];
    for (let i = 0; i < sites.length; i++) add(sites[i] && sites[i].pos);
    const sources = (data && data.sources) || [];
    for (let i = 0; i < sources.length; i++) add(sources[i] && sources[i].pos);
    if (data && data.mineral) add(data.mineral.pos);
    if (room && room.controller) add(room.controller.pos);
    return set;
}

/**
 * 房间"最开阔的出口方向"，用来判断敌人可能从哪边进来（只在没有敌人时用来做规划）。
 * 结果缓存在房间记忆里（地形不会变），避免每次扫描 4*16 格。
 */
function mainExitDir(room, data) {
    const cache = { x: 0, y: 0 };
    return attempt(function () {
        const terrain = terrainOf(room);
        if (!terrain) return cache;
        const counts = [0, 0, 0, 0]; // 上 下 左 右
        for (let i = 2; i < 48; i += 2) {
            if (terrain.get(i, 0) !== TERRAIN_MASK_WALL) counts[0]++;
            if (terrain.get(i, 49) !== TERRAIN_MASK_WALL) counts[1]++;
            if (terrain.get(0, i) !== TERRAIN_MASK_WALL) counts[2]++;
            if (terrain.get(49, i) !== TERRAIN_MASK_WALL) counts[3]++;
        }
        let best = 0;
        for (let i = 1; i < 4; i++) if (counts[i] > counts[best]) best = i;
        const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
        return dirs[best];
    }, cache);
}

/**
 * 统计本房已有的防御类工地数量（rampart / wall）。
 */
function countDefenseSites(sites) {
    let n = 0;
    for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        if (s && (s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL)) n++;
    }
    return n;
}

/**
 * 为 spawn / controller / tower 周围规划防御工事（rampart）。
 * 只有当 RCL>=3 且（有威胁历史 或 RCL>=5）时才做；每 tick 最多 1 个新工地，本模块共 2 个名额。
 * 返回 { planned, reason }。
 */
function planDefense(room, data) {
    const result = { planned: 0, reason: '' };
    const level = (data && data.level) || (room && room.controller ? room.controller.level : 0);
    if (!level) {
        result.reason = 'no-controller';
        return result;
    }
    if (level < 3) {
        result.reason = 'level<3';
        return result;
    }

    const name = (room && room.name) || 'unknown';
    const mem = defenseMemory(name);
    const now = gameTime();
    const hostiles = (data && data.hostiles) || [];
    const threatened = hostiles.length > 0
        || (mem.lastThreat && now - mem.lastThreat < THREAT_MEMORY_TICKS);
    if (!threatened && level < 5) {
        result.reason = 'no-threat';
        return result;
    }

    const sites = (data && data.sites) || [];
    const defSites = countDefenseSites(sites);
    if (defSites >= DEFENSE_SITE_CAP) {
        result.reason = 'defense-cap';
        return result;
    }
    // 让位给 Lead 的建造规划：本房工地已经很多时不加塞
    const siteLimit = level >= 4 ? config.maxSitesPerRoomHighRcl : config.maxSitesPerRoom;
    if (sites.length >= siteLimit) {
        result.reason = 'site-quota';
        return result;
    }
    // 每 tick 最多新建 1 个（本模块内部限流，与 Lead 的 maxNewSitesPerTick 无关）
    if (mem.lastSiteAt === now) {
        result.reason = 'per-tick-cap';
        return result;
    }

    // 敌人从哪边来；没有敌人就用房间最开阔的出口方向
    let approach = null;
    if (hostiles.length) {
        const target = nearestOf(room && room.controller ? room.controller.pos : null, hostiles) || hostiles[0];
        const tp = posOf(target);
        const center = room && room.controller ? room.controller.pos : null;
        if (tp && center) {
            const dx = tp.x - center.x;
            const dy = tp.y - center.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            approach = { x: dx / len, y: dy / len };
        }
    }
    if (!approach) {
        approach = attempt(function () {
            if (mem.exitDir && typeof mem.exitDir.x === 'number') return mem.exitDir;
            const dir = mainExitDir(room, data);
            mem.exitDir = { x: dir.x, y: dir.y };
            return dir;
        }, { x: 0, y: 0 });
    }

    const terrain = terrainOf(room);
    const occupied = occupiedSet(room, data);

    // 优先级：spawn → tower → controller（保住 spawn 最重要）
    const keys = [];
    const spawns = (data && data.spawns) || [];
    for (let i = 0; i < spawns.length; i++) if (spawns[i] && spawns[i].pos) keys.push(spawns[i].pos);
    const towers = (data && data.towers) || [];
    for (let i = 0; i < towers.length; i++) if (towers[i] && towers[i].pos) keys.push(towers[i].pos);
    if (room && room.controller && room.controller.pos) keys.push(room.controller.pos);

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < keys.length; i++) {
        const kp = keys[i];
        // spawn 优先级最高，用索引给它加权
        const priority = i < spawns.length ? 2 : 1;
        for (let j = 0; j < NEIGHBORS.length; j++) {
            const d = NEIGHBORS[j];
            const x = kp.x + d.x;
            const y = kp.y + d.y;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (occupied[x + ',' + y]) continue;
            if (isWall(terrain, x, y)) continue;
            // 朝向敌人/开阔出口的一侧优先
            const dot = d.x * approach.x + d.y * approach.y;
            const score = dot * 100 + priority * 10 - Math.abs(d.x) - Math.abs(d.y);
            if (score > bestScore) {
                bestScore = score;
                best = { x: x, y: y };
            }
        }
    }

    if (!best) {
        result.reason = 'no-spot';
        return result;
    }

    // rampart 比墙好：自己的 creep 能自由进出，敌人却吃攻击
    const type = (typeof STRUCTURE_RAMPART !== 'undefined') ? STRUCTURE_RAMPART : STRUCTURE_WALL;
    const r = attempt(function () { return room.createConstructionSite(best.x, best.y, type); }, ERR_INVALID_TARGET);
    if (r === OK) {
        result.planned = 1;
        result.reason = 'ok';
        mem.lastSiteAt = now;
        mem.siteCount = (mem.siteCount || 0) + 1;
        attempt(function () {
            console.log('[FW] ' + name + ' 防御工事: ' + type + ' @' + best.x + ',' + best.y);
        }, null);
        return result;
    }

    result.reason = 'create-failed-' + r;
    // 创建失败（位置被占/能量不够/上限）也记一下时间，避免同一 tick 反复尝试
    mem.lastSiteAt = now;
    return result;
}

/* ------------------------------ 记忆维护 ------------------------------ */

/**
 * 每 tick 更新威胁时间戳 + 清理过期房间记忆（避免 Memory 只增不减）。
 */
function trackRoom(room, data) {
    return attempt(function () {
        const name = room && room.name;
        if (!name) return null;
        const mem = defenseMemory(name);
        const now = gameTime();
        mem.lastSeen = now;
        if (data && data.hostiles && data.hostiles.length) mem.lastThreat = now;

        // 清理很久没见的房间（被放弃/丢失视线的房间）
        const fw = fwMemory();
        if (fw && fw.defense && fw.defense.rooms) {
            for (const key in fw.defense.rooms) {
                const entry = fw.defense.rooms[key];
                if (!entry || typeof entry !== 'object') continue;
                if (entry.lastSeen && now - entry.lastSeen > DEFENSE_MEM_TICKS) delete fw.defense.rooms[key];
            }
        }
        return mem;
    }, null);
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 每 tick 每间我方房间调用一次。
 * 返回汇总对象（只用于调试/统计，不参与决策）。
 */
function run(room, data) {
    const out = { towers: null, safeMode: false, flee: null, defense: null, error: null };
    try {
        if (!room) {
            out.error = 'no-room';
            return out;
        }
        let d = data;
        if (!d) {
            d = attempt(function () { return utils.roomData(room); }, null);
        }
        if (!d) {
            out.error = 'no-data';
            return out;
        }

        trackRoom(room, d);

        out.towers = runTowers(room, d);
        out.safeMode = activateSafeModeIfNeeded(room, d);
        out.flee = fleeIfNeeded(room, d);
        out.defense = planDefense(room, d);
        return out;
    } catch (e) {
        noteError(e);
        out.error = e && e.message ? String(e.message) : 'unknown';
        return out;
    }
}

module.exports = {
    runTowers,
    planDefense,
    fleeIfNeeded,
    activateSafeModeIfNeeded,
    run,
    isFleeing,
};

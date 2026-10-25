/**
 * fw.threat —— 防御层最底层：威胁认知 + 防御记忆 + 共享原语。
 *
 * 负责：
 *   1. 敌对 creep 的威胁分类：只有带 ATTACK / RANGED_ATTACK 的敌人才算"要躲的威胁"
 *      （纯 WORK 的拆家兵对 creep 没有杀伤力，为它停工是纯亏）。
 *   2. 危险等级判定 isEmergency、紧急安全模式 activateSafeModeIfNeeded。
 *   3. 房间防御记忆 Memory.fw.defense.rooms[name] 的读写、威胁时间戳更新与过期清理（trackRoom）。
 *   4. 防御层共用的"永不抛异常"约定（attempt / noteError）与距离/坐标小工具
 *      （posOf / rangeTo / terrainOf / isWall / makePos / nearestOf / nearestInRange）。
 *
 * 不该放进来：
 *   - 动作策略：塔怎么打/治/修（mgr.tower）、防御工事怎么规划（mgr.wall）、creep 往哪跑（mgr.flee）。
 *     本模块只回答"有没有威胁、威胁多大、记忆里记了什么"。
 *   - 任何位移：本模块绝不调用 moveTo / move。位移只由 mgr.flee 经 utils.moveTo（→ fw.nav）发起。
 *   - 新的策略阈值：可调参数一律写进 config，不要在这里加魔法数字。
 *
 * 分层：防御层单向依赖的最底端，不 require 任何 src 模块（只用 Screeps 全局）。
 */

/* ------------------------------ 常量 ------------------------------ */

// 安全模式最短重试间隔（安全模式本身有 500 tick 冷却，重复尝试只会刷屏）
const SAFE_MODE_COOLDOWN = 500;
// 威胁记忆时长：这么久内见过敌人就算"有威胁历史"
const THREAT_MEMORY_TICKS = 2000;
// 房间防御记忆的保留时长
const DEFENSE_MEM_TICKS = 10000;
// 错误记录的最小间隔（同一时段只留一条，防止 Memory 膨胀）
const ERROR_MIN_GAP = 200;

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
 *   { lastThreat, lastSeen, safeModeAt, exitDir:{x,y}, lastSiteAt, siteCount }
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

/* ------------------------------ 威胁分类 ------------------------------ */

/**
 * 这个敌对 creep 是否带杀伤力（ATTACK / RANGED_ATTACK）。
 * 没有 body 的（mock 里的简化对象）一律按"无杀伤力"处理。
 */
function hasDamageBody(creep) {
    if (!creep || !creep.body) return false;
    for (let i = 0; i < creep.body.length; i++) {
        const t = creep.body[i].type;
        if (t === ATTACK || t === RANGED_ATTACK) return true;
    }
    return false;
}

/**
 * 从房间的敌对里筛出"需要躲"的那部分。
 * 纯 WORK 的拆家兵对 creep 没有任何威胁 —— 为它停工是纯亏（线上就踩过这个坑）。
 */
function dangerousHostiles(hostiles) {
    const out = [];
    const list = hostiles || [];
    for (let i = 0; i < list.length; i++) {
        if (hasDamageBody(list[i])) out.push(list[i]);
    }
    return out;
}

/* ------------------------------ 危险等级 / 紧急安全模式 ------------------------------ */

/**
 * 危险等级：满足任一条件即为紧急
 *   - 任一 spawn 血量 < 50%
 *   - 敌人数量 >= 3
 *   - 任一我方 creep 血量 < 50%
 * 是否"有敌人"由调用方（activateSafeModeIfNeeded）先判断。
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

module.exports = {
    // 常量（上层判门槛用）
    SAFE_MODE_COOLDOWN,
    THREAT_MEMORY_TICKS,
    // 记忆 / 错误
    gameTime,
    fwMemory,
    defenseMemory,
    noteError,
    attempt,
    // 几何与通用小工具
    posOf,
    rangeTo,
    terrainOf,
    isWall,
    makePos,
    nearestInRange,
    nearestOf,
    isAliveCreep,
    // 威胁认知
    hasDamageBody,
    dangerousHostiles,
    isEmergency,
    activateSafeModeIfNeeded,
    trackRoom,
};

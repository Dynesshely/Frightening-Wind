/**
 * mgr.flee —— 撤退决策：谁该跑、跑到哪、什么时候解除。
 *
 * 负责：
 *   1. 只有"带 ATTACK / RANGED_ATTACK 的敌人"才触发撤退（分类在 fw.threat.dangerousHostiles，
 *      纯 WORK 的拆家兵不值得停工）；
 *   2. fleeUntil 状态机：敌人进入 FLEE_TRIGGER_RANGE 就进入逃跑并保持 FLEE_KEEP_TICKS，
 *      威胁解除后清理 creep.memory 里的逃跑痕迹；
 *   3. 落点选择 chooseFleeTarget：经济角色优先躲向 spawn，否则朝远离敌人的方向找点；
 *      落点缓存在 creep.memory.fleeTarget（只存 {x,y}），FLEE_RETARGET_TICKS 内复用；
 *   4. 给 roles 用的 isFleeing(creep)。
 *
 * 不该放进来：
 *   - 位移实现：本模块只算"去哪"，实际移动必须调用 utils.moveTo（委托 fw.nav）。
 *     **绝对不要写 creep.moveTo / creep.move** —— 全库位移只允许经过 fw.nav。
 *   - 塔/城墙（mgr.tower / mgr.wall）、威胁等级与安全模式（fw.threat）。
 */

const utils = require('utils');
const threat = require('fw.threat');

/* ------------------------------ 常量 ------------------------------ */

// 敌人在该距离内就触发逃跑
const FLEE_TRIGGER_RANGE = 4;
// 逃跑状态至少保持的 tick 数（避免"敌人退一步就立刻回去送死"的抖动）
const FLEE_KEEP_TICKS = 8;
// 逃跑落点的重算间隔
const FLEE_RETARGET_TICKS = 4;

// 跑向 spawn 的经济角色（它们没有战斗力，且 spawn 周围有塔覆盖）
const ECONOMIC_ROLES = { harvester: true, miner: true, hauler: true, builder: true, upgrader: true };

/* ------------------------------ 落点选择 ------------------------------ */

/**
 * 给逃跑中的 creep 找一个落点：优先朝 spawn（己方防御圈内），否则朝远离敌人的方向。
 * 返回 RoomPosition（或 null）。动作本身在调用方做，这里只算坐标。
 */
function chooseFleeTarget(room, data, creep, hostile, spawn) {
    const terrain = threat.terrainOf(room);
    const cp = threat.posOf(creep);
    const hp = threat.posOf(hostile);
    if (!cp || !hp) return spawn ? threat.posOf(spawn) : null;

    const dHostileNow = threat.rangeTo(cp, hp);

    // 1) 经济单位：如果 spawn 比当前位置离敌人更远，就往 spawn 跑（塔/rampart 会护住它）
    if (spawn && ECONOMIC_ROLES[(creep.memory && creep.memory.role) || '']) {
        const sp = threat.posOf(spawn);
        if (sp && threat.rangeTo(sp, hp) > dHostileNow) {
            const dSpawn = threat.rangeTo(cp, sp);
            // 已经贴到 spawn 就不用再挤了，留给"远离敌人"的逻辑
            if (dSpawn > 2) return threat.makePos(room, sp.x, sp.y);
        }
    }

    // 2) 朝远离敌人的方向找落点：距离由远及近（7 → 2），
    //    每一圈 16 个方向里取"离敌人最远、离 spawn 最近"的那个
    const spawnPos = spawn ? threat.posOf(spawn) : null;
    for (let step = 7; step >= 2; step--) {
        let best = null;
        let bestScore = -Infinity;
        for (let k = 0; k < 16; k++) {
            const angle = (k * Math.PI) / 8;
            const x = Math.round(cp.x + Math.cos(angle) * step);
            const y = Math.round(cp.y + Math.sin(angle) * step);
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (threat.isWall(terrain, x, y)) continue;
            const dHostile = Math.max(Math.abs(x - hp.x), Math.abs(y - hp.y));
            if (dHostile <= dHostileNow) continue;
            let score = dHostile * 10;
            if (spawnPos) score -= Math.max(Math.abs(x - spawnPos.x), Math.abs(y - spawnPos.y));
            if (score > bestScore) {
                bestScore = score;
                best = { x: x, y: y };
            }
        }
        if (best) return threat.makePos(room, best.x, best.y);
    }
    return null;
}

/**
 * 清掉一个 creep 的逃跑痕迹（只删小字段，不碰其它 memory）。
 */
function clearFleeMemory(creep) {
    return threat.attempt(function () {
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

/* ------------------------------ 撤退入口 ------------------------------ */

/**
 * 逃跑：敌人在 FLEE_TRIGGER_RANGE 内就设定 fleeUntil，并朝安全方向移动。
 * 落点缓存在 creep.memory.fleeTarget（只存 {x,y}，不存对象），避免每 tick 重算。
 * 返回 { fleeing, started }。
 */
function fleeIfNeeded(room, data) {
    const result = { fleeing: 0, started: 0 };
    const creeps = (data && data.creeplist) || [];
    const allHostiles = (data && data.hostiles) || [];

    // 只有带 ATTACK/RANGED_ATTACK 的敌人才需要逃（分类逻辑集中在 fw.threat）
    const hostiles = threat.dangerousHostiles(allHostiles);
    if (!creeps.length) return result;

    const now = threat.gameTime();
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
        if (!threat.isAliveCreep(creep)) continue;

        const mem = threat.attempt(function () {
            if (!creep.memory) creep.memory = {};
            return creep.memory;
        }, null);
        if (!mem) continue;

        const nearest = threat.nearestOf(creep, hostiles);
        const dist = nearest ? threat.rangeTo(creep, nearest) : -1;
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
            hostile = threat.attempt(function () { return Game.getObjectById(mem.fleeFrom); }, null);
        }
        if (!hostile) hostile = nearest;

        // 落点缓存：有效且没过期就复用
        let target = null;
        const cached = mem.fleeTarget;
        const cachedAt = mem.fleeTargetAt || 0;
        const cacheFresh = cached && typeof cached.x === 'number' && typeof cached.y === 'number'
            && now - cachedAt < FLEE_RETARGET_TICKS && threat.rangeTo(creep, cached) > 1;
        if (cacheFresh) {
            target = threat.makePos(room, cached.x, cached.y);
        } else if (hostile) {
            const spot = chooseFleeTarget(room, data, creep, hostile, spawn);
            target = spot;
            if (spot) {
                mem.fleeTarget = { x: spot.x, y: spot.y };
                mem.fleeTargetAt = now;
            }
        } else if (cached && typeof cached.x === 'number') {
            target = threat.makePos(room, cached.x, cached.y);
        }

        if (target) {
            // 唯一的位移入口：utils.moveTo → fw.nav.moveTo（意图模型 + 出口格锁定）
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
    return typeof until === 'number' && until > threat.gameTime();
}

module.exports = {
    fleeIfNeeded,
    isFleeing,
    // 暴露给测试/诊断用，不参与对外门面
    chooseFleeTarget,
    clearFleeMemory,
};

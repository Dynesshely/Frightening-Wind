/**
 * mgr.wall —— 防御工事（rampart / wall 工地）的规划与维护优先级。
 *
 * 负责：
 *   1. planDefense 的全部前置门槛：RCL、威胁历史（Memory 里的 lastThreat）、
 *      本房防御工地配额（DEFENSE_SITE_CAP）、Lead 的总工地配额（config.maxSitesPerRoom*）、
 *      每 tick 最多 1 个工地的内部限流；
 *   2. 敌人来袭方向估算（没有敌人时退回房间"最开阔出口"）、候选格打分
 *      （朝向来敌 > spawn/tower/controller 由近及远 > 不被占用 > 不是地形墙）；
 *   3. createConstructionSite 的调用与失败记录。
 *
 * 不该放进来：
 *   - 塔的火力/维修分配（mgr.tower）；
 *   - creep 撤退与落点选择（mgr.flee）；
 *   - 既有 rampart / wall 的**血量维护阈值**：本模块只规划"新工地"，不决定修墙血量
 *     （那是 Lead 的 rampart 维护策略）；
 *   - 任何移动：本模块不移动 creep，也不允许出现 moveTo / move。
 *
 * 依赖：config（配额/阈值）、fw.threat（记忆与几何原语）。单向，不 require 门面 defense。
 */

const config = require('config');
const threat = require('fw.threat');

/* ------------------------------ 常量 ------------------------------ */

// 防御模块自己占用的工地配额上限（Lead 的总配额由 config.maxSitesPerRoom 控制）
const DEFENSE_SITE_CAP = 2;

const NEIGHBORS = [
    { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
    { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];

/* ------------------------------ 规划辅助 ------------------------------ */

/**
 * 收集"已被占用"的格子：结构 / 工地 / 矿源 / 矿物 / controller。
 * 只在规划期使用，返回普通对象（key = "x,y"），方便 O(1) 查询。
 */
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
 * 注意：本函数自己不做缓存 —— 调用方（planDefense）把结果写进房间记忆 mem.exitDir，
 * 地形不会变，所以只需算一次，避免每 tick 扫描 4*16 格。
 */
function mainExitDir(room, data) {
    const cache = { x: 0, y: 0 };
    return threat.attempt(function () {
        const terrain = threat.terrainOf(room);
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

/* ------------------------------ 规划入口 ------------------------------ */

/**
 * 为 spawn / tower / controller 周围规划防御工事（rampart）。
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
    const mem = threat.defenseMemory(name);
    const now = threat.gameTime();
    const hostiles = (data && data.hostiles) || [];
    const threatened = hostiles.length > 0
        || (mem.lastThreat && now - mem.lastThreat < threat.THREAT_MEMORY_TICKS);
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
        const target = threat.nearestOf(room && room.controller ? room.controller.pos : null, hostiles) || hostiles[0];
        const tp = threat.posOf(target);
        const center = room && room.controller ? room.controller.pos : null;
        if (tp && center) {
            const dx = tp.x - center.x;
            const dy = tp.y - center.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            approach = { x: dx / len, y: dy / len };
        }
    }
    if (!approach) {
        approach = threat.attempt(function () {
            if (mem.exitDir && typeof mem.exitDir.x === 'number') return mem.exitDir;
            const dir = mainExitDir(room, data);
            mem.exitDir = { x: dir.x, y: dir.y };
            return dir;
        }, { x: 0, y: 0 });
    }

    const terrain = threat.terrainOf(room);
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
            if (threat.isWall(terrain, x, y)) continue;
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
    const r = threat.attempt(function () { return room.createConstructionSite(best.x, best.y, type); }, ERR_INVALID_TARGET);
    if (r === OK) {
        result.planned = 1;
        result.reason = 'ok';
        mem.lastSiteAt = now;
        mem.siteCount = (mem.siteCount || 0) + 1;
        threat.attempt(function () {
            console.log('[FW] ' + name + ' 防御工事: ' + type + ' @' + best.x + ',' + best.y);
        }, null);
        return result;
    }

    result.reason = 'create-failed-' + r;
    // 创建失败（位置被占/能量不够/上限）也记一下时间，避免同一 tick 反复尝试
    mem.lastSiteAt = now;
    return result;
}

module.exports = {
    planDefense,
    // 暴露给测试/诊断用，不参与对外门面
    occupiedSet,
    mainExitDir,
    countDefenseSites,
};

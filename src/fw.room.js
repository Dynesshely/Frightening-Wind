/**
 * fw.room —— 房间快照与态势（只读）。
 *
 * 负责：
 *   1. roomData：每 tick 每个房间只做一次 find，缓存成房间快照
 *      （全局 __fwCache，按 Game.time 失效，所以"每 tick 只算一次"的行为是结构性的）；
 *   2. findSafe：老版本服务器缺少某些 FIND_* 常量时的安全查找；
 *   3. classifyHostiles：把敌对 creep 按"有杀伤力 / 只会拆建筑 / 无威胁"分三档，
 *      只读 body 组成，不做任何应对决策。
 *      注意与 fw.threat 的分工：fw.threat 是防御侧的威胁评估（射程 / 血量 / 安全模式），
 *      本函数只回答「这只敌对单位算什么类型」，两者互不依赖。
 *
 * 不该放进来：
 *   - 任何写操作（交付、建造、移动）—— 分别属于 fw.store / fw.build / fw.nav；
 *   - 跨 tick 的业务记忆（Memory.fw.*）与配额判断 —— 快照只活一个 tick；
 *   - 地形几何判定（fw.geo）。
 *
 * 依赖：config。不依赖 utils（避免循环 require）。
 */
const config = require('config');

/* ------------------------------ 缓存 ------------------------------ */

function tickCache() {
    if (!global.__fwCache) global.__fwCache = { tick: -1, rooms: {} };
    const c = global.__fwCache;
    if (c.tick !== Game.time) {
        c.tick = Game.time;
        c.rooms = {};
    }
    return c;
}

/**
 * 老版本服务器缺少某些 FIND_* 常量时安全返回空数组
 */
function findSafe(room, type) {
    if (type === null || type === undefined) return [];
    try {
        return room.find(type);
    } catch (e) {
        return [];
    }
}

/**
 * 每 tick 每个房间只做一次 find，得到房间快照
 */
function roomData(room) {
    const cache = tickCache();
    let d = cache.rooms[room.name];
    if (d) return d;

    d = {
        room: room,
        level: room.controller ? room.controller.level : 0,
        sources: room.find(FIND_SOURCES),
        mineral: findSafe(room, typeof FIND_MINERALS !== 'undefined' ? FIND_MINERALS : null)[0] || null,
        spawns: room.find(FIND_MY_SPAWNS),
        structures: room.find(FIND_MY_STRUCTURES),
        allStructures: findSafe(room, FIND_STRUCTURES),
        sites: room.find(FIND_CONSTRUCTION_SITES),
        sitesMine: [],
        creeplist: room.find(FIND_MY_CREEPS),
        hostiles: room.find(FIND_HOSTILE_CREEPS),
        dropped: findSafe(room, typeof FIND_DROPPED_RESOURCES !== 'undefined' ? FIND_DROPPED_RESOURCES : null),
        tombstones: findSafe(room, typeof FIND_TOMBSTONES !== 'undefined' ? FIND_TOMBSTONES : null),
        ruins: findSafe(room, typeof FIND_RUINS !== 'undefined' ? FIND_RUINS : null),
    };
    d.sitesMine = d.sites;
    d.extensions = d.structures.filter(s => s.structureType === STRUCTURE_EXTENSION);
    d.towers = d.structures.filter(s => s.structureType === STRUCTURE_TOWER);
    d.storage = d.structures.filter(s => s.structureType === STRUCTURE_STORAGE)[0] || null;

    // 容器 / 道路 / 墙 / rampart 属于中立结构，不在 FIND_MY_STRUCTURES 里
    d.containers = d.allStructures.filter(s => s.structureType === STRUCTURE_CONTAINER);
    d.roads = d.allStructures.filter(s => s.structureType === STRUCTURE_ROAD);
    d.links = d.allStructures.filter(s => s.structureType === STRUCTURE_LINK);
    d.walls = d.allStructures.filter(s => s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART);
    d.damageable = d.structures.concat(d.containers, d.roads);
    d.spawnList = d.spawns;

    // 按角色统计本房 creep；顺带记录"快死了的"和"正在孵化的"
    d.creepsByRole = {};
    d.ownedByRole = {};
    // 归属本房间的 creep（包含正在外地巡逻/侦查/采矿的），用于配额判断
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c.memory || c.memory.home !== room.name) continue;
        const r = c.memory.role || 'unknown';
        d.ownedByRole[r] = (d.ownedByRole[r] || 0) + 1;
    }
    d.leavingByRole = {};
    d.spawningByRole = {};
    for (const c of d.creeplist) {
        const r = (c.memory && c.memory.role) || 'unknown';
        d.creepsByRole[r] = (d.creepsByRole[r] || 0) + 1;
        if (c.spawning) {
            d.spawningByRole[r] = (d.spawningByRole[r] || 0) + 1;
        } else if (typeof c.ticksToLive === 'number' && c.ticksToLive < config.replaceTtl) {
            d.leavingByRole[r] = (d.leavingByRole[r] || 0) + 1;
        }
    }

    cache.rooms[room.name] = d;
    return d;
}

/* ------------------------------ 态势 ------------------------------ */

/**
 * 把敌对 creep 分成"有杀伤力 / 只会拆建筑 / 无威胁"三类。
 * 逃跑与反击的决策都依赖这个分类：只有 damage 型才值得撤退。
 */
function classifyHostiles(hostiles) {
    const out = { all: hostiles || [], damage: [], structure: [], harmless: [] };
    const list = out.all;
    for (let i = 0; i < list.length; i++) {
        const h = list[i];
        let dmg = false;
        let work = false;
        if (h && h.body) {
            for (let j = 0; j < h.body.length; j++) {
                const t = h.body[j].type;
                if (t === ATTACK || t === RANGED_ATTACK) dmg = true;
                else if (t === WORK) work = true;
            }
        }
        if (dmg) out.damage.push(h);
        else if (work) out.structure.push(h);
        else out.harmless.push(h);
    }
    return out;
}

module.exports = { roomData, classifyHostiles };

/**
 * role.patrol —— 边防巡逻兵 & 关键节点清障原语
 *
 * 本模块负责：
 *   - patrolRoute()：相邻房间打分（无主 + 矿源 + 有敌）后的巡逻路线，缓存 500 tick；
 *   - patroller()：回防 → 补血 → 交战 → 按路线逐房间推进，到房内驻留巡逻；
 *   - keyNodes() / firstBlocker()：哪些关键节点（spawn / 容器 / 控制器 / 矿源）的四邻必须通畅、
 *     以及某个方向上第一个"该拆的阻塞建筑"（地形感知）；
 *   - roadKeeper()：关键节点定时维保（当前未接入 BEHAVIORS，按原样保留）。
 *
 * 不该放进来：打谁的战力分级与清场（role.soldier）、情报目标挑选（role.scout / role.recon）、
 * 新房间建设（role.pioneer）。本模块不 require 任何其它角色模块，保证依赖单向。
 * 所有位移必须走 utils.moveTo / utils.moveToRoom（→ fw.nav），禁止直接 creep.moveTo。
 */
const config = require('config');
const utils = require('utils');

/**
 * 顺手清障：作业半径 3 格内发现不可通行的建筑就拆掉。
 * 取代专职"道路保障员"编制——不额外占人口，干活路上顺带把路清出来。
 */
const WALKABLE_TYPES = (function () {
    const m = {};
    m[STRUCTURE_ROAD] = true;
    m[STRUCTURE_CONTAINER] = true;
    m[STRUCTURE_RAMPART] = true;
    return m;
})();

/** 关键节点：spawn / 容器 / 控制器 / 矿源 —— 四邻必须通畅 */
function keyNodes(room) {
    const nodes = [];
    // spawn：正交四向要深查到 3 格（基地主通道，最容易被扩展堵死）
    try { for (const s of room.find(FIND_MY_SPAWNS)) nodes.push({ pos: s.pos, deep: 3 }); } catch (e) { }
    try {
        for (const s of room.find(FIND_STRUCTURES)) {
            if (s.structureType === STRUCTURE_CONTAINER) nodes.push({ pos: s.pos, deep: 1 });
        }
    } catch (e) { }
    if (room.controller) nodes.push({ pos: room.controller.pos, deep: 1 });
    try { for (const s of room.find(FIND_SOURCES)) nodes.push({ pos: s.pos, deep: 1 }); } catch (e) { }
    return nodes;
}

/**
 * 找出"必须清掉"的阻塞结构（地形感知）：
 * 沿上下左右四个方向逐格看，一旦遇到地形墙 → 该方向被山挡住，不再要求通畅，直接放弃这个方向；
 * 遇到可走结构（路/容器/rampart）→ 继续往里看；遇到不可走的建筑 → 就是它，要拆掉。
 */
function firstBlocker(room, node, deep) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const terrain = room.getTerrain();
    for (let j = 0; j < dirs.length; j++) {
        for (let step = 1; step <= deep; step++) {
            const x = node.x + dirs[j][0] * step;
            const y = node.y + dirs[j][1] * step;
            if (x < 1 || x > 48 || y < 1 || y > 48) break;
            // 山体：这个方向地形上本来就过不去，不用管
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) break;
            let found = [];
            try { found = room.lookForAt(LOOK_STRUCTURES, x, y) || []; } catch (e) { found = []; }
            if (!found.length) continue;
            const st = found[0];
            if (WALKABLE_TYPES[st.structureType]) continue;
            if (st.structureType === STRUCTURE_SPAWN) continue;
            if (st.structureType === STRUCTURE_WALL) continue;
            return st;
        }
    }
    return null;
}

/**
 * 道路通畅维保员：定时巡检关键节点，四邻里只要有"可破坏的阻塞结构"就拆掉。
 * 房间边界/地形墙不可破坏 -> 不管。
 * （注：当前没有任何 BEHAVIORS 条目引用它，按原实现原样保留。）
 */
function roadKeeper(creep, data) {
    const room = creep.room;
    const nodes = keyNodes(room);

    for (let i = 0; i < nodes.length; i++) {
        const st = firstBlocker(room, nodes[i].pos, nodes[i].deep || 1);
        if (st) {
            utils.say(creep, '🚧');
            const r = creep.dismantle(st);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, st);
            return;
        }
    }

    utils.say(creep, '✅');
    const sp = data.spawns && data.spawns[0];
    if (sp && creep.pos.getRangeTo(sp) > 3) utils.moveTo(creep, sp, { range: 3 });
}

/** 粗略战力：ATTACK 记 1，RANGED_ATTACK 记 2（只用于"打不打得过"的粗判） */
function attackParts(creep) {
    let n = 0;
    for (const p of creep.body) {
        if (p.type === ATTACK) n++;
        else if (p.type === RANGED_ATTACK) n += 2;
    }
    return n;
}

/**
 * 巡逻路线：相邻房间，优先"无主 + 矿源多"的（那些是我们准备占的地盘）
 */
function patrolRoute(home) {
    if (!Memory.fw) Memory.fw = {};
    const cached = Memory.fw.patrolRoute;
    if (cached && Game.time - cached.t < 500 && cached.rooms && cached.rooms.length && cached.home === home) {
        return cached.rooms;
    }
    let exits = {};
    try {
        exits = Game.map.describeExits(home) || {};
    } catch (e) {
        exits = {};
    }
    const rooms = [];
    for (const dir in exits) {
        const name = exits[dir];
        if (!name || name === home) continue;
        const info = utils.getIntel(name);
        let score = 0;
        if (info) {
            if (info.controller && !info.controller.owner) score += 10;
            score += Math.min(6, (info.sources || []).length * 3);
            if (info.hostiles > 0) score += 5;   // 有敌人的更要去看看
        }
        rooms.push({ name: name, score: score });
    }
    rooms.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : 1));   // 次级键稳定顺序
    const list = rooms.slice(0, config.patrolRooms).map(r => r.name);
    Memory.fw.patrolRoute = { t: Game.time, home: home, rooms: list };
    return list;
}

/**
 * 边防巡逻兵：
 *  - 老家有敌人 -> 立刻回防
 *  - 所在房间有敌人 -> 评估战力后交战（打不过就撤）
 *  - 血量低 -> 回老家塔下治疗
 *  - 否则按路线逐房间巡逻，每间驻留 patrolStayTicks 扫荡
 */
function patroller(creep, data) {
    const home = creep.memory.home || creep.room.name;
    const hostiles = data.hostiles || [];

    // 1) 老家被袭：优先回防
    const homeHostiles = (creep.room.name === home) ? hostiles : [];
    if (creep.room.name !== home) {
        const homeInfo = null;
        // 用 Memory 里记录的"老家有敌人"信号（由 soldier / defense 写入）
        if (Memory.fw && Memory.fw.homeUnderAttack && Memory.fw.homeUnderAttack === home) {
            utils.say(creep, '🏠');
            utils.moveToRoom(creep, home);
            return;
        }
    }

    // 2) 血量不健康：回老家塔下补血
    if (creep.hits < creep.hitsMax * config.patrolHealRatio) {
        utils.say(creep, '🩹');
        if (creep.room.name !== home) {
            utils.moveToRoom(creep, home);
        } else if (data.spawns[0]) {
            utils.moveTo(creep, data.spawns[0], { range: 3 });
        }
        return;
    }

    // 3) 当前房间有敌人：打
    if (hostiles.length) {
        let target = null;
        let bestDist = 999;
        for (const h of hostiles) {
            const d = creep.pos.getRangeTo(h);
            if (d < bestDist) { bestDist = d; target = h; }
        }
        if (target) {
            const mine = attackParts(creep);
            const theirs = attackParts(target);
            // 打不过（对方火力是我们的 2 倍以上）就撤回老家，别送
            if (theirs > mine * 2 + 1) {
                utils.say(creep, '🏃');
                if (creep.room.name !== home) utils.moveToRoom(creep, home);
                else if (data.spawns[0]) utils.moveTo(creep, data.spawns[0], { range: 3 });
                if (Memory.fw) Memory.fw.threatSeen = Game.time;
                return;
            }
            utils.say(creep, '⚔');
            const r = creep.attack(target);
            if (r === ERR_NOT_IN_RANGE) utils.moveTo(creep, target);
            if (Memory.fw) Memory.fw.threatSeen = Game.time;
            return;
        }
    }

    const route = patrolRoute(home);
    // 扇区只作为【起始偏移】，不随人口变化重新切片。
    // （旧实现按 patrolSquad 取模切片，人手一变目标房间就整组换掉，导致在边境掉头）
    if (!route.length) {
        // 没有相邻房间可巡逻：在老家门口待命
        if (data.spawns[0] && creep.pos.getRangeTo(data.spawns[0]) > 3) {
            utils.moveTo(creep, data.spawns[0], { range: 3 });
        }
        return;
    }

    // 4) 巡逻推进（目标锁定：到达并驻留足够才换下一个）
    if (creep.memory.patrolIndex === undefined) {
        // 用名字做稳定散列：不同巡逻兵从不同起点出发，且永远不变（不会因人口变化重排）
        let h = 0;
        for (let i = 0; i < creep.name.length; i++) h = (h * 31 + creep.name.charCodeAt(i)) % 9973;
        creep.memory.patrolIndex = h % route.length;
    }
    const idx = creep.memory.patrolIndex % route.length;
    const targetRoom = route[idx];

    if (creep.room.name !== targetRoom) {
        // 迷路保护：出发 200 tick 还没到目标就换下一个，避免在一个目标上死磕
        if (!creep.memory.patrolSince) creep.memory.patrolSince = Game.time;
        if (Game.time - creep.memory.patrolSince > 200) {
            creep.memory.patrolIndex = (idx + 1) % route.length;
            creep.memory.patrolSince = Game.time;
            return;
        }
        utils.say(creep, '➡');
        utils.moveToRoom(creep, targetRoom);
        return;
    }
    // 关键：必须走到房间内部才算"到达"。
    // 否则会刚跨过边界就被判为到达，驻留几十 tick 后又折返——看起来就是在边境来回穿梭。
    const distToCenter = creep.pos.getRangeTo(new RoomPosition(25, 25, creep.room.name));
    if (creep.memory.patrolEntered !== creep.room.name) {
        if (distToCenter > 12) {
            utils.say(creep, '➡');
            // 必须走 utils.moveTo（→ fw.nav）：所有位移都要经过导航层，
            // 否则导航层的停滞检测拿不到真实位置，会误判成"卡住"并乱换出口。
            utils.moveTo(creep, new RoomPosition(25, 25, creep.room.name));
            return;
        }
        creep.memory.patrolEntered = creep.room.name;
        creep.memory.patrolSince = Game.time;
    }

    // 已在目标房间：驻留扫荡（在房间内部做矩形巡游，不要贴着边界晃）
    creep.memory.patrolSince = creep.memory.patrolSince || Game.time;
    if (Game.time - creep.memory.patrolSince < config.patrolStayTicks) {
        utils.say(creep, '👁');
        const WAYPOINTS = [[16, 16], [33, 16], [33, 33], [16, 33]];
        const wp = creep.memory.patrolWp || 0;
        const target = WAYPOINTS[wp % WAYPOINTS.length];
        const rp = new RoomPosition(target[0], target[1], creep.room.name);
        if (creep.pos.getRangeTo(rp) <= 3) {
            creep.memory.patrolWp = (wp + 1) % WAYPOINTS.length;
        } else {
            utils.moveTo(creep, rp, { range: 3 });
        }
        return;
    }

    // 驻留结束：去下一个房间
    creep.memory.patrolIndex = (idx + 1) % route.length;
    creep.memory.patrolSince = Game.time;
    creep.memory.patrolEntered = undefined;
    utils.moveToRoom(creep, route[creep.memory.patrolIndex]);
}

module.exports = {
    keyNodes: keyNodes,
    firstBlocker: firstBlocker,
    roadKeeper: roadKeeper,
    patrolRoute: patrolRoute,
    patroller: patroller,
};

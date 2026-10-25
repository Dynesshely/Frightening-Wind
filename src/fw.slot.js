/** 采集站位：可用格计算、独占分配、远程容器探位 */



function walkableOnContainer(room, x, y) {
    try {
        for (const s of room.lookForAt(LOOK_STRUCTURES, x, y)) {
            if (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD) return true;
        }
    } catch (e) { }
    return false;
}

/** 矿源 8 邻格里"可站人"的格子列表 */

function slotList(source) {
    const room = source.room;
    if (!room) return [];
    const terrain = room.getTerrain();
    const out = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            let blocked = false;
            try {
                for (const s of room.lookForAt(LOOK_STRUCTURES, x, y)) {
                    if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART) blocked = true;
                }
            } catch (e) { }
            if (!blocked) out.push({ x: x, y: y, onContainer: walkableOnContainer(room, x, y) });
        }
    }
    return out;
}

/**
 * 给矿工分配一个"独占站位"：同一矿源的矿工各站一格，永不抢位。
 * 站位表存在 Memory.fw.slotOf[sourceId] = { "x,y": creepName }
 */
/** 站位是否真的走得到（绕路允许，被地形隔死不允许），结果缓存 5000 tick */

function slotReachable(room, slot) {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.slotPath) Memory.fw.slotPath = {};
    const key = room.name + ':' + slot.x + ',' + slot.y;
    const cached = Memory.fw.slotPath[key];
    if (cached && (Game.time - cached.t) < 5000) return !!cached.ok;
    let ok = true;
    try {
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        const from = spawn ? spawn.pos : null;
        if (from && (from.x !== slot.x || from.y !== slot.y)) {
            const path = room.findPath(from, new RoomPosition(slot.x, slot.y, room.name), { ignoreCreeps: true });
            ok = !!(path && path.length > 0);
        }
    } catch (e) {
        ok = true;
    }
    Memory.fw.slotPath[key] = { ok: ok, t: Game.time };
    return ok;
}


function ensureSlot(creep, source) {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.slotOf) Memory.fw.slotOf = {};
    const key = source.id;
    const table = Memory.fw.slotOf[key] || (Memory.fw.slotOf[key] = {});
    // 清理失效占位：只有 miner 能占位，死掉的/转职的立即释放
    for (const k in table) {
        const owner = Game.creeps[table[k]];
        if (!owner || !owner.memory || owner.memory.role !== 'miner') delete table[k];
    }
    // 只保留真正走得到的站位：绕一点路可以，被山隔死不行
    let slots = slotList(source);
    const reachable = [];
    for (const s of slots) { if (slotReachable(creep.room, s)) reachable.push(s); }
    if (reachable.length) slots = reachable;
    // 优先不压容器/道路的空地（容器口留给搬运工，避免互相堵死）
    const clean = [];
    for (const s of slots) if (!s.onContainer) clean.push(s);
    if (clean.length) slots = clean;
    if (!slots.length) return null;

    // 已经占好且仍然有效
    if (creep.memory.mineSlot) {
        const k = creep.memory.mineSlot.x + ',' + creep.memory.mineSlot.y;
        if (table[k] === creep.name || table[k] === undefined) { table[k] = creep.name; return creep.memory.mineSlot; }
        creep.memory.mineSlot = undefined;
    }
    // 找一格没被活人占的
    for (const s of slots) {
        const k = s.x + ',' + s.y;
        const owner = table[k];
        if (owner && Game.creeps[owner]) continue;
        table[k] = creep.name;
        creep.memory.mineSlot = { x: s.x, y: s.y };
        return creep.memory.mineSlot;
    }
    return slots[0];
}

/**
 * 威胁分级：按"能力"而不是"存在"来决定响应。
 *   damage    - 有 ATTACK/RANGED_ATTACK：会杀单位，最危险
 *   structure - 只有 WORK：拆建筑（拆迁兵），对单位无威胁但对基建致命
 *   harmless  - 其它（纯搬运/纯移动/侦察兵）：可以无视
 */

function harvestSlots(source) {
    const room = source.room;
    if (!room) return 1;
    const terrain = room.getTerrain();
    let slots = 0;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            let blocked = false;
            try {
                const found = room.lookForAt(LOOK_STRUCTURES, x, y);
                for (const s of found) {
                    // 路/容器/rampart 能站人，其它结构挡位
                    if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART) blocked = true;
                }
            } catch (e) { }
            if (!blocked) slots++;
        }
    }
    return slots;
}

/** 远程矿源旁的容器状态：是否已有容器 / 是否有工地 / 能否开新工地 */

function remoteBoxStatus(room, source) {
    const out = { hasBox: false, site: null, canBuild: false };
    if (!room || !source) return out;
    try {
        for (const s of room.find(FIND_STRUCTURES)) {
            if (s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(source.pos) <= 2) { out.hasBox = true; return out; }
        }
    } catch (e) { }
    try {
        for (const s of room.find(FIND_CONSTRUCTION_SITES)) {
            if (s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(source.pos) <= 2) { out.site = s; return out; }
        }
    } catch (e) { }
    // 没有容器也没有工地：看有没有可开的空位（要求本房 RCL>=2，容器数量未超限）
    out.canBuild = slotList(source).length > 0;
    return out;
}

/** 在远程矿源旁开一个容器工地，返回坐标字符串或 null */

function createRemoteBox(room, source) {
    const slots = slotList(source);
    if (!slots.length) return null;
    const preferred = slots.filter(s => !s.onContainer);
    const target = (preferred.length ? preferred : slots)[0];
    try {
        const r = room.createConstructionSite(target.x, target.y, STRUCTURE_CONTAINER);
        if (r === OK) return target.x + ',' + target.y;
    } catch (e) { }
    return null;
}

/** 该格上是否压着容器/道路（矿工应尽量避开，把位置留给搬运工） */

module.exports = { walkableOnContainer, slotList, slotReachable, ensureSlot, harvestSlots, remoteBoxStatus, createRemoteBox };

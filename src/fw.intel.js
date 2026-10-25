/** 房间情报：记录、读取、候选扩张目标 */



function recordIntel(room) {
    const data = {
        t: Game.time,
        name: room.name,
        controller: null,
        sources: [],
        mineral: null,
        hostiles: 0,
        myStructures: 0,
        enemyStructures: 0,
    };
    try {
        if (room.controller) {
            data.controller = {
                x: room.controller.pos.x,
                y: room.controller.pos.y,
                level: room.controller.level,
                owner: room.controller.owner ? room.controller.owner.username : null,
                my: !!room.controller.my,
                reservation: room.controller.reservation ? room.controller.reservation.username : null,
            };
        }
        for (const s of room.find(FIND_SOURCES)) data.sources.push({ x: s.pos.x, y: s.pos.y, id: s.id });
        const mineral = room.find(FIND_MINERALS)[0];
        if (mineral) data.mineral = { type: mineral.mineralType, x: mineral.pos.x, y: mineral.pos.y };
        data.hostiles = room.find(FIND_HOSTILE_CREEPS).length;
        for (const st of room.find(FIND_STRUCTURES)) {
            if (st.my) data.myStructures++;
            else if (st.structureType === STRUCTURE_SPAWN || st.structureType === STRUCTURE_EXTENSION
                || st.structureType === STRUCTURE_TOWER) data.enemyStructures++;
        }
    } catch (e) {
        data.error = String(e && e.message || e).slice(0, 120);
    }
    intel()[room.name] = data;
    return data;
}

/**
 * 候选扩张目标：相邻房间里"无主、有 2 个以上矿源、没敌人占地"的
 */

function getIntel(roomName) {
    return intel()[roomName] || null;
}

/**
 * 记录一个房间的情报（视野内才有效）。只存坐标/数字/用户名，不存游戏对象。
 */

function intel() {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.intel) Memory.fw.intel = {};
    return Memory.fw.intel;
}


function expansionCandidates(roomName) {
    const exits = (Game.map.describeExits(roomName) || {});
    const out = [];
    for (const dir in exits) {
        const name = exits[dir];
        if (!name) continue;
        const info = getIntel(name);
        if (!info || !info.controller) continue;
        if (info.controller.owner) continue;          // 有人占了
        if (info.hostiles > 0) continue;              // 有敌人先不打
        out.push({
            room: name,
            sources: info.sources.length,
            mineral: info.mineral ? info.mineral.type : null,
            seen: info.t,
        });
    }
    out.sort((a, b) => b.sources - a.sources);
    return out;
}

/* ------------------------------ 计数 ------------------------------ */


module.exports = { recordIntel, getIntel, intel, expansionCandidates };

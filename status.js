/**
 * 控制台状态报告
 */
const config = require('config');

function pad(str, len) {
    str = String(str);
    while (str.length < len) str += ' ';
    return str;
}

function report() {
    if (Game.time % config.reportInterval !== 0) return;

    const lines = [];
    lines.push('[FW] === tick ' + Game.time + ' | GCL ' + Game.gcl.level + ' (' + (Game.gcl.progress / Game.gcl.progressTotal * 100).toFixed(1) + '%)'
        + ' | CPU ' + Game.cpu.getUsed().toFixed(1) + '/' + Game.cpu.limit
        + ' | bucket ' + Game.cpu.bucket + ' ===');

    let totalCreeps = 0;
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller || !room.controller.my) continue;

        const creeps = room.find(FIND_MY_CREEPS);
        totalCreeps += creeps.length;

        const roles = {};
        for (const c of creeps) {
            const r = (c.memory && c.memory.role) || '?';
            roles[r] = (roles[r] || 0) + 1;
        }
        let roleText = '';
        for (const r in roles) roleText += r + ':' + roles[r] + ' ';

        const spawns = room.find(FIND_MY_SPAWNS);
        const spawnText = spawns.map(s => s.name + (s.spawning ? '(busy)' : '(idle)')).join(',') || '-';

        const sites = room.find(FIND_CONSTRUCTION_SITES);
        const structs = room.find(FIND_MY_STRUCTURES);
        const containers = structs.filter(s => s.structureType === STRUCTURE_CONTAINER).length;
        const links = structs.filter(s => s.structureType === STRUCTURE_LINK).length;

        lines.push('    ' + pad(room.name, 8)
            + ' RCL' + room.controller.level
            + ' 能量 ' + room.energyAvailable + '/' + room.energyCapacityAvailable
            + ' | creep ' + creeps.length + ' [' + roleText.trim() + ']'
            + ' | 工地 ' + sites.length
            + ' | 容器 ' + containers + ' 链接 ' + links
            + ' | spawn ' + spawnText);
    }

    lines.push('[FW] 全局 creep: ' + totalCreeps
        + ' | GCL ' + (Game.gcl ? Game.gcl.level : '?')
        + ' | 士兵 ' + (() => { let n = 0; for (const k in Game.creeps) if (Game.creeps[k].memory && Game.creeps[k].memory.role === 'soldier') n++; return n; })()
        + ' | 情报房间 ' + (Memory.fw && Memory.fw.intel ? Object.keys(Memory.fw.intel).length : 0));
    console.log(lines.join('\n'));
}

/**
 * 把异常写进 Memory（我可以在外部通过 /api/user/memory 读到，不用看控制台）
 */
function recordError(where, e) {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.errors) Memory.fw.errors = [];
    let text = '';
    try {
        text = e && e.stack ? e.stack : String(e);
    } catch (err) {
        text = 'unknown error';
    }
    Memory.fw.errors.push({ t: Game.time, w: where, m: String(text).slice(0, 500) });
    while (Memory.fw.errors.length > 5) Memory.fw.errors.shift();
}

/**
 * 定期把紧凑状态写进 Memory，方便外部观测
 */
function snapshot(rooms) {
    if (!Memory.fw) Memory.fw = {};
    const out = {
        t: Game.time,
        cpu: Math.round(Game.cpu.getUsed() * 100) / 100,
        bucket: Game.cpu.bucket,
        gcl: Game.gcl ? { level: Game.gcl.level, progress: Game.gcl.progress, total: Game.gcl.progressTotal } : null,
        intel: {},
        rooms: [],
    };

    // 情报摘要：哪些房间被侦查过、能不能扩张
    if (Memory.fw && Memory.fw.intel) {
        for (const name in Memory.fw.intel) {
            const i = Memory.fw.intel[name];
            out.intel[name] = {
                t: i.t,
                src: i.sources ? i.sources.length : 0,
                ctrl: i.controller ? (i.controller.owner || (i.controller.my ? 'me' : 'none')) : 'none',
                lvl: i.controller ? i.controller.level : 0,
                hostile: i.hostiles,
                mineral: i.mineral ? i.mineral.type : null,
            };
        }
    }
    for (const room of rooms) {
        const creeps = room.find(FIND_MY_CREEPS);
        const roles = {};
        for (const c of creeps) {
            const r = (c.memory && c.memory.role) || '?';
            roles[r] = (roles[r] || 0) + 1;
        }
        const spawns = room.find(FIND_MY_SPAWNS).map(s => ({
            n: s.name, e: s.store.getUsedCapacity(RESOURCE_ENERGY), s: s.spawning ? s.spawning.name : null,
        }));
        const structs = room.find(FIND_MY_STRUCTURES);
        const byType = {};
        for (const s of structs) byType[s.structureType] = (byType[s.structureType] || 0) + 1;
        out.rooms.push({
            n: room.name,
            rcl: room.controller ? room.controller.level : 0,
            prog: room.controller ? room.controller.progress : 0,
            progTotal: room.controller ? room.controller.progressTotal : 0,
            e: room.energyAvailable,
            cap: room.energyCapacityAvailable,
            creeps: roles,
            spawns: spawns,
            sites: room.find(FIND_CONSTRUCTION_SITES).map(s => s.structureType),
            structs: byType,
            sources: room.find(FIND_SOURCES).map(s => ({ id: s.id, e: s.energy })),
        });
    }
    Memory.fw.snapshot = out;
}

module.exports = { report, recordError, snapshot };

/**
 * 房间经济：日常清理、建造规划、生成管理、塔控制
 */
const config = require('config');
const utils = require('utils');
const defense = require('defense');

/* ------------------------------ 全局清理 ------------------------------ */

function housekeeping() {
    if (!Memory.creeps) Memory.creeps = {};
    if (!Memory.fw) Memory.fw = { version: config.version, stats: {} };

    // 清理已死亡 creep 的 Memory
    for (const name in Memory.creeps) {
        if (!Game.creeps[name]) delete Memory.creeps[name];
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

function runRoom(room) {
    const data = utils.roomData(room);
    defense.run(room, data);      // 塔 / 安全模式 / 逃跑 / 防御工事
    runLinks(room, data);         // RCL5+ 的 link 瞬移

    // 记录"老家被袭"信号：巡逻兵看到就会立刻回防
    if (data.hostiles && data.hostiles.length > 0) {
        Memory.fw.homeUnderAttack = room.name;
        Memory.fw.homeAttackAt = Game.time;
    } else if (Memory.fw && Memory.fw.homeUnderAttack === room.name && Game.time - (Memory.fw.homeAttackAt || 0) > 50) {
        Memory.fw.homeUnderAttack = undefined;
    }
    rebalanceRoles(room, data);   // 容器体系建好后，把多余的自采工人转成矿工/搬运工

    // 诊断信息（每 50 tick 写一次 Memory，外部可读）
    if (Game.time % 50 === 0) {
        const q = computeQuota(room, data);
        Memory.fw.diag = {
            t: Game.time,
            quota: q,
            containerized: data.sources.filter(s => sourceHasContainer(data, s)).length,
            containers: data.containers.length,
            structures: data.structures.length,
            structureTypes: data.structures.map(s => s.structureType),
            sites: data.sites.length,
            creeps: data.creeplist.length,
            roles: data.creepsByRole,
        };
    }
    planConstruction(room, data);
    runSpawns(room, data);
}

/**
 * 角色就地转换：当容器体系搭好、自采工人超额时，把多余的工人直接改成矿工/搬运工，
 * 不用等它们老死（否则容器建好后要空转上千 tick 才有人去用）。
 */
/**
 * 身体能否胜任某个角色
 */
function canDo(creep, role) {
    const body = creep.body || [];
    const has = type => body.some(p => p.type === type);
    switch (role) {
        case 'miner':
        case 'harvester':
        case 'remoteHarvester':
        case 'builder':
        case 'upgrader':
            return has(WORK) && has(CARRY);
        case 'hauler':
            return has(CARRY);
        case 'soldier':
            return has(ATTACK) || has(RANGED_ATTACK);
        case 'scout':
            return has(MOVE);
        default:
            return false;
    }
}

/**
 * 通用补位：某个角色缺人时，从"高于下限的冗余角色"里征调身体合适的 creep 就地转职。
 * 好处是岗位空缺立刻补上，不用等 spawn 造人（造人要 3*部件数 tick + 攒能量）。
 */
function rebalanceRoles(room, data) {
    const quota = computeQuota(room, data);
    const have = n => utils.countRole(data, n);

    // 每个角色不能被抽空的下限
    const floors = {
        miner: quota.miner || 0,
        harvester: Math.min(2, quota.harvester || 0),
        hauler: Math.min(1, quota.hauler || 0),
        builder: Math.min(1, quota.builder || 0),
        upgrader: Math.min(1, quota.upgrader || 0),
        soldier: Math.min(1, quota.soldier || 0),
        scout: 0,
        remoteHarvester: 0,
    };

    const deficits = [];
    for (const role of config.spawnPriority) {
        const want = quota[role] || 0;
        if (want <= 0) continue;
        const miss = want - have(role);
        if (miss > 0) deficits.push({ role: role, missing: miss, ratio: have(role) / want });
    }
    if (!deficits.length) return;
    deficits.sort((a, b) => a.ratio - b.ratio);

    const containerSources = data.sources.filter(s => sourceHasContainer(data, s));

    for (const d of deficits) {
        for (const creep of data.creeplist) {
            if (d.missing <= 0 || have(d.role) >= (quota[d.role] || 0)) break;
            const cur = creep.memory && creep.memory.role;
            if (!cur || cur === d.role) continue;
            if (!canDo(creep, d.role)) continue;
            if (have(cur) <= (floors[cur] || 0)) continue;   // 当前角色不能低于下限

            // 矿工得绑定一个"有容器的矿源"
            if (d.role === 'miner') {
                const sid = creep.memory.sourceId;
                let ok = false;
                for (const s of containerSources) if (s.id === sid) ok = true;
                if (!ok) {
                    if (!containerSources.length) continue;
                    creep.memory.sourceId = containerSources[0].id;
                }
            }
            // 远程采集者要目标房间
            if (d.role === 'remoteHarvester') {
                const target = pickRemoteTarget(room, data);
                if (!target) continue;
                creep.memory.targetRoom = target.room;
                creep.memory.sourceId = target.sourceId;
            }

            creep.memory.role = d.role;
            creep.memory.working = undefined;
            creep.memory.noEnemySince = undefined;
            if (data.ownedByRole) {
                data.ownedByRole[cur] = Math.max(0, (data.ownedByRole[cur] || 0) - 1);
                data.ownedByRole[d.role] = (data.ownedByRole[d.role] || 0) + 1;
            }
            data.creepsByRole[cur] = Math.max(0, (data.creepsByRole[cur] || 0) - 1);
            data.creepsByRole[d.role] = (data.creepsByRole[d.role] || 0) + 1;
            d.missing--;
            console.log('[FW] ' + creep.name + ' 转职 ' + cur + ' -> ' + d.role + '（岗位补位）');
        }
    }
}

/* ------------------------------ 塔 ------------------------------ */

function runTowers(room, data) {
    if (!data.towers.length) return;

    for (const tower of data.towers) {
        if (data.hostiles.length) {
            const target = tower.pos.findClosestByRange(data.hostiles);
            if (target && tower.pos.getRangeTo(target) <= 10) {
                tower.attack(target);
                continue;
            }
        }

        // 治疗受伤的 creep
        const wounded = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: c => c.hits < c.hitsMax,
        });
        if (wounded) {
            tower.heal(wounded);
            continue;
        }

        // 维修（能量充足时）
        const capacity = tower.store.getCapacity(RESOURCE_ENERGY) || 0;
        const energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (capacity <= 0 || energy / capacity < config.towerRepairEnergyRatio) continue;

        const damaged = tower.pos.findClosestByRange(FIND_STRUCTURES, {
            filter: s => s.structureType !== STRUCTURE_WALL
                && s.structureType !== STRUCTURE_RAMPART
                && s.hits < s.hitsMax * config.repairThreshold,
        });
        if (damaged) tower.repair(damaged);
    }
}

/* ------------------------------ 建造规划 ------------------------------ */

function occupancy(room, data) {
    if (data._occ) return data._occ;
    const occ = {};
    const add = pos => { occ[pos.x + ',' + pos.y] = true; };
    for (const s of room.find(FIND_STRUCTURES)) add(s.pos);
    for (const s of data.sites) add(s.pos);
    for (const s of data.sources) add(s.pos);
    if (data.mineral) add(data.mineral.pos);
    if (room.controller) add(room.controller.pos);
    data._occ = occ;
    return occ;
}

function countSites(data, type) {
    let n = 0;
    for (const s of data.sites) if (s.structureType === type) n++;
    return n;
}

function freeSpots(room, occ, cx, cy, minR, maxR, avoid) {
    const terrain = room.getTerrain();
    const spots = [];
    for (let dy = -maxR; dy <= maxR; dy++) {
        for (let dx = -maxR; dx <= maxR; dx++) {
            // Screeps 用的是切比雪夫距离：对角格算 1 格，采集/建造都能选对角
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            if (dist < minR || dist > maxR) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (x < 2 || x > 47 || y < 2 || y > 47) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            if (occ[x + ',' + y]) continue;
            let blocked = false;
            if (avoid) {
                for (const p of avoid) {
                    if (p && p.x === x && p.y === y) { blocked = true; break; }
                }
            }
            if (blocked) continue;
            spots.push({ x: x, y: y, dist: dist });
        }
    }
    spots.sort((a, b) => a.dist - b.dist);
    return spots;
}

function createSite(room, spot, type, label) {
    const r = room.createConstructionSite(spot.x, spot.y, type);
    if (r === OK) {
        console.log('[FW] ' + room.name + ' 新工地: ' + type + ' @' + spot.x + ',' + spot.y + (label ? ' (' + label + ')' : ''));
        return 1;
    }
    return 0;
}

function planConstruction(room, data) {
    const level = data.level;
    if (!level) return;

    let created = 0;
    const siteCount = () => data.sites.length + created;
    const siteLimit = level >= 4 ? config.maxSitesPerRoomHighRcl : config.maxSitesPerRoom;

    if (siteCount() >= siteLimit) return;

    const occ = occupancy(room, data);
    const spawn = data.spawns[0] || null;
    const center = spawn ? spawn.pos : (room.controller ? room.controller.pos : { x: 25, y: 25 });

    // 不占用矿源/控制器周围的"工作站"位置
    const avoid = [];
    for (const s of data.sources) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) avoid.push({ x: s.pos.x + dx, y: s.pos.y + dy });
    }
    if (room.controller) {
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) avoid.push({ x: room.controller.pos.x + dx, y: room.controller.pos.y + dy });
    }

    // 1) 矿源容器（RCL2+）：第一时间铺，静态矿工 + 搬运工是产能的核心
    if (level >= config.canBuildContainers) {
        for (const source of data.sources) {
            if (created >= config.maxNewSitesPerTick || siteCount() >= siteLimit) break;
            if (containerNear(data, source.pos, 2)) continue;
            const spots = freeSpots(room, occ, source.pos.x, source.pos.y, 1, 1, []);
            if (!spots.length) continue;
            const spot = spots[0];
            if (createSite(room, spot, STRUCTURE_CONTAINER, 'source')) {
                occ[spot.x + ',' + spot.y] = true;
                created++;
            }
        }
    }

    // 2) 控制器容器（RCL2+）：升级者在原地续杯
    if (level >= config.canBuildContainers && room.controller) {
        if (created < config.maxNewSitesPerTick && siteCount() < siteLimit
            && !containerNear(data, room.controller.pos, 3)) {
            const spots = freeSpots(room, occ, room.controller.pos.x, room.controller.pos.y, 1, 3, []);
            if (spots.length && createSite(room, spots[0], STRUCTURE_CONTAINER, 'controller')) {
                occ[spots[0].x + ',' + spots[0].y] = true;
                created++;
            }
        }
    }

    // 3) 扩展
    const extLimit = config.extensionLimit[level] || 0;
    let extTotal = data.extensions.length + countSites(data, STRUCTURE_EXTENSION);
    while (extTotal < extLimit && created < config.maxNewSitesPerTick && siteCount() < siteLimit) {
        const spots = freeSpots(room, occ, center.x, center.y, 2, 8, avoid);
        if (!spots.length) break;
        const spot = spots[0];
        if (createSite(room, spot, STRUCTURE_EXTENSION)) {
            occ[spot.x + ',' + spot.y] = true;
            created++;
            extTotal++;
        } else break;
    }

    // 4) 塔（RCL3+）
    const towerLimit = config.towerLimit[level] || 0;
    let towerTotal = data.towers.length + countSites(data, STRUCTURE_TOWER);
    if (towerTotal < towerLimit && created < config.maxNewSitesPerTick) {
        const spots = freeSpots(room, occ, center.x, center.y, 2, 6, avoid);
        if (spots.length && createSite(room, spots[0], STRUCTURE_TOWER)) {
            occ[spots[0].x + ',' + spots[0].y] = true;
            created++;
            towerTotal++;
        }
    }

    // 5) Storage（RCL4+）
    if (level >= config.canBuildStorage && !data.storage && countSites(data, STRUCTURE_STORAGE) === 0 && created < config.maxNewSitesPerTick) {
        const spots = freeSpots(room, occ, center.x, center.y, 3, 7, avoid);
        if (spots.length && createSite(room, spots[0], STRUCTURE_STORAGE)) {
            occ[spots[0].x + ',' + spots[0].y] = true;
            created++;
        }
    }

    // 5.5) Link（RCL5+）：矿源旁边一个"发送端"，控制器/仓储旁边一个"接收端"
    const linkLimit = config.linkLimit[level] || 0;
    if (linkLimit > 0) {
        const linkTotal = data.links.length + countSites(data, STRUCTURE_LINK);
        if (linkTotal < linkLimit && created < config.maxNewSitesPerTick) {
            const spot = findLinkSpot(room, data, occ);
            if (spot && createSite(room, spot, STRUCTURE_LINK, spot.label)) {
                occ[spot.x + ',' + spot.y] = true;
                created++;
            }
        }
    }

    // 6) 道路：只铺主要通勤路径上的沼泽段（平地本来就能满速走，铺路是浪费）
    if (level >= 2 && created < config.maxNewSitesPerTick) {
        planRoads(room, data, occ, created);
    }
}

/**
 * 给 link 找位置：
 *  - 先把"矿源侧发送端"补齐（贴在矿源旁容器旁边，矿工站在容器上就能倒进去）
 *  - 再放"核心侧接收端"（控制器/仓储/no spawn 附近）
 */
function findLinkSpot(room, data, occ) {
    const terrain = room.getTerrain();

    // 1) 矿源侧：优先找有容器但还没 link 的矿源
    for (const source of data.sources) {
        let hasLink = false;
        for (const l of data.links) if (l.pos.getRangeTo(source.pos) <= 3) hasLink = true;
        for (const s of data.sites) if (s.structureType === STRUCTURE_LINK && s.pos.getRangeTo(source.pos) <= 3) hasLink = true;
        if (hasLink) continue;

        // 贴着矿源旁的容器放（这样矿工站在容器上 range 1 就能 transfer）
        for (const c of data.containers) {
            if (c.pos.getRangeTo(source.pos) > 2) continue;
            const spots = freeSpots(room, occ, c.pos.x, c.pos.y, 1, 1, []);
            for (const sp of spots) {
                if (sp.x === source.pos.x && sp.y === source.pos.y) continue;
                return { x: sp.x, y: sp.y, label: 'source-link' };
            }
        }
        // 没有容器就贴着矿源
        const spots = freeSpots(room, occ, source.pos.x, source.pos.y, 2, 2, []);
        if (spots.length) return { x: spots[0].x, y: spots[0].y, label: 'source-link' };
    }

    // 2) 核心侧：控制器 > 仓储 > spawn
    let center = null;
    if (room.controller) center = room.controller.pos;
    else if (data.storage) center = data.storage.pos;
    else if (data.spawns[0]) center = data.spawns[0].pos;
    if (!center) return null;
    const spots = freeSpots(room, occ, center.x, center.y, 2, 4, []);
    if (!spots.length) return null;
    return { x: spots[0].x, y: spots[0].y, label: 'hub-link' };
}

/**
 * Link 调度：把矿源侧的能量瞬移到核心侧（不消耗 creep 运输时间）
 */
function runLinks(room, data) {
    if (!data.links || data.links.length < 2) return;

    const receivers = [];
    for (const l of data.links) {
        let recv = false;
        if (room.controller && l.pos.getRangeTo(room.controller) <= 4) recv = true;
        if (data.storage && l.pos.getRangeTo(data.storage) <= 3) recv = true;
        if (!recv && data.spawns[0] && l.pos.getRangeTo(data.spawns[0]) <= 3) recv = true;
        if (recv) receivers.push(l);
    }
    if (!receivers.length) return;

    // 挑能量最少的接收端
    let target = receivers[0];
    for (const r of receivers) {
        if ((r.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < (target.store.getUsedCapacity(RESOURCE_ENERGY) || 0)) target = r;
    }
    if ((target.store.getFreeCapacity(RESOURCE_ENERGY) || 0) <= 0) return;

    for (const l of data.links) {
        if (l.id === target.id) continue;
        if (receivers.indexOf(l) !== -1) continue;
        if ((l.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < 100) continue;
        try {
            l.transferEnergy(target);
        } catch (e) {
            // 忽略：下一 tick 再试
        }
    }
}

function containerNear(data, pos, range) {
    for (const c of data.containers) if (c.pos.getRangeTo(pos) <= range) return true;
    for (const s of data.sites) if (s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(pos) <= range) return true;

    // 实时兜底：工地可能在本 tick 刚完工，data 快照里还没有这条结构
    const room = data.room;
    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            const x = pos.x + dx;
            const y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            let found;
            try {
                found = room.lookForAt(LOOK_STRUCTURES, x, y);
            } catch (e) {
                found = null;
            }
            if (!found) continue;
            for (const s of found) {
                if (s.structureType === STRUCTURE_CONTAINER) return true;
            }
        }
    }
    return false;
}

/**
 * 只给"主要通勤路径上的沼泽格"铺路：
 * 平地上身体合格的 creep 本来就能 1 tick 走 1 格，铺路纯浪费 300 能量；
 * 沼泽会让疲劳 ×5，铺一格路等于把那段路的时间砍到 1/3~1/5。
 */
function planRoads(room, data, occ, createdBudget) {
    const spawn = data.spawns[0];
    if (!spawn) return;

    const maxRoadSites = 5;
    let roadSites = 0;
    for (const s of data.sites) if (s.structureType === STRUCTURE_ROAD) roadSites++;
    if (roadSites >= maxRoadSites) return;

    const terrain = room.getTerrain();
    const targets = [];
    for (const s of data.sources) targets.push(s.pos);
    if (room.controller) targets.push(room.controller.pos);

    for (const target of targets) {
        let path;
        try {
            path = room.findPath(spawn.pos, target, { ignoreCreeps: true, range: 1 });
        } catch (e) {
            continue;
        }
        for (const step of path) {
            if (roadSites >= maxRoadSites || createdBudget >= config.maxNewSitesPerTick) return;
            if (occ[step.x + ',' + step.y]) continue;
            if (!(terrain.get(step.x, step.y) & TERRAIN_MASK_SWAMP)) continue;
            const r = room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
            if (r === OK) {
                occ[step.x + ',' + step.y] = true;
                createdBudget++;
                roadSites++;
                console.log('[FW] ' + room.name + ' 沼泽铺路 @' + step.x + ',' + step.y);
            }
        }
    }
}

/* ------------------------------ 生成 ------------------------------ */

/**
 * 判断某个矿源是否已经有可用容器（有的话就派静态矿工，不再派自采工人）
 */
function sourceHasContainer(data, source) {
    for (const c of data.containers) {
        if (c.pos.getRangeTo(source.pos) <= 2) return true;
    }
    return false;
}

function computeQuota(room, data) {
    const level = data.level;
    const capacity = room.energyCapacityAvailable || 300;

    const quota = { harvester: 0, miner: 0, hauler: 0, builder: 0, upgrader: 0 };

    // 已经被容器覆盖的矿源交给静态矿工
    let containerized = 0;
    for (const s of data.sources) {
        if (sourceHasContainer(data, s)) containerized++;
    }
    const bare = data.sources.length - containerized;

    // 静态矿工：一个矿源一个
    quota.miner = containerized;

    // 自采工人：没有容器的矿源，每个矿源 2 个；能量上限高时 3 个
    const perSource = capacity >= 800 ? 3 : 2;
    quota.harvester = bare * perSource;

    // 搬运工：有容器才需要；能量上限低时先给 1 个（货源不足，多了只会闲置）
    if (containerized > 0) {
        quota.hauler = capacity < 550 ? 1 : (level >= 5 ? 4 : (level >= 4 ? 3 : 2));
    }

    // 建造者：有工地才需要；工地多时多给（扩建=容量闸门，值得多投人）
    if (data.sites.length > 0) {
        quota.builder = data.sites.length >= 3 ? 3 : 2;
    }

    // 军事/侦查类兵种：只有经济已经转起来（至少 2 个经济单位、其中有采集者/矿工）才允许造，
    // 否则 130 能量的士兵会把这个房间的启动资金吃掉，直接锁死经济
    const econCount = utils.countRole(data, 'harvester') + utils.countRole(data, 'miner') + utils.countRole(data, 'hauler');
    const econHealthy = econCount >= 2 && (utils.countRole(data, 'harvester') + utils.countRole(data, 'miner')) >= 1;

    const militaryAllowed = (data.hostiles && data.hostiles.length > 0) || level >= 2;
    if (econHealthy && militaryAllowed) {
        // 士兵：房间里有敌人才造（经济单位打不了架），和平时期留 1 个常备军
        quota.soldier = data.hostiles && data.hostiles.length > 0
            ? Math.min(4, data.hostiles.length + 1)
            : 1;
        // 边防巡逻队：RCL3 起常备 2 人，在相邻房间之间来回巡逻清野；受袭时加到 3
        if (level >= 3) {
            const patrolBase = capacity >= 700 ? 2 : 1;
            quota.patroller = (data.hostiles && data.hostiles.length > 0) ? patrolBase + 1 : patrolBase;
        }
        // 侦查兵：相邻房间情报缺失/过期时才派 1 个
        quota.scout = hasStaleNeighbor(room.name) ? config.maxScouts : 0;
    }

    // 升级者：容器体系搭起来后它就是"消耗端"，全链吞吐都被它卡着，所以要多配。
    // RCL2~4: 4 个；RCL5+: 5 个（再高由下面的"库存自适应"继续加）
    quota.upgrader = containerized > 0 ? (level >= 5 ? 5 : 4) : 0;

    // 占领者：RCL3+ 就派（650 能量的 CLAIM 单位，相对 16 E/tick 的收入只是 3%）。
    // 服务器上有其他玩家/机器人在活动，先把相邻的优质空地"预定"住比省这 650 更划算。
    quota.reserver = 0;
    if (level >= 3 && capacity >= 650 && (data.creepsByRole.reserver || 0) === 0) {
        const target = pickReserveTarget(room);
        if (target) quota.reserver = 1;
    }

    // 自适应：容器里明显压货 -> 加搬运工（最多 3 个）
    let storedEnergy = 0;
    for (const c of data.containers) storedEnergy += (c.store.getUsedCapacity(RESOURCE_ENERGY) || 0);
    if (data.storage) storedEnergy += (data.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0);
    if (containerized > 0 && storedEnergy >= 400 && quota.hauler < 3) {
        quota.hauler++;
    }

    // 自适应：仓储/容器里存量大 -> 加升级者（最多 6 个），把存量变成 RCL
    if (storedEnergy >= 800 && quota.upgrader > 0 && quota.upgrader < 6) {
        quota.upgrader++;
    }

    // 远程采矿：只有"本地已经饱和"才派——两个矿源都有容器、没工地、RCL3+、人数够
    quota.remoteHarvester = 0;
    if (level >= 4 && containerized >= 2 && data.creeplist.length >= 12) {
        quota.remoteHarvester = 2;
    }

    // 总人数上限：按"先砍谁最不痛"的顺序裁剪，保证矿工/建造者/升级者都还留得住人
    const cap = creepCap(room);
    let total = quota.harvester + quota.miner + quota.hauler + quota.builder + quota.upgrader
        + (quota.soldier || 0) + (quota.patroller || 0) + (quota.scout || 0)
        + (quota.remoteHarvester || 0) + (quota.reserver || 0);
    const floors = {
        // 增长引擎保底：矿工不砍、升级者/建造者各留 2、搬运 1、守卫各 1
        miner: quota.miner || 0,
        harvester: Math.min(2, quota.harvester || 0),
        upgrader: Math.min(2, quota.upgrader || 0),
        builder: data.sites.length > 0 ? Math.min(2, quota.builder || 0) : 0,
        hauler: 1,
        soldier: 1,
        patroller: 1,
    };
    // 裁剪顺序：先砍外围（远程/占领/侦查），最后才动经济核心
    const trimOrder = ['remoteHarvester', 'reserver', 'scout', 'patroller', 'hauler', 'harvester', 'builder', 'upgrader'];
    while (total > cap) {
        let trimmed = false;
        for (const role of trimOrder) {
            if ((quota[role] || 0) > (floors[role] || 0)) {
                quota[role]--;
                total--;
                trimmed = true;
                break;
            }
        }
        if (!trimmed) break;
    }

    return quota;
}

/**
 * 给新出生的 creep 分配矿源。onlyContainerized=true 时只挑有容器的矿源（静态矿工）
 */
function assignSource(room, data, onlyContainerized) {
    if (!data.sources.length) return null;
    const candidates = onlyContainerized
        ? data.sources.filter(s => sourceHasContainer(data, s))
        : data.sources;
    if (!candidates.length) return null;

    const load = {};
    for (const s of candidates) load[s.id] = 0;
    for (const c of data.creeplist) {
        const sid = c.memory && c.memory.sourceId;
        if (sid && load[sid] !== undefined) load[sid]++;
    }
    let best = candidates[0];
    for (const s of candidates) {
        if (load[s.id] < load[best.id]) best = s;
    }
    return best;
}

/**
 * 选出"缺口最大"的角色（按 count/quota 比例），
 * 这样不会因为采集者不断老死而永远轮不到升级者/建造者。
 */
function pickSpawnRole(data, quota) {
    const missing = [];
    for (const role of config.spawnPriority) {
        const want = quota[role] || 0;
        if (want <= 0) continue;
        // 快死的算半个（提前补位，避免岗位真空），正在孵化的也算上
        const alive = utils.countRole(data, role);
        const leaving = (data.leavingByRole && data.leavingByRole[role]) || 0;
        const effective = alive - leaving;
        if (effective >= want) continue;
        missing.push({ role: role, ratio: Math.max(0, effective) / want });
    }
    missing.sort((a, b) => a.ratio - b.ratio);
    return missing.map(m => m.role);
}

/**
 * 挑一个值得"预定"的相邻房间：无主、没敌人、矿源越多越优先
 */
function pickReserveTarget(room) {
    const cands = utils.expansionCandidates(room.name);
    for (const c of cands) {
        if (c.sources >= 2) return c.room;
    }
    return cands.length ? cands[0].room : null;
}

/**
 * 挑一个可以远程采矿的相邻房间（无主、没敌人、有矿源）
 */
function pickRemoteTarget(room, data) {
    const cands = utils.expansionCandidates(room.name);
    for (const c of cands) {
        const info = utils.getIntel(c.room);
        if (!info || !info.sources || !info.sources.length) continue;
        if (info.hostiles > 0) continue;
        return { room: c.room, sourceId: info.sources[0].id };
    }
    return null;
}

/**
 * 相邻房间是否有情报缺失/过期（决定要不要派侦查）
 */
function hasStaleNeighbor(roomName) {
    let exits;
    try {
        exits = Game.map.describeExits(roomName) || {};
    } catch (e) {
        return false;
    }
    for (const dir in exits) {
        const name = exits[dir];
        if (!name || name === roomName) continue;
        const info = utils.getIntel(name);
        if (!info) return true;
        if (Game.time - info.t > config.intelStaleTicks) return true;
    }
    return false;
}

function creepCap(room) {
    return 7 + Math.floor((room.energyCapacityAvailable || 300) / 100);
}

function runSpawns(room, data) {
    if (!data.spawns.length) return;
    const free = data.spawns.filter(s => !s.spawning);
    if (!free.length) return;

    const quota = computeQuota(room, data);
    const wanted = pickSpawnRole(data, quota);

    // 总数上限：人太多会吃掉全部能量用于更新换代。
    // 但防御者属于应急，允许突破上限（不然房间里有敌人时没人能打）
    let ownedCount = 0;
    if (data.ownedByRole) for (const r in data.ownedByRole) ownedCount += data.ownedByRole[r];
    else ownedCount = data.creeplist.length;

    const urgentMilitary = wanted.length > 0 && (wanted[0] === 'soldier' || wanted[0] === 'patroller');
    if (!urgentMilitary && ownedCount >= creepCap(room)) return;

    if (!wanted.length) {
        // 配额已满但 spawn 满仓（能量没处花）：多造一个采集者换产能，上限见 cap
        return spawnSurplus(room, data, quota, free[0]);
    }

    // RCL1 时优先"便宜、快"的小身体（[work,carry,move] 200 能量）：
    // 省下的能量能让下一只 creep 早 100 tick 出生，铺人口比单体质量更重要
    const budget = data.level <= 1
        ? Math.min(room.energyAvailable, 200)
        : room.energyAvailable;

    // 按缺口比例依次尝试，某个兵种身体造不起就退到次优的，避免"该兵种永远造不出来"的死锁
    let role = null;
    let body = null;
    for (const candidate of wanted) {
        const def = config.bodies[candidate];
        const roleBudget = def && def.maxCost ? Math.min(budget, def.maxCost) : budget;
        const b = utils.planBody(candidate, roleBudget);
        if (b) { role = candidate; body = b; break; }
    }
    if (!body) return;

    const spawn = free[0];
    const name = role + '_' + spawn.name + '_' + Game.time;
    const memory = { role: role, spawn: spawn.id, home: room.name, task: 'idle' };

    if (role === 'harvester') {
        const source = assignSource(room, data, false);
        if (source) memory.sourceId = source.id;
    } else if (role === 'miner') {
        const source = assignSource(room, data, true);
        if (source) memory.sourceId = source.id;
    } else if (role === 'reserver') {
        const target = pickReserveTarget(room);
        if (!target) return;
        memory.targetRoom = target;
    } else if (role === 'remoteHarvester') {
        const target = pickRemoteTarget(room, data);
        if (!target) return;   // 没有合适目标就不造
        memory.targetRoom = target.room;
        if (target.sourceId) memory.sourceId = target.sourceId;
    }

    const r = spawn.spawnCreep(body, name, { memory: memory });
    if (r === OK) {
        console.log('[FW] ' + room.name + ' 孵化了 ' + role + ' (' + body.length + ' 部件 / ' + utils.bodyCost(body) + ' 能量) -> ' + name);
        // 立刻计入配额，避免同一 tick 内其它 spawn 重复制造
        data.creepsByRole[role] = (data.creepsByRole[role] || 0) + 1;
        return;
    }
    if (r === ERR_NOT_ENOUGH_ENERGY) return;
    if (r === ERR_BUSY) return;
    console.log('[FW] 孵化 ' + role + ' 失败: ' + r);
}

/**
 * 配额已满但能量还有富余：多造采集者把能量转成产能
 */
function spawnSurplus(room, data, quota, spawn) {
    const capacity = room.energyCapacityAvailable || 300;
    const cap = creepCap(room);
    let total = 0;
    for (const role in data.creepsByRole) total += data.creepsByRole[role];
    if (total >= cap) return;
    if (room.energyAvailable < capacity) return;

    const body = utils.planBody('harvester', room.energyAvailable);
    if (!body) return;
    const name = 'harvester_' + spawn.name + '_' + Game.time;
    const memory = { role: 'harvester', spawn: spawn.id, home: room.name, task: 'idle' };
    const source = assignSource(room, data);
    if (source) memory.sourceId = source.id;

    const r = spawn.spawnCreep(body, name, { memory: memory });
    if (r === OK) {
        console.log('[FW] ' + room.name + ' 富余能量孵化 harvester -> ' + name);
        data.creepsByRole.harvester = (data.creepsByRole.harvester || 0) + 1;
    }
}

module.exports = {
    housekeeping,
    ownedRooms,
    runRoom,
    runSpawns,
    computeQuota,
};
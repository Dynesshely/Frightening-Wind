/**
 * 建造规划：容器 / 扩展 / 塔 / link / 道路 / 边境工事。
 * 从 economy.js 拆出，保持“选址 → 建站”的单一职责。
 */
const config = require('config');
const utils = require('utils');

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

/**
 * 地形感知的"不封路"校验。
 * 在 spawn 周围 11x11 的窗口里，把"地形墙 + 已有结构/工地 + 待放位置"都当障碍，
 * 从 spawn 做一次洪水填充；如果放上去之后 spawn 能到达的窗口边界格少于 6 个，就判定会封路。
 * 这样地形墙本身挡住的方向不算数，只有"本来能走、却被建筑堵死"才算问题。
 */
function wouldBlockAccess(room, occ, spot, center) {
    // P1：统一到 utils 的单一实现（规划期与运行期共用同一套判定）
    return utils.wouldBlockAccess(room, occ, spot, center);
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

    // 0) 新占房间引导：没有 spawn 也没有 spawn 工地时，先在控制器附近起一个
    if (data.spawns.length === 0 && countSites(data, STRUCTURE_SPAWN) === 0 && level >= 1) {
        const spots = freeSpots(room, occ, center.x, center.y, 2, 6, []);
        if (spots.length && createSite(room, spots[0], STRUCTURE_SPAWN, 'bootstrap')) {
            occ[spots[0].x + ',' + spots[0].y] = true;
            created++;
        }
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

    // 3) 扩展（避让 spawn 的十字通道：x==center.x 或 y==center.y 的格子永不建结构，
    //    否则一圈围墙会把 spawn 包死，单位挤在里面互相卡住）
    const extLimit = config.extensionLimit[level] || 0;
    const highway = avoid.slice();
    for (let i = 2; i <= 12; i++) {
        highway.push({ x: center.x, y: center.y - i });
        highway.push({ x: center.x, y: center.y + i });
        highway.push({ x: center.x - i, y: center.y });
        highway.push({ x: center.x + i, y: center.y });
    }
    let extTotal = data.extensions.length + countSites(data, STRUCTURE_EXTENSION);
    while (extTotal < extLimit && created < config.maxNewSitesPerTick && siteCount() < siteLimit) {
        const spots = freeSpots(room, occ, center.x, center.y, 2, 8, highway);
        if (!spots.length) break;
        // 逐个候选做连通性校验：会封路就跳过（地形墙方向不算，可走方向必须留够）
        let spot = null;
        for (const cand of spots) {
            if (!wouldBlockAccess(room, occ, cand, center)) { spot = cand; break; }
        }
        if (!spot) break;
        if (createSite(room, spot, STRUCTURE_EXTENSION)) {
            occ[spot.x + ',' + spot.y] = true;
            // ★ 与相邻扩展保持 1 格间隔（棋盘式）。
            //   紧贴摆放会连成一堵墙：accessCount 的 BFS 判定"还连通"（缝宽 1 格），
            //   但十几个 creep 抢一条 1 格缝就变成互堵 —— 线上 W7N1 就是这幅景象
            //   （扩展排成一条线，单位全卡在缝里，截图确认）。
            //   把上下左右也标成占用，强制留出"十字通道"。
            const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const d of NB) {
                const nx = spot.x + d[0];
                const ny = spot.y + d[1];
                if (nx >= 1 && nx <= 48 && ny >= 1 && ny <= 48) occ[nx + ',' + ny] = true;
            }
            created++;
            extTotal++;
        } else break;
    }

    // 4) 塔（RCL3+）：按"来敌方向"摆在边境 8~12 格处
    const towerLimit = config.towerLimit[level] || 0;
    let towerTotal = data.towers.length + countSites(data, STRUCTURE_TOWER);
    if (towerTotal < towerLimit && created < config.maxNewSitesPerTick) {
        const spot = pickTowerSpot(room, data, occ, towerTotal);
        if (spot && createSite(room, spot, STRUCTURE_TOWER, 'border-defense')) {
            occ[spot.x + ',' + spot.y] = true;
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

    // 5.8) 边境工事（RCL4+，且当前工地不多时才做）：威胁方向的出口铺 rampart
    if (level >= 4 && created < config.maxNewSitesPerTick && siteCount() < 2) {
        planBorderRamparts(room, data, occ, created);
    }

    // 6) 道路：只铺主要通勤路径上的沼泽段（平地本来就能满速走，铺路是浪费）
    if (level >= 2 && created < config.maxNewSitesPerTick) {
        planRoads(room, data, occ, created);
    }
}

/**
 * 边境 rampart：在"来敌方向"的出口格上铺 rampart。
 * 自己的 creep 可以在自己的 rampart 上通行，敌对 creep 必须先把 rampart 打穿，
 * 所以这是最划算的边境封锁方式。总量控制得很小（<=10 格），不跟扩展开工抢资源。
 */
function planBorderRamparts(room, data, occ, createdBudget) {
    const spawn = data.spawns[0];
    if (!spawn) return;

    // 咽喉点一次算好就永久缓存（只跟地形和 spawn 位置有关，二者都不变）
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.choke) Memory.fw.choke = {};
    const ckey = room.name + ':' + spawn.id;
    let pts = Memory.fw.choke[ckey];
    if (!pts) {
        pts = utils.chokePoints(room, spawn);
        Memory.fw.choke[ckey] = pts;
        if (pts.length) {
            console.log('[FW] ' + room.name + ' 咽喉 ' + pts.length + ' 格: ' + pts.slice(0, 6).join(' '));
        }
    }
    // 找不到明显的咽喉（开阔房间）就先不建 —— 沿边界随便撒 rampart 是纯浪费
    if (!pts.length) return;

    const near = (x, y) => {
        for (const p of pts) {
            if (Math.abs(p[0] - x) <= 1 && Math.abs(p[1] - y) <= 1) return true;
        }
        return false;
    };

    // 撤销建错位置的 rampart 工地（只删工地；已建成的保留，避免拆了又建）
    const stale = [];
    for (const s of data.sites) {
        if (s.structureType !== STRUCTURE_RAMPART) continue;
        if (!near(s.pos.x, s.pos.y)) stale.push(s);
    }
    for (const s of stale) {
        console.log('[FW] ' + room.name + ' 撤销错位 rampart 工地 @' + s.pos.x + ',' + s.pos.y);
        s.remove();
    }

    let existing = 0;
    for (const w of (data.walls || [])) if (w.structureType === STRUCTURE_RAMPART) existing++;
    for (const s of data.sites) if (s.structureType === STRUCTURE_RAMPART) existing++;

    const limit = config.maxBorderRamparts || 12;
    for (const p of pts) {
        if (existing >= limit) break;
        if (createdBudget >= config.maxNewSitesPerTick) break;
        const x = p[0];
        const y = p[1];
        if (occ[x + ',' + y]) continue;
        if (room.createConstructionSite(x, y, STRUCTURE_RAMPART) === OK) {
            occ[x + ',' + y] = true;
            createdBudget++;
            existing++;
            console.log('[FW] ' + room.name + ' 咽喉 rampart @' + x + ',' + y);
        }
    }
}

/**
 * 塔防选址：边境防御思路——把塔摆在"来敌方向"上，离 spawn 8~12 格。
 * 单塔时覆盖基地+卡住主要来路；多塔时按威胁优先级覆盖不同方向。
 */
function pickTowerSpot(room, data, occ, towerIndex) {
    const spawn = data.spawns[0];
    if (!spawn) return null;
    const sx = spawn.pos.x;
    const sy = spawn.pos.y;

    // 四个方向：1=北(0,-1) 3=东(1,0) 5=南(0,1) 7=西(-1,0)
    const dirs = [
        { d: 1, dx: 0, dy: -1 },
        { d: 3, dx: 1, dy: 0 },
        { d: 5, dx: 0, dy: 1 },
        { d: 7, dx: -1, dy: 0 },
    ];

    let exits = {};
    try {
        exits = Game.map.describeExits(room.name) || {};
    } catch (e) {
        exits = {};
    }

    // 打分：最近敌人在这个方向 +6；有出口 +3；控制器在这个方向 +2
    const last = Memory.fw && Memory.fw.lastHostile;
    for (const dir of dirs) {
        let score = 0;
        if (exits[dir.d]) score += 3;
        if (last && (Game.time - last.t) < 3000) {
            const vx = last.x - sx;
            const vy = last.y - sy;
            if (dir.dx !== 0 && Math.sign(vx) === dir.dx && Math.abs(vx) > Math.abs(vy)) score += 6;
            if (dir.dy !== 0 && Math.sign(vy) === dir.dy && Math.abs(vy) > Math.abs(vx)) score += 6;
        }
        if (room.controller) {
            const cx = room.controller.pos.x - sx;
            const cy = room.controller.pos.y - sy;
            if (dir.dx !== 0 && Math.sign(cx) === dir.dx) score += 2;
            if (dir.dy !== 0 && Math.sign(cy) === dir.dy) score += 2;
        }
        dir.score = score;
    }
    dirs.sort((a, b) => b.score - a.score);

    const dir = dirs[towerIndex % dirs.length];
    // 在 spawn 沿该方向 8~12 格的范围内找空位
    const cx = sx + dir.dx * 10;
    const cy = sy + dir.dy * 10;
    const spots = freeSpots(room, occ, cx, cy, 0, 4, []);
    if (spots.length) return { x: spots[0].x, y: spots[0].y, dir: dir.d };
    return null;
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


module.exports = {
    occupancy, countSites, freeSpots, createSite, wouldBlockAccess,
    planConstruction, planBorderRamparts, planRoads,
    pickTowerSpot, findLinkSpot, runLinks, containerNear, sourceHasContainer,
};

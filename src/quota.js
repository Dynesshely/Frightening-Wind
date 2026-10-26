/**
 * 配额计算：按房间状态推导每个角色需要多少人，并按总人口上限裁剪。
 * 从 economy.js 拆出，纯函数、无副作用，便于单独推理与测试。
 */
const config = require('config');
const utils = require('utils');
const war = require('war');
const construction = require('construction');

function computeQuota(room, data) {
    const level = data.level;
    const capacity = room.energyCapacityAvailable || 300;

    const quota = { harvester: 0, miner: 0, hauler: 0, builder: 0, upgrader: 0 };

    // 每个矿源按"地形能站几个位"来定编，而不是无脑 2 人一个源：
    // 站位不够就少派人（否则就是排队干等），站位够但产能已满也只要 2 人
    // （矿源 3000 能量 / 300 tick 再生 = 10 E/tick，2 个 3WORK 矿工刚好吃满）

    // 已经被容器覆盖的矿源交给静态矿工
    let containerized = 0;
    for (const s of data.sources) {
        if (construction.sourceHasContainer(data, s)) containerized++;
    }
    const bare = data.sources.length - containerized;

    // ---- 矿工编制按 WORK 数反推（docs/OPTIMIZATION.md F5）----
    // source 稳态产出  Y(n) = 10n/(5+n)  →  n = 5Y/(10−Y)
    // 旧实现按"地形站位"定编、每源最多 2 人，并假设"2 个 3WORK 吃满 10 e/tick"，
    // 但模型算出来 2 个 3WORK 只有 5.45 e/tick —— 这个假设把产能天花板压掉了一半。
    const targetPerSource = level >= 6 ? 8.0
        : (level >= 5 ? 7.5 : (level >= 4 ? 6.67 : 5.0));
    const needWork = Math.ceil((5 * targetPerSource) / (10 - targetPerSource));
    const WORK_PER_MINER = 5;                                   // 5W1C1M
    const minersPerSource = Math.max(1, Math.ceil(needWork / WORK_PER_MINER));

    // 按"WORK 缺口"而不是"人头"定编：线上还有一批 1W1C1M 的老矿工，
    // 如果只数人头（4 个 > 配额 2）就永远轮不到造 5W 矿工，产能被老身体锁死。
    let existingMinerWork = 0;
    for (const c of data.creeplist) {
        if (!c.memory || c.memory.role !== 'miner') continue;
        for (const p of (c.body || [])) if (p.type === WORK) existingMinerWork++;
    }
    // 每源分别按"自己的站位格数"封顶，不能把所有源的槽位加在一起算。
    // 线上事故：source A 只有 1 个可站格，却被算出 4 个矿工编制，
    // 抢不到槽位的矿工回退成自由采集，把占位矿工挤来挤去，整条采集链崩掉。
    let wantedMiners = 0;
    for (const s of data.sources) {
        if (!construction.sourceHasContainer(data, s)) continue;
        wantedMiners += Math.min(minersPerSource, Math.max(1, utils.harvestSlots(s)));
    }
    const missingWork = Math.max(0, needWork * Math.max(1, containerized) - existingMinerWork);
    quota.miner = Math.max(0, Math.min(wantedMiners, Math.ceil(missingWork / WORK_PER_MINER)));

    // 自采工人：没有容器的矿源用自采自送（效率只有 60%），编制跟着 RCL 走
    quota.harvester = 0;
    for (const s of data.sources) {
        if (construction.sourceHasContainer(data, s)) continue;
        const selfHaul = level >= 4 ? 3 : (capacity >= 800 ? 2 : 1);
        quota.harvester += Math.max(1, Math.min(selfHaul, utils.harvestSlots(s)));
    }

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
    // "经济健康"不能只看人头：线上出现过 7 个经济单位 + 2 个巡逻兵，而 spawn 存量长期
    // 只有 14 能量、容器全空的情况 —— 人头够了但根本没钱。加一道能量门槛。
    const econHealthy = econCount >= 2
        && (utils.countRole(data, 'harvester') + utils.countRole(data, 'miner')) >= 1
        && (room.energyAvailable || 0) >= 200;

    // 战争计划：每 tick 更新（模块内部自带经济门槛，不满足时返回 idle）
    const warPlan = war.update(room, data);

    const militaryAllowed = (data.hostiles && data.hostiles.length > 0) || level >= 2;
    if (econHealthy && militaryAllowed) {
        // 士兵：按目标实力反算需要的兵力；不足时攒兵，达标后自动出击
        quota.soldier = Math.max(1, warPlan.needUnits || 0);
        quota.soldier = Math.max(quota.soldier, data.hostiles && data.hostiles.length > 0
            ? Math.min(4, data.hostiles.length + 1)
            : 1);
        // 边防巡逻队：RCL3 起常备 2 人，在相邻房间之间来回巡逻清野；受袭时加到 3
        if (level >= 3) {
            // 目标：边境一半以上的房间时刻有人巡逻
            const patrolBase = (capacity >= 800 ? 3 : 2) + (warPlan.patrolBonus || 0);
            quota.patroller = (data.hostiles && data.hostiles.length > 0) ? patrolBase + 1 : patrolBase;
        }
        // 侦查兵（安全房间）：相邻房间情报缺失/过期时才派 1 个
        quota.scout = hasStaleNeighbor(room.name) ? config.maxScouts : 0;
        // 侦察兵（危险房间）：有"有主/见过敌人 + 情报过期"的相邻房间才派
        quota.recon = hasReconTarget(room.name) ? 1 : 0;
    }

    // 升级者：容器体系搭起来后它就是"消耗端"，全链吞吐都被它卡着，所以要多配。
    // RCL2~4: 4 个；RCL5+: 5 个（再高由下面的"库存自适应"继续加）
    // 没有容器时也必须有人升级，否则控制器会降级（线上真踩过）
    // 消耗端不能多于供给端：旧值 RCL4 配 4 个，而实测供给只有 0.70 e/tick，
    // 每个升级者 83% 时间待命，摊销 0.53 e/tick 却吃掉了升级量的 76%（F6）。
    // 先用 3 个，等 F1~F5 把供给拉起来后再由下面的"库存自适应"自动加。
    quota.upgrader = containerized > 0
        ? (level >= 5 ? 4 : 3)
        : (level >= 1 ? 2 : 0);

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
    // 远程采集：本地矿源站位已满（多余劳力）就往外派
    quota.remoteHarvester = 0;
    const localMining = (utils.countRole(data, 'harvester') || 0) + (utils.countRole(data, 'miner') || 0);
    const localCap = (quota.harvester || 0) + (quota.miner || 0);
    const saturated = localMining >= localCap;
    if (level >= 2 && saturated && data.creeplist.length >= 8) {
        quota.remoteHarvester = level >= 4 ? 3 : 1;
    }

    // 道路通畅维保员：常备 1 人（RCL2+），关键节点被堵就拆
    // 道路保障员编制已取消：改由矿工/建造者在作业途中顺手清障
    quota.roadKeeper = 0;

    // 护航军：远程采集队成规模后 1~2 人贴身护航
    quota.escort = 0;
    if ((quota.remoteHarvester || 0) > 0 && utils.countRole(data, 'remoteHarvester') >= 2) {
        quota.escort = Math.min(2, Math.floor(utils.countRole(data, 'remoteHarvester') / 2));
    }

    // 远程接驳工：有远程矿工时配 1 个（只跑"远程容器 -> 老家"这一段）
    quota.remoteHauler = 0;
    if ((quota.remoteHarvester || 0) > 0 && utils.countRole(data, 'remoteHarvester') >= 2) {
        quota.remoteHauler = 1;
    }

    // 扩张：① 已占但没 spawn 的房间 -> 派开拓者；② GCL 允许 -> 派占房者
    quota.claimer = 0;
    quota.pioneer = 0;
    if (data.spawns.length > 0) {
        const ownedRooms = [];
        for (const n in Game.rooms) {
            const r = Game.rooms[n];
            if (r.controller && r.controller.my) ownedRooms.push(r);
        }
        let bootstrapRoom = null;
        for (const r of ownedRooms) {
            if (r.name === room.name) continue;
            if (r.find(FIND_MY_SPAWNS).length === 0) { bootstrapRoom = r; break; }
        }
        if (bootstrapRoom) {
            let pioneers = 0;
            for (const n in Game.creeps) {
                const c = Game.creeps[n];
                if (c.memory && c.memory.role === 'pioneer' && c.memory.home === bootstrapRoom.name) pioneers++;
            }
            quota.pioneer = Math.max(0, 2 - pioneers);
        } else if (Game.gcl && Game.gcl.level > ownedRooms.length) {
            const t = pickClaimTarget(room);
            if (t) quota.claimer = 1;
        }
    }

    // 总人数上限：按"先砍谁最不痛"的顺序裁剪，保证矿工/建造者/升级者都还留得住人
    const cap = creepCap(room);
    let total = quota.harvester + quota.miner + quota.hauler + quota.builder + quota.upgrader
        + (quota.soldier || 0) + (quota.patroller || 0) + (quota.scout || 0) + (quota.recon || 0)
        + (quota.remoteHarvester || 0) + (quota.reserver || 0)
        + (quota.claimer || 0) + (quota.pioneer || 0) + (quota.roadKeeper || 0)
        + (quota.remoteHauler || 0) + (quota.escort || 0);
    const floors = {
        // 增长引擎保底：矿工不砍、升级者/建造者各留 2、搬运 1、守卫各 1
        miner: quota.miner || 0,
        harvester: Math.min(2, quota.harvester || 0),
        upgrader: Math.min(containerized > 0 ? 2 : 2, quota.upgrader || 0),
        builder: data.sites.length > 0
            ? Math.min(data.sites.length >= 4 ? 3 : 2, quota.builder || 0)
            : 0,
        hauler: Math.min(2, quota.hauler || 0),
        soldier: 1,
        patroller: 1,
    };
    // 裁剪顺序：先砍外围（远程/占领/侦查），最后才动经济核心
    const trimOrder = ['claimer', 'pioneer', 'roadKeeper', 'remoteHarvester', 'reserver', 'recon', 'scout', 'patroller', 'hauler', 'harvester', 'builder', 'upgrader'];
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
 * 挑一个值得"占领"的相邻房间（无主、没敌人、矿源越多越优先）
 */
function pickClaimTarget(room) {
    const cands = utils.expansionCandidates(room.name);
    for (const c of cands) {
        if (c.sources >= 2) return c.room;
    }
    return cands.length ? cands[0].room : null;
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
/**
 * 挑一个可以远程采矿的相邻房间。skip=已占用的目标数，用来把多个远程采集者摊到不同房间。
 * 优先"无主 + 没敌人 + 矿源多"的房间。
 */
function pickRemoteTarget(room, data, skip) {
    const cands = utils.expansionCandidates(room.name);
    const usable = [];
    for (const c of cands) {
        const bad = (Memory.fw && Memory.fw.unreachable && Memory.fw.unreachable[c.room]) || 0;
        if (bad && Game.time - bad < 3000) continue;   // 近期反复走不到的房间，先跳过
        const info = utils.getIntel(c.room);
        if (!info || !info.sources || !info.sources.length) continue;
        if (info.hostiles > 0) continue;
        usable.push({ room: c.room, sources: info.sources, mineral: info.mineral });
    }
    if (!usable.length) return null;
    usable.sort((a, b) => b.sources.length - a.sources.length);
    const idx = (skip || 0) % usable.length;
    const pick = usable[idx];
    // 同一个房间有多个矿源时，按索引换一个矿源
    const src = pick.sources[((skip || 0) / usable.length | 0) % pick.sources.length];
    return { room: pick.room, sourceId: src ? src.id : undefined };
}

/**
 * 相邻房间是否有"值得冒险侦察"的目标（有主/见过敌人 + 情报过期）
 */
function hasReconTarget(homeName) {
    let exits;
    try {
        exits = Game.map.describeExits(homeName) || {};
    } catch (e) {
        return false;
    }
    for (const dir in exits) {
        const name = exits[dir];
        if (!name || name === homeName) continue;
        const info = utils.getIntel(name);
        const age = info ? (Game.time - info.t) : 9999999;
        if (age < config.reconStaleTicks) continue;
        if (!info) return true;
        if ((info.controller && info.controller.owner) || info.hostiles > 0) return true;
    }
    return false;
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
    // 扩编：给采矿队/护航队腾空间
    return 12 + Math.floor((room.energyCapacityAvailable || 300) / 100);
}


module.exports = {
    computeQuota, creepCap, pickSpawnRole, pickClaimTarget, pickReserveTarget,
    pickRemoteTarget, hasReconTarget, hasStaleNeighbor,
};

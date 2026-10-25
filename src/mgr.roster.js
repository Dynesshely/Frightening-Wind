/**
 * mgr.roster —— 人口与角色重排（不造人，只调整"谁干什么"）。
 *
 * 负责：
 *   1. 配额缺口对比：按 config.spawnPriority 算出每个角色缺几个（缺得越狠排越前）；
 *   2. 就地转职 rebalanceRoles：从"超编角色"里征调身体合适的 creep 直接改 memory.role，
 *      岗位空缺立刻补上，不用等 spawn 造人；矿工要绑有容器的矿源，远程采集要目标房间；
 *   3. 超编回收 recycleSurplus：身体不合适、又明显超编且还能活很久的单位送回 spawn 回收；
 *   4. 身体能力判定 canDo：某身体能不能胜任某角色。
 *
 * 不该放进来：
 *   - 孵化/身体组装/命名（mgr.spawn）；配额与目标房间的计算（quota.js）；
 *   - runRoom 的调度顺序（economy.js 保留编排骨架）；
 *   - 任何移动：本模块只改 memory.role，不移动 creep，也不允许出现 creep.moveTo / creep.move。
 *
 * 依赖：config / utils / quota / construction（判断矿源是否已有容器），单向无循环。
 */

const config = require('config');
const utils = require('utils');
const quotaMod = require('quota');
const construction = require('construction');

/* ------------------------------ 回收超编 ------------------------------ */

/**
 * 回收超编单位：转职转不动（身体不合适）时，把"明显超编 + 还能活很久"的单位
 * 送回 spawn 回收，名额让给缺人的岗位。回收返还 50% 身体能量。
 */
function recycleSurplus(room, data, quota, deficits) {
    const have = n => utils.countRole(data, n);
    for (const d of deficits) {
        if (have(d.role) >= (quota[d.role] || 0)) continue;
        for (const creep of data.creeplist) {
            if (have(d.role) >= (quota[d.role] || 0)) break;
            const cur = creep.memory && creep.memory.role;
            if (!cur || cur === d.role) continue;
            const want = quota[cur] || 0;
            // 至少超编 2 个，且还能活 400 tick 以上（快死的等它自己死）
            if (have(cur) <= want + 1) continue;
            if ((creep.ticksToLive || 1500) < 400) continue;
            if (cur === 'soldier' || cur === 'patroller') continue;   // 守卫不回收
            creep.memory.recycle = true;
            console.log('[FW] ' + creep.name + ' 超编(' + cur + ' ' + have(cur) + '/' + want + ')，回收换名额给 ' + d.role);
            if (data.ownedByRole) data.ownedByRole[cur] = Math.max(0, (data.ownedByRole[cur] || 0) - 1);
            data.creepsByRole[cur] = Math.max(0, (data.creepsByRole[cur] || 0) - 1);
            break;
        }
    }
}

/* ------------------------------ 身体能力 ------------------------------ */

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

/* ------------------------------ 角色重排 ------------------------------ */

/**
 * 通用补位：某个角色缺人时，从"高于下限的冗余角色"里征调身体合适的 creep 就地转职。
 * 好处是岗位空缺立刻补上，不用等 spawn 造人（造人要 3*部件数 tick + 攒能量）。
 */
function rebalanceRoles(room, data) {
    const quota = quotaMod.computeQuota(room, data);
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
    recycleSurplus(room, data, quota, deficits);

    const containerSources = data.sources.filter(s => construction.sourceHasContainer(data, s));

    for (const d of deficits) {
        for (const creep of data.creeplist) {
            if (d.missing <= 0 || have(d.role) >= (quota[d.role] || 0)) break;
            const cur = creep.memory && creep.memory.role;
            if (!cur || cur === d.role) continue;
            if (!canDo(creep, d.role)) continue;
            // 关键：只从"超编"角色抽调。贴边达标的岗位（尤其矿工）一律不动，
            // 否则会出现"矿工被转去远程采集 -> 矿源无人开采"的隐性停摆。
            if (have(cur) <= (quota[cur] || 0)) continue;
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
                const target = quotaMod.pickRemoteTarget(room, data);
                if (!target) continue;
                creep.memory.targetRoom = target.room;
                creep.memory.sourceId = target.sourceId;
            }

            if (cur && (Game.time - (creep.memory.roleSince || 0)) < 150) continue;   // 滞回：刚转职的先别动
            creep.memory.role = d.role;
            creep.memory.roleSince = Game.time;
            creep.memory.working = undefined;
            creep.memory.noEnemySince = undefined;
            creep.memory.recycle = undefined;
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

module.exports = {
    rebalanceRoles,
    canDo,
    recycleSurplus,
};

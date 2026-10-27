/**
 * mgr.spawn —— 孵化与身体：贴标、利用率统计、选兵、造兵。
 *
 * 负责：
 *   1. tagSpawns：给引擎自动命名的 spawn 贴稳定业务标签（Root / FW-<房间>-N），
 *      顺带累计 spawn 利用率 Memory.fw.spawnUsage（每 50 tick 结算一次）；
 *   2. runSpawns：按配额缺口挑角色 → 挑身体（RCL1 先用便宜小身体）→ 选 spawn →
 *      写初始 memory（矿源/目标房间/扇区/巡逻序号）→ spawnCreep，并在失败时按错因降级；
 *   3. spawnSurplus：配额已满但 spawn 满仓时，多造一个采集者把能量转成产能。
 *
 * 不该放进来：
 *   - 配额与目标房间的计算（quota.js：computeQuota / pickSpawnRole / pickClaimTarget…）；
 *   - 已有单位的人口重排、转职、回收（mgr.roster）；
 *   - 矿源分配本身（mgr.room.assignSource，本模块只调用它）；
 *   - 任何移动：本模块不移动 creep，也不允许出现 creep.moveTo / creep.move。
 *
 * 分层：mgr.spawn → mgr.room（矿源分配）+ config / utils / quota，单向。
 */

const config = require('config');
const utils = require('utils');
const quotaMod = require('quota');
const roomMgr = require('mgr.room');

/* ------------------------------ Spawn 贴标与利用率 ------------------------------ */

/**
 * Spawn 业务命名：引擎给 spawn 自动起名（Spawn1/Spawn2...），
 * 这里给每个 spawn 贴一个稳定的业务标签，供日志与调度使用。
 * 规则：主基地第一个 spawn = Root；其余 = FW-<房间名>（同房多个再加 -2/-3）
 */
function tagSpawns(rooms) {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.spawnTags) Memory.fw.spawnTags = {};
    // Spawn 利用率：空闲 tick / 总 tick（验证"spawn 是否已成瓶颈"）
    if (!Memory.fw.spawnStat) Memory.fw.spawnStat = { busy: 0, total: 0, t: Game.time };
    const SS = Memory.fw.spawnStat;
    SS.total++;
    let anyBusy = false;
    for (const r of rooms) {
        if (anyBusy) break;
        for (const sp of (r.find(FIND_MY_SPAWNS) || [])) { if (sp.spawning) { anyBusy = true; break; } }
    }
    if (anyBusy) SS.busy++;
    if (Game.time - SS.t >= 50) {
        Memory.fw.spawnUsage = { t: Game.time, ratio: SS.total ? (SS.busy / SS.total) : 0 };
        SS.busy = 0; SS.total = 0; SS.t = Game.time;
    }
    const tags = Memory.fw.spawnTags;
    for (const room of rooms) {
        const spawns = room.find(FIND_MY_SPAWNS);
        if (!spawns || !spawns.length) continue;
        let n = 0;
        for (const spawn of spawns) {
            n++;
            if (tags[spawn.id]) continue;
            if (spawn.name === 'Root') { tags[spawn.id] = 'Root'; continue; }
            tags[spawn.id] = 'FW-' + room.name + (n > 1 ? '-' + n : '');
            console.log('[FW] 新 spawn 贴标: ' + spawn.name + ' -> ' + tags[spawn.id]);
        }
    }
}

/* ------------------------------ 孵化入口 ------------------------------ */

/**
 * 选出"缺口最大"的角色（按 count/quota 比例），
 * 这样不会因为采集者不断老死而永远轮不到升级者/建造者。
 */
function runSpawns(room, data) {
    if (!data.spawns.length) return;
    const free = data.spawns.filter(s => !s.spawning);
    if (!free.length) return;

    // V2 架构下由 core.policy 给出目标人数；关闭时走旧的配额表
    const useV2 = !!(config.core && config.core.v2 && data.v2plan && data.v2plan.roles);
    const quota = useV2
        ? Object.assign({}, data.v2plan.roles)
        : quotaMod.computeQuota(room, data);
    const wanted = quotaMod.pickSpawnRole(data, quota);

    // 总数上限：人太多会吃掉全部能量用于更新换代。
    // 但防御者属于应急，允许突破上限（不然房间里有敌人时没人能打）
    let ownedCount = 0;
    if (data.ownedByRole) for (const r in data.ownedByRole) ownedCount += data.ownedByRole[r];
    else ownedCount = data.creeplist.length;

    const urgentMilitary = wanted.length > 0 && (wanted[0] === 'soldier' || wanted[0] === 'patroller');
    if (!urgentMilitary && ownedCount >= quotaMod.creepCap(room)) return;

    if (!wanted.length) {
        // 配额已满但 spawn 满仓（能量没处花）：多造一个采集者换产能，上限见 cap
        return spawnSurplus(room, data, quota, free[0]);
    }

    // 孵化预算：目标不是"有多少花多少"，而是"攒到值得的身体再孵"。
    // 旧实现用 room.energyAvailable（实测均值 120）当预算，永远只造得出 1W1C1M；
    // 现在按 config.spawn.budget 给每个角色一个目标成本，不够就等（见 docs/OPTIMIZATION.md F1）。
    const capacityAvailable = room.energyCapacityAvailable || 300;
    const available = room.energyAvailable;
    const spawnCfg = config.spawn || {};
    const budgets = spawnCfg.budget || {};

    if (!Memory.fw.spawnWait) Memory.fw.spawnWait = {};
    if (!Memory.fw.spawnWait[room.name]) Memory.fw.spawnWait[room.name] = { t: 0, role: null };
    const wait = Memory.fw.spawnWait[room.name];

    // 保命模式：人口不足时"先补人"优先于"身体质量"。
    // 线上实测：只按预算攒钱、不管人口，850 tick 内人口 17 → 6，采集链崩掉后更攒不到钱。
    const population = (data.creeplist && data.creeplist.length) || 0;
    const emergency = population < (spawnCfg.minPopulation || 12);
    const baseBudget = emergency ? available : capacityAvailable;

    // 保命模式下只补采集者：能量必须投在"能自我复制"的岗位，
    // 先造升级者/建造者会把口粮分走，人口永远爬不起来。
    // 保命模式：人口不足时优先补采集者。
    // 但 v2 架构下 core.policy 已经按预算算过人数与优先级，这层过滤是重复的，
    // 而且会在"采集者已满、缺的是升级者"时把 candidates 裁空（线上本地推演踩过）。
    let candidates = wanted;
    if (emergency && !useV2) {
        const econ = wanted.filter(r => r === 'miner' || r === 'harvester');
        if (econ.length) candidates = econ;
    }

    // 已经在为某个大身体攒钱、且人口够用：专心攒，不要再造便宜角色把能量花掉。
    // 否则会出现"永远在等 600，却不停造 200 的兵"——攒钱状态被自己的孵化打断。
    const pending = Memory.fw.spawnReserve && Memory.fw.spawnReserve[room.name];
    if (pending && !emergency) {
        const expired = Game.time - (pending.t || 0) > (spawnCfg.starveTicks || 90) * 2;
        if (!expired && available < pending.need) return;
    }

    // 按缺口比例依次尝试：能量够得着哪个角色的目标成本，就造哪个
    let role = null;
    let body = null;
    for (const candidate of candidates) {
        const def = config.bodies[candidate];
        if (!def) continue;
        // V2：policy 已经把"目标体型的完整 body 数组"算好了（含 1:1 的 MOVE 配比），
        // 这里只需要确认能量够付得起。
        if (useV2 && data.v2plan.bodies && data.v2plan.bodies[candidate]) {
            const fixed = data.v2plan.bodies[candidate];
            const cost = utils.bodyCost(fixed);
            if (available >= cost) { role = candidate; body = fixed; break; }
            continue;
        }
        const want = budgets[candidate] || 0;
        let target = Math.min(want > 0 ? want : baseBudget, baseBudget);
        if (def.maxCost) target = Math.min(target, def.maxCost);
        // 差一点点也放行：线上实测 spawn+扩展 448、预算 450，只差 2 点就卡死整个孵化。
        // 放行后用"实际可用能量"拼身体（会自动降一档），比干等更划算。
        if (available < target * 0.95) {
            // 记下"正在为哪个角色攒钱"，fw.store 会据此决定暂停把能量继续灌进 spawn/扩展
            if (!Memory.fw.spawnReserve) Memory.fw.spawnReserve = {};
            if (!Memory.fw.spawnReserve[room.name]) {
                Memory.fw.spawnReserve[room.name] = { need: target, role: candidate, t: Game.time };
            } else {
                Memory.fw.spawnReserve[room.name].need = Math.max(
                    Memory.fw.spawnReserve[room.name].need, target);
                Memory.fw.spawnReserve[room.name].role = candidate;
            }
            continue;
        }
        const b = utils.planBody(candidate, Math.min(target, available));
        if (b) { role = candidate; body = b; break; }
    }

    if (!body) {
        // 所有角色都没攒够：先等着。但等过头就退化成"有多少造多少"，避免人口断档。
        const minE = spawnCfg.minEnergy || 200;
        if (available < minE) return;
        const waited = wait.t ? (Game.time - wait.t) : 0;
        if (waited < (spawnCfg.starveTicks || 240)) {
            if (!wait.t) { wait.t = Game.time; wait.role = wanted[0] || null; }
            return;
        }
        for (const candidate of candidates) {
            const b = utils.planBody(candidate, available);
            if (b) { role = candidate; body = b; break; }
        }
        if (!body) return;
        console.log('[FW] ' + room.name + ' 攒钱超时（' + waited + ' tick），降级孵化 ' + role);
    }
    wait.t = 0;
    wait.role = null;
    if (Memory.fw.spawnReserve) delete Memory.fw.spawnReserve[room.name];

    const spawn = free[0];
    const name = role + '_' + spawn.name + '_' + Game.time;
    const memory = { role: role, spawn: spawn.id, home: room.name, task: 'idle' };

    if (role === 'harvester') {
        const source = roomMgr.assignSource(room, data, false);
        if (source) memory.sourceId = source.id;
    } else if (role === 'miner') {
        const source = roomMgr.assignSource(room, data, true);
        if (source) memory.sourceId = source.id;
    } else if (role === 'claimer') {
        const t = quotaMod.pickClaimTarget(room);
        if (!t) return;
        memory.targetRoom = t;
    } else if (role === 'pioneer') {
        // 开拓者由老家孵化，但归属新房间
        let target = null;
        for (const n in Game.rooms) {
            const r = Game.rooms[n];
            if (!r.controller || !r.controller.my) continue;
            if (r.name === room.name) continue;
            if (r.find(FIND_MY_SPAWNS).length === 0) { target = r.name; break; }
        }
        if (!target) return;
        memory.home = target;
    } else if (role === 'soldier') {
        // 士兵和巡逻兵共用扇区编号，保证覆盖不重叠
        memory.sector = utils.countRole(data, 'patroller') + utils.countRole(data, 'soldier');
    } else if (role === 'patroller') {
        memory.sector = utils.countRole(data, 'patroller');
        memory.patrolIndex = memory.sector;
    } else if (role === 'reserver') {
        const target = quotaMod.pickReserveTarget(room);
        if (!target) return;
        memory.targetRoom = target;
    } else if (role === 'remoteHarvester') {
        const target = quotaMod.pickRemoteTarget(room, data, utils.countRole(data, 'remoteHarvester'));
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
    const cap = quotaMod.creepCap(room);
    let total = 0;
    for (const role in data.creepsByRole) total += data.creepsByRole[role];
    if (total >= cap) return;
    // 旧条件要求 spawn+扩展满仓（1300），实测存量只有 120，这个出口从没打开过。
    // 现在只要求"够造一个像样的采集者"，富余本来就意味着配额已满。
    const surplusFloor = Math.min(capacity, (config.spawn && config.spawn.budget
        && config.spawn.budget.harvester) || 450);
    if (room.energyAvailable < surplusFloor) return;

    const body = utils.planBody('harvester', room.energyAvailable);
    if (!body) return;
    const name = 'harvester_' + spawn.name + '_' + Game.time;
    const memory = { role: 'harvester', spawn: spawn.id, home: room.name, task: 'idle' };
    const source = roomMgr.assignSource(room, data);
    if (source) memory.sourceId = source.id;

    const r = spawn.spawnCreep(body, name, { memory: memory });
    if (r === OK) {
        console.log('[FW] ' + room.name + ' 富余能量孵化 harvester -> ' + name);
        data.creepsByRole.harvester = (data.creepsByRole.harvester || 0) + 1;
    }
}

module.exports = {
    tagSpawns,
    runSpawns,
    spawnSurplus,
};

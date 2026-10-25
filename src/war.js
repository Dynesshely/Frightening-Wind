/**
 * 战争模块：战力评估 → 兵力需求 → 集结 → 出击
 *
 * 设计原则：
 *  1. 经济优先——只有经济达到门槛才允许爆兵，绝不为打仗把 colony 饿死；
 *  2. 量敌用兵——按目标房间敌人的实际血量/火力/治疗量反算需要多少兵；
 *  3. 达标才打——兵力不足时只防守不进攻，避免添油战术；
 *  4. 复用现有能力——出击通过 Memory.fw.clearTarget 交给 soldier 的跨房间清场逻辑。
 */
const config = require('config');
const utils = require('utils');

/** 单个敌对单位的战力与血量（按 body 实测，无视野时用经验值估算） */
function evalHostile(creep) {
    let hp = 0;
    let dps = 0;
    let heal = 0;
    let parts = 0;
    const body = creep.body || [];
    for (const p of body) {
        hp += p.hits || 100;
        parts++;
        if (p.type === ATTACK) dps += 30;
        else if (p.type === RANGED_ATTACK) dps += 10;
        else if (p.type === HEAL) heal += 12;
    }
    return { hp: hp, dps: dps, heal: heal, parts: parts };
}

/** 评估某个房间的敌方战力（有视野用真实 body，无视野用情报估算） */
function assess(name) {
    const room = Game.rooms && Game.rooms[name];
    if (room) {
        let hs = [];
        try { hs = room.find(FIND_HOSTILE_CREEPS) || []; } catch (e) { hs = []; }
        if (!hs.length) return null;
        const acc = { hp: 0, dps: 0, heal: 0, count: 0 };
        for (const h of hs) {
            const e = evalHostile(h);
            acc.hp += e.hp; acc.dps += e.dps; acc.heal += e.heal; acc.count++;
        }
        return acc;
    }
    // 无视野：用情报里的敌人数量做保守估算（每个按 6 部件 / 1 ATTACK 计）
    const info = Memory.fw && Memory.fw.intel && Memory.fw.intel[name];
    if (info && info.hostiles > 0) {
        return { hp: info.hostiles * 600, dps: info.hostiles * 30, heal: info.hostiles * 6, count: info.hostiles };
    }
    return null;
}

/** 我方单兵火力（按当前士兵编制估算：每单元 1 个 ATTACK 部件） */
function myDpsPerUnit(level) {
    // RCL1-2 只能造 2 单元士兵，RCL3+ 按规划身体算
    const units = level >= 3 ? 3 : 2;
    return units * 30;
}

/**
 * 计算打掉目标需要的兵力数量。
 * 需要的总火力 = 敌方血量 / 解决回合数 + 敌方治疗吸收，再乘安全系数；
 * 兵力 = ceil(需要火力 / 单兵火力)，并设上下限。
 */
function requiredUnits(threat, level) {
    const t = config.war;
    const solveTicks = t.solveTicks;                     // 期望多少 tick 解决
    const needDps = threat.hp / solveTicks + threat.heal * t.healFactor;
    const withSafety = needDps * t.safetyFactor;
    const perUnit = myDpsPerUnit(level);
    let units = Math.ceil(withSafety / perUnit);
    if (units < t.minUnits) units = t.minUnits;
    if (units > t.maxUnits) units = t.maxUnits;
    return { units: units, needDps: needDps, perUnit: perUnit };
}

/**
 * 经济评分（0~100）：等级 40 + 人口 20 + 存量 25 + 产能盈余 15。
 * 侵略档位完全由这个分数决定——经济不行就老实防守，富了才主动出击。
 */
function economicScore(room, data) {
    const cfg = config.war.aggression;
    const level = data.level || 1;
    const cap = 9 + Math.floor(((room.energyCapacityAvailable || 300) / 100));
    let stored = 0;
    for (const c of (data.containers || [])) stored += c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (data.storage) stored += data.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

    const levelScore = Math.min(level, 5) / 5 * 40;
    const popScore = Math.min(1, (data.creeplist || []).length / Math.max(1, cap)) * 20;
    const energyScore = Math.min(1, stored / cfg.energyTarget) * 25;

    let busy = 0, total = 0;
    for (const sp of (data.spawns || [])) { total++; if (sp.spawning) busy++; }
    const idleRatio = total ? (total - busy) / total : 0;
    const surplusScore = idleRatio * 15;

    return Math.round(levelScore + popScore + energyScore + surplusScore);
}

/** 评分 -> 档位 */
function aggressionOf(score) {
    const cfg = config.war.aggression;
    if (score >= cfg.aggressiveAt) return 'aggressive';
    if (score >= cfg.opportunisticAt) return 'opportunist';
    return 'defensive';
}

/** 收集 N 跳内的房间名（去重，不含自己） */
function nearbyRooms(homeName, radius) {
    const seen = {};
    let frontier = [homeName];
    seen[homeName] = true;
    const out = [];
    for (let step = 0; step < radius; step++) {
        const next = [];
        for (const name of frontier) {
            let exits = {};
            try { exits = Game.map.describeExits(name) || {}; } catch (e) { exits = {}; }
            for (const dir in exits) {
                const n = exits[dir];
                if (!n || seen[n]) continue;
                seen[n] = true;
                out.push(n);
                next.push(n);
            }
        }
        frontier = next;
    }
    return out;
}

/** 挑一个值得打的目标：搜索半径内敌方战力最低且确实有敌人的 */
function pickTarget(homeName, radius) {
    const rooms = nearbyRooms(homeName, radius || 1);
    let best = null;
    for (const name of rooms) {
        const t = assess(name);
        if (!t || !t.count) continue;
        // 目标价值：矿源越多、有控制器越值得打（降低它的分数使其优先）
        let value = 0;
        try {
            const info = utils.getIntel(name);
            if (info) {
                value += (info.src || 0) * 25;
                if (info.ctrl && info.ctrl !== 'none') value += 40;
            }
        } catch (e) { }
        const score = t.count * 100 + t.dps - value;
        if (!best || score < best.score) best = { name: name, threat: t, score: score, value: value };
    }
    return best;
}

/**
 * 每 tick 更新战争状态，返回 { needUnits, phase, target }。
 * phase: idle（无战事）/ mass（攒兵）/ attack（出击）
 */
function update(room, data) {
    if (!Memory.fw) Memory.fw = {};
    const war = Memory.fw.war || (Memory.fw.war = { phase: 'idle', t: 0, needUnits: 0, target: null });
    const level = data.level || 1;
    const cfg = config.war;

    // ---- 经济门槛：达不到就完全不考虑进攻 ----
    let stored = 0;
    for (const c of (data.containers || [])) stored += c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (data.storage) stored += data.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    // 经济评分始终计算：即使在 idle 状态也要让档位可见（便于观测与调参）
    const score = economicScore(room, data);
    const aggression = aggressionOf(score);
    war.score = score;
    war.aggression = aggression;

    const econReady = level >= cfg.minLevel
        && data.creeplist.length >= cfg.minPopulation
        && stored >= cfg.minStoredEnergy;

    if (!econReady) {
        war.phase = 'idle';
        war.needUnits = 0;
        war.target = null;
        if (Memory.fw.clearTarget) Memory.fw.clearTarget = undefined;
        return { needUnits: 0, phase: 'idle', target: null, aggression: aggression, score: score, patrolBonus: 0, reason: 'econ' };
    }

    const patrolBonus = aggression === 'aggressive' ? 1 : 0;

    // defensive：只有老家正在挨打才反击，不主动出远门
    const underAttack = !!(data.hostiles && data.hostiles.length > 0);
    if (aggression === 'defensive' && !underAttack) {
        war.phase = 'idle';
        war.needUnits = 0;
        war.target = null;
        if (Memory.fw.clearTarget) Memory.fw.clearTarget = undefined;
        return { needUnits: 0, phase: 'idle', target: null, aggression: aggression, score: score, patrolBonus: 0, reason: 'defensive' };
    }

    // ---- 找目标（主动清野时搜索范围扩到 2 跳）----
    const radius = aggression === 'aggressive' ? config.war.aggression.aggressiveRadius : 1;
    const target = pickTarget(room.name, radius);
    if (!target) {
        war.phase = 'idle';
        war.needUnits = 0;
        war.target = null;
        if (Memory.fw.clearTarget) Memory.fw.clearTarget = undefined;
        return { needUnits: 0, phase: 'idle', target: null, aggression: aggression, score: score, patrolBonus: patrolBonus, reason: 'no-target' };
    }

    const req = requiredUnits(target.threat, level);
    const have = (data.creepsByRole && data.creepsByRole.soldier) || 0;

    war.target = target.name;
    war.needUnits = req.units;
    war.needDps = Math.round(req.needDps);
    war.threat = target.threat;
    war.have = have;

    if (have >= req.units) {
        // ---- 达标：出击 ----
        war.phase = 'attack';
        Memory.fw.clearTarget = target.name;
        if (war.t !== Game.time) {
            console.log('[FW] 开战 ' + target.name + '：需要 ' + req.units + ' 兵，现有 ' + have
                + '（敌方 ' + target.threat.count + ' 单位 / ' + target.threat.hp + ' 血 / '
                + target.threat.dps + ' DPS）');
            war.t = Game.time;
        }
        return { needUnits: req.units, phase: 'attack', target: target.name, aggression: aggression, score: score, patrolBonus: patrolBonus };
    }

    // ---- 兵力不足：攒兵 ----
    war.phase = 'mass';
    if (Memory.fw.clearTarget) Memory.fw.clearTarget = undefined;
    return { needUnits: req.units, phase: 'mass', target: target.name, aggression: aggression, score: score, patrolBonus: patrolBonus };
}

module.exports = { update, assess, requiredUnits, evalHostile, pickTarget, economicScore, aggressionOf, nearbyRooms };

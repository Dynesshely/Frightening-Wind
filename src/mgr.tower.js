/**
 * mgr.tower —— 塔的调度：对敌作战 / 治疗 / 维修。
 *
 * 负责：
 *   1. 每座塔的每 tick 决策链：打射程内最近的敌人 → 治疗血量比例最低的我方 creep
 *      → 能量够（config.towerRepairEnergyRatio）才挑一个结构维修，逐级降级；
 *   2. 维修目标的打分（核心结构 + 血量越低越急 + 距离越近越划算），
 *      并显式跳过 wall / rampart —— 塔修墙是能量黑洞，那是 rampart 维护策略的事；
 *   3. 返回统计对象（towers/attacked/healed/repaired），只用于观测，不参与决策。
 *
 * 不该放进来：
 *   - 威胁分类与危险等级（fw.threat）；这里拿到 data.hostiles 直接打，不做二次判定。
 *   - 防御工事规划（mgr.wall）、creep 撤退（mgr.flee）。
 *   - 任何移动：塔不会动，本模块不允许出现 moveTo / move。
 */

const config = require('config');
const threat = require('fw.threat');

/* ------------------------------ 常量 ------------------------------ */

// 塔的射程：Screeps 里塔的 attack/heal/repair 射程都是 20 格
const TOWER_ATTACK_RANGE = 20;
// 塔的治疗距离
const TOWER_HEAL_RANGE = 20;
// 塔的维修距离
const TOWER_REPAIR_RANGE = 20;

/* ------------------------------ 塔 ------------------------------ */

/**
 * 塔当前能量比例。读不到就当作 100%（宁可多修一点也不要不修）。
 */
function towerEnergyRatio(tower) {
    return threat.attempt(function () {
        if (tower.store && typeof tower.store.getCapacity === 'function') {
            const cap = tower.store.getCapacity(RESOURCE_ENERGY) || 0;
            if (cap > 0) {
                return (tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0) / cap;
            }
        }
        if (typeof tower.energyCapacity === 'number' && tower.energyCapacity > 0) {
            return (tower.energy || 0) / tower.energyCapacity;
        }
        return 1;
    }, 1);
}

/**
 * 挑一个最该修的结构：优先"核心结构且血量很低"的，其次按距离。
 * 跳过 wall / rampart（那是 Lead 的 rampart 维护策略，塔修墙是能量黑洞）。
 */
function pickRepairTarget(tower, data) {
    const structures = (data && data.structures) || [];
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s || !s.hits || !s.hitsMax) continue;
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) continue;
        const ratio = s.hits / s.hitsMax;
        if (ratio >= config.repairThreshold) continue;
        const d = threat.rangeTo(tower, s);
        if (d < 0 || d > TOWER_REPAIR_RANGE) continue;
        // 血量比例越低越急，距离越近越划算
        const urgent = ratio < config.repairUrgent ? 1000 : 0;
        const score = urgent + (1 - ratio) * 100 - d;
        if (score > bestScore) {
            bestScore = score;
            best = s;
        }
    }
    return best;
}

/**
 * 塔控制：敌人 → 治疗 → 维修，逐级降级。
 * 返回统计对象，方便外部观测（不参与游戏逻辑）。
 */
function runTowers(room, data) {
    const result = { towers: 0, attacked: 0, healed: 0, repaired: 0 };
    const towers = (data && data.towers) || [];
    if (!towers.length) return result;

    const hostiles = (data && data.hostiles) || [];
    const creeps = (data && data.creeplist) || [];

    for (let i = 0; i < towers.length; i++) {
        const tower = towers[i];
        if (!tower) continue;
        result.towers++;

        // 1) 打敌人：射程内最近的那个
        if (hostiles.length) {
            const target = threat.nearestInRange(tower, hostiles, TOWER_ATTACK_RANGE);
            if (target) {
                const r = threat.attempt(function () { return tower.attack(target); }, ERR_INVALID_TARGET);
                if (r === OK) {
                    result.attacked++;
                    continue;
                }
                // 攻击失败（能量不足等）就别在同一个塔上继续浪费，换下一个塔
                if (r === ERR_NOT_ENOUGH_ENERGY) continue;
            }
        }

        // 2) 治疗受伤的我方 creep
        const wounded = (function () {
            let best = null;
            let bestDist = Infinity;
            for (let j = 0; j < creeps.length; j++) {
                const c = creeps[j];
                if (!c || !c.hits || !c.hitsMax || c.hits >= c.hitsMax) continue;
                const d = threat.rangeTo(tower, c);
                if (d < 0 || d > TOWER_HEAL_RANGE) continue;
                // 血量比例最低的优先，同比例时近的优先
                const score = (c.hits / c.hitsMax) * 1000 + d;
                if (score < bestDist) {
                    bestDist = score;
                    best = c;
                }
            }
            return best;
        })();
        if (wounded) {
            const r = threat.attempt(function () { return tower.heal(wounded); }, ERR_INVALID_TARGET);
            if (r === OK) {
                result.healed++;
                continue;
            }
            if (r === ERR_NOT_ENOUGH_ENERGY) continue;
        }

        // 3) 维修：能量 > 70% 才修，避免和造兵抢能量
        if (towerEnergyRatio(tower) <= config.towerRepairEnergyRatio) continue;
        const damaged = pickRepairTarget(tower, data);
        if (!damaged) continue;
        const r = threat.attempt(function () { return tower.repair(damaged); }, ERR_INVALID_TARGET);
        if (r === OK) result.repaired++;
    }

    return result;
}

module.exports = {
    runTowers,
    // 暴露给测试/诊断用，不参与对外门面
    towerEnergyRatio,
    pickRepairTarget,
};

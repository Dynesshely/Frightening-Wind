/**
 * fw.body —— 身体组装与角色推断。
 *
 * 负责：
 *   - PART_COST：零件能量成本表；
 *   - bodyCost：按零件列表算造价；
 *   - planBody：在给定能量预算内组装尽可能大的身体（含 MOVE 配比平衡）；
 *   - inferRole / countRole：老存档里没有 role 记忆时按身体反推角色，以及按快照计数。
 *
 * 不该放进来：
 *   - 具体的角色行为（roles / role.*）；
 *   - 孵化决策与配额（economy / quota）—— 本模块只回答"这笔能量能造出什么身体"；
 *   - 身体配置本身（config.bodies）。
 *
 * 依赖：config.bodies。不依赖游戏对象接口，也 require 任何兄弟模块。
 */
const config = require('config');

/* ------------------------------ 身体规划 ------------------------------ */

const PART_COST = (function () {
    const map = {};
    map[WORK] = 100;
    map[CARRY] = 50;
    map[MOVE] = 50;
    map[ATTACK] = 80;
    map[RANGED_ATTACK] = 150;
    map[HEAL] = 250;
    map[TOUGH] = 10;
    map[CLAIM] = 600;
    return map;
})();

// config.bodies 里用的小写 token → 引擎零件常量
const PART = { WORK: WORK, CARRY: CARRY, MOVE: MOVE };

function bodyCost(body) {
    let c = 0;
    for (const p of body) c += PART_COST[p] || 0;
    return c;
}

/**
 * 在给定能量预算内，尽可能造出最大的身体
 */
function planBody(role, energy) {
    const def = config.bodies[role];
    if (!def) return null;

    const body = [];
    let cost = 0;
    let units = 0;

    while (units < def.maxUnits && body.length + def.unit.length <= 50) {
        const unitCost = bodyCost(def.unit);
        if (cost + unitCost > energy) break;
        for (const p of def.unit) body.push(p);
        cost += unitCost;
        units++;
    }

    if (units === 0) return null;

    // 剩余能量：保持"每个非 MOVE 零件都有 MOVE 背"的平衡（疲劳=0 才能满速移动）
    const filler = def.filler || ['work', 'carry', 'move'];
    let guard = 0;
    while (body.length < 50 && guard++ < 80) {
        const moves = body.filter(p => p === MOVE).length;
        const weight = body.length - moves;
        const needMoves = Math.ceil(weight / 2);

        // 先补齐移速
        if (moves < needMoves && cost + PART_COST[MOVE] <= energy) {
            body.push(MOVE);
            cost += PART_COST[MOVE];
            continue;
        }

        // 再加一个普通零件，且必须同时付得起"它需要的额外 MOVE"
        let added = false;
        for (const token of filler) {
            const part = PART[token.toUpperCase()];
            if (part === undefined || part === MOVE) continue;
            const c = PART_COST[part];
            const neededAfter = Math.ceil((weight + 1) / 2);
            const extraMoves = Math.max(0, neededAfter - moves);
            const totalCost = c + extraMoves * PART_COST[MOVE];
            if (cost + totalCost <= energy) {
                body.push(part);
                cost += c;
                for (let i = 0; i < extraMoves; i++) {
                    body.push(MOVE);
                    cost += PART_COST[MOVE];
                }
                added = true;
                break;
            }
        }
        if (!added) break;
    }

    // 排序：非 MOVE 在前，MOVE 在后（不影响移速，但符合常规习惯）
    const moves = body.filter(p => p === MOVE);
    const others = body.filter(p => p !== MOVE);
    return others.concat(moves);
}

/* ------------------------------ 角色 ------------------------------ */

function inferRole(creep) {
    const body = creep.body || [];
    const hasWork = body.some(p => p.type === WORK);
    const hasCarry = body.some(p => p.type === CARRY);
    if (hasWork && hasCarry) return 'harvester';
    if (hasCarry && !hasWork) return 'hauler';
    return 'harvester';
}

function countRole(data, role) {
    // 优先用"归属本房"的全局统计（跨房间单位也算）
    if (data.ownedByRole) return data.ownedByRole[role] || 0;
    return data.creepsByRole[role] || 0;
}

module.exports = { bodyCost, planBody, inferRole, countRole };

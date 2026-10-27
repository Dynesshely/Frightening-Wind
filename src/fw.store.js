/**
 * fw.store —— 能量流：库存读写、采集、取货、交付、倾倒。
 *
 * 负责：
 *   - 库存读写原语：storeOf / usedCap / usedEnergy / freeCap / freeEnergyCap；
 *   - 工作状态机：isWorking（空手→装满，接近满载→交付，滞回避免来回抖）；
 *   - 采集：pickSource（粘性选源）/ harvestSource；
 *   - 取货：nearestLooseEnergy / nearestEnergyStore / withdrawEnergy / transferFrom；
 *   - 交付：deliverEnergy / transferTo / dumpSurplus / spawnSurplus。
 *
 * 不该放进来：
 *   - 建造 / 维修 / 升级控制器（fw.build）；
 *   - 身体组装与角色推断（fw.body）；
 *   - 房间快照与敌对分级（fw.room）、地形判定（fw.geo）；
 *   - 位移策略：本模块只调用 fw.nav 的 moveTo，绝不直接写 creep.moveTo / creep.move。
 *
 * 依赖：fw.log（计数 + 说话）、fw.nav（唯一移动入口）。不依赖 utils（避免循环 require）。
 */
const config = require('config');
const log = require('fw.log');
const nav = require('fw.nav');

// 与 utils 门面同一套实现：说话走 fw.log，位移走 fw.nav。
const say = log.say;
const bump = log.ct;
const moveTo = nav.moveTo;

/* ------------------------------ 库存 ------------------------------ */

function storeOf(target) {
    if (!target) return null;
    if (target.store) return target.store;
    return null;
}

function usedCap(creep) {
    if (creep.store) return creep.store.getUsedCapacity() || 0;
    return _.sum(creep.carry) || 0;
}

function usedEnergy(creep) {
    if (creep.store) return creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    return creep.carry[RESOURCE_ENERGY] || 0;
}

function freeCap(creep) {
    if (creep.store) return creep.store.getFreeCapacity() || 0;
    return creep.carryCapacity - (_.sum(creep.carry) || 0);
}

function freeEnergyCap(target) {
    if (!target || !target.store) return 0;
    return target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
}

/** 任意结构/creep 身上的能量存量 */
function usedEnergyOf(target) {
    if (!target || !target.store) return 0;
    return target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
}

/**
 * 工作状态机：空手 → 先去装满；干活干到空手 → 再回去装。
 * 没有这个状态机，creep 会在"刚交掉一点货有空格"时立刻掉头回矿源，
 * 造成来回长跑却几乎不产出（RCL1 卡住的主因）。
 */
function isWorking(creep) {
    const used = usedCap(creep);
    const capacity = (creep.store ? creep.store.getCapacity() : creep.carryCapacity) || 0;

    // 滞回状态机：只有接近满载才转"交付"，只有完全空才转"采集"。
    // 旧实现"有 1 点能量就判满"会让 creep 在矿源和交付点之间来回抖动（线上实测 1 格反复横跳）。
    if (creep.memory.working === undefined) creep.memory.working = false;
    if (capacity > 0 && used >= capacity * 0.8) creep.memory.working = true;
    else if (used === 0) creep.memory.working = false;
    return creep.memory.working === true;
}

/* ------------------------------ 采集 ------------------------------ */

/**
 * 选一个"人最少"的矿源，并粘在 creep.memory.sourceId 上
 */
function pickSource(creep, data) {
    if (!data.sources.length) return null;

    // 统计每个矿源当前分配的活着的 creep 数量
    const load = {};
    for (const s of data.sources) load[s.id] = 0;
    for (const c of data.creeplist) {
        if (c.name === creep.name) continue;
        const sid = c.memory && c.memory.sourceId;
        if (sid === undefined || load[sid] === undefined) continue;
        // 静态矿工占的是"独占站位"，一个人就把那格的通行算满了；
        // 自由采集者挤过去只会互相顶位（线上实测：源 A 只有 1 个可站格，
        // 却被 1 个矿工 + 1 个采集者同时占，结果两边都采不到）。
        const w = (c.memory && c.memory.role === 'miner') ? 3 : 1;
        load[sid] += w;
    }

    let best = data.sources[0];
    for (const s of data.sources) {
        if (load[s.id] < load[best.id]) best = s;
    }

    const id = creep.memory.sourceId;
    const current = id ? Game.getObjectById(id) : null;

    // 粘性：已经有矿源且负载不明显失衡 -> 继续挖原来的
    if (current && load[current.id] !== undefined && load[current.id] <= load[best.id] + 1) {
        return current;
    }

    creep.memory.sourceId = best.id;
    return best;
}

function harvestSource(creep, data) {
    const source = pickSource(creep, data);
    if (!source) return false;
    say(creep, '⛏');
    const hr = creep.harvest(source);
    if (hr === OK) bump('harvest');
    else if (hr === ERR_NOT_IN_RANGE) moveTo(creep, source, { range: 1 });   // source 格不可站
    else bump('harvestErr_' + hr);
    return true;
}

/* ------------------------------ 取能量 ------------------------------ */

function hasEnergyIn(store) {
    if (!store) return false;
    return (store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0;
}

function nearestLooseEnergy(creep, data) {
    let best = null;
    let bestScore = 0;
    // 评分 = 量 / (距离 + 2)：近处的小堆也比远处的大堆值得弯腰。
    // 旧实现是"距离优先 + 量必须 >= 20"，结果墓碑/掉落物经常被当成不存在。
    const consider = (obj, amount) => {
        if (amount < 10) return;
        const d = creep.pos.getRangeTo(obj);
        if (d > 12) return;
        const score = amount / (d + 2);
        if (score > bestScore) { bestScore = score; best = obj; }
    };
    for (const d of data.dropped) {
        if (d.resourceType === RESOURCE_ENERGY) consider(d, d.amount);
    }
    for (const t of data.tombstones) consider(t, t.store.getUsedCapacity(RESOURCE_ENERGY) || 0);
    for (const r of data.ruins) consider(r, r.store.getUsedCapacity(RESOURCE_ENERGY) || 0);
    return best;
}

/**
 * 找最近的、有能量的容器/仓储。
 * excludeController=true 时跳过"控制器旁边的容器"（那是留给升级者的口粮，
 * 搬运工去取会和升级者形成来回搬运的循环）。
 */
function nearestEnergyStore(creep, data, minAmount, excludeController) {
    const controller = data.room.controller;
    let best = null;
    let bestDist = 999;
    const consider = obj => {
        if ((obj.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < minAmount) return;
        if (excludeController && controller && obj.pos.getRangeTo(controller) <= 3) return;
        const d = creep.pos.getRangeTo(obj);
        if (d < bestDist) { bestDist = d; best = obj; }
    };
    if (data.storage) consider(data.storage);
    for (const c of data.containers) consider(c);
    if (data.links) for (const l of data.links) consider(l);
    return best;
}

/**
 * 取能量：掉落/墓碑顺路就捡；否则在"容器/仓储"与"矿源"之间挑更近的那个。
 * 返回 true 表示本 tick 已经处理过（在采或在路上）。
 */
function withdrawEnergy(creep, data) {
    const loose = nearestLooseEnergy(creep, data);
    if (loose && creep.pos.getRangeTo(loose) <= 6) {
        return transferFrom(creep, loose);
    }

    const store = nearestEnergyStore(creep, data, 50);
    const source = pickSource(creep, data);

    if (store && !source) return transferFrom(creep, store);
    if (store && source) {
        const ds = creep.pos.getRangeTo(store);
        const dsrc = creep.pos.getRangeTo(source);
        if (ds + 2 < dsrc) return transferFrom(creep, store);
    }

    if (source) return harvestSource(creep, data);
    if (store) return transferFrom(creep, store);
    if (loose) return transferFrom(creep, loose);
    return false;
}

/**
 * 给"要贴上去交互"的建筑挑一个落脚格。
 *
 * 为什么需要：transfer/withdraw 要求 range ≤ 1，而建筑自身那格站不上去。
 * 用 moveTo(target, {range:1}) 时引擎会自己找一个邻格，但**多个 creep 会选同一格**，
 * 于是出现"两个单位在 (24,35) 和 (25,34) 之间来回摆、谁都进不了 range 1"的死循环
 * （本地推演实测：upgrader/hauler 每 3~4 tick 互换一次位置，8 分钟零产出）。
 * 这里按 creep 名字哈希在最近的几个邻格里选，把站位错开。
 */
function approachSpot(creep, target) {
    const room = target.room;
    if (!room || !target.pos) return null;
    let terrain;
    try { terrain = room.getTerrain(); } catch (e) { return null; }
    const spots = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const x = target.pos.x + dx;
            const y = target.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            spots.push({ x: x, y: y, d: creep.pos.getRangeTo(x, y) });
        }
    }
    if (!spots.length) return null;
    spots.sort((a, b) => a.d - b.d);
    let h = 0;
    for (let i = 0; i < creep.name.length; i++) h = (h * 31 + creep.name.charCodeAt(i)) & 0xffff;
    const pick = spots[Math.min(h % 3, spots.length - 1)];
    return new RoomPosition(pick.x, pick.y, room.name);
}

function transferFrom(creep, target) {
    say(creep, '📦');
    // 地上的掉落物只能用 pickup()，withdraw 会返回 ERR_INVALID_TARGET
    const isDropped = target && !target.store;
    const r = isDropped ? creep.pickup(target) : creep.withdraw(target, RESOURCE_ENERGY);
    if (r === ERR_NOT_IN_RANGE) {
        // ★ 走到"建筑的可站邻格"，并且按名字错开，避免多个单位抢同一格互相顶。
        const spot = approachSpot(creep, target);
        if (spot) moveTo(creep, spot);
        else moveTo(creep, target, { range: 1 });
        return true;
    }
    if (r === OK) bump('withdraw');
    else bump('withdrawErr_' + r);
    return r === OK;
}

/* ------------------------------ 交付能量 ------------------------------ */

/**
 * 把能量交给最需要的地方：spawn/extension → tower → storage/container
 * 返回 true 表示已经处理
 */
function deliverEnergy(creep, data) {
    // spawn/扩展的存量应该"够孵下一个兵就停"，多出来的要流向升级端。
    // 旧实现只要有空格就往 spawn/扩展送，而它们容量 1300、实测常年只存 100 上下，
    // 于是永远"有空格"，把升级者彻底饿死（docs/OPTIMIZATION.md F4）。
    // 囤货款：孵化器正在为某个大身体攒钱时，spawn/扩展要有足够的余量；
    // 否则多余的立刻流走，大兵永远攒不够（实测 spawn+扩展常年停在 250）。
    // 没有在攒的时候用较低基线，让能量尽快流向控制器容器（升级端）。
    let reserve = (config.spawn && config.spawn.reserve) || 350;
    const pending = Memory.fw && Memory.fw.spawnReserve && Memory.fw.spawnReserve[data.room.name];
    if (pending && pending.need > reserve) reserve = pending.need;
    let stored = 0;
    for (const s of data.spawns) stored += usedEnergyOf(s);
    for (const e of data.extensions) stored += usedEnergyOf(e);

    if (stored < reserve) {
        const targets = [];
        for (const s of data.spawns) {
            if (freeEnergyCap(s) > 0) targets.push(s);
        }
        for (const e of data.extensions) {
            if (freeEnergyCap(e) > 0) targets.push(e);
        }
        if (targets.length) {
            targets.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
            return transferTo(creep, targets[0]);
        }
    }

    // 攒够了：优先喂"控制器旁容器"（升级者的口粮），这是把能量变成 RCL 的唯一通路。
    // 顺序必须在塔之前 —— 实测塔有 340 能量（够打 34 次）却仍被优先补满，
    // 导致控制器容器长期 0 库存、升级者无货可取。
    const controller = data.room.controller;
    if (controller) {
        for (const c of data.containers) {
            if (c.pos.getRangeTo(controller) > 3) continue;
            if (usedEnergyOf(c) >= 1000) continue;
            if (freeEnergyCap(c) <= 0) continue;
            return transferTo(creep, c);
        }
    }

    // 塔：只在存量不足一半时补给（满容量 1000，500 足够应付日常）
    for (const t of data.towers) {
        if (usedEnergyOf(t) >= 500) continue;
        if (freeEnergyCap(t) > 0) return transferTo(creep, t);
    }

    // 其次沉淀到 storage
    if (data.storage && freeEnergyCap(data.storage) > 0) {
        return transferTo(creep, data.storage);
    }

    // 兜底：spawn/扩展还有空格就送（说明上面都被占满了）
    for (const s of data.spawns) {
        if (freeEnergyCap(s) > 0) return transferTo(creep, s);
    }
    for (const e of data.extensions) {
        if (freeEnergyCap(e) > 0) return transferTo(creep, e);
    }

    return false;
}

function transferTo(creep, target) {
    say(creep, '🚚');
    const r = creep.transfer(target, RESOURCE_ENERGY);
    if (r === ERR_NOT_IN_RANGE) {
        const spot = approachSpot(creep, target);
        if (spot) moveTo(creep, spot);
        else moveTo(creep, target, { range: 1 });
        return true;
    }
    if (r === OK) bump('transfer');
    else bump('transferErr_' + r);
    return r === OK;
}

/* ------------------------------ 生命周期 ------------------------------ */

/** creep 走一格要几个 tick（疲劳模型：ceil(非MOVE / (2·MOVE))） */
function tileTime(creep) {
    let moves = 0;
    let others = 0;
    const loaded = usedEnergy(creep) > 0;
    for (const p of (creep.body || [])) {
        if (p.type === MOVE) moves++;
        else if (p.type === CARRY && !loaded) continue;   // 空 CARRY 不产生疲劳
        else others++;
    }
    if (moves <= 0) return 99;
    return Math.max(1, Math.ceil(others / (2 * moves)));
}

/** 最近的可交付点（容器 / 仓储 / spawn） */
function retireSpot(creep, data) {
    let best = null;
    let bestD = 999;
    const take = obj => {
        if (!obj) return;
        const d = creep.pos.getRangeTo(obj);
        if (d < bestD) { bestD = d; best = obj; }
    };
    for (const c of data.containers) take(c);
    take(data.storage);
    for (const s of data.spawns) take(s);
    return best;
}

/**
 * 临终交付：TTL 不足以走完回程时，先把身上的能量处理掉。
 *
 * 为什么必须做：creep 死亡时只有 `CREEP_CORPSE_RATE = 0.2` 的资源变成墓碑，
 * 也就是带着 50 能量死掉会白白蒸发 40。主动倾倒能保住 100%。
 *
 * 返回 true 表示"本 tick 已经在处理后事"，调用方应跳过正常角色逻辑。
 */
function retire(creep, data) {
    const ttl = creep.ticksToLive;
    // ★ 必须先判断"是不是真的快死了"，再谈交付。
    // 之前的版本把 deliverEnergy 放在 TTL 检查之前，结果每个揣着 2 点能量的采集者
    // 每 tick 都被这里接管去"交付"，采集链当场停摆（线上事故：progress 卡死 1200 tick）。
    if (ttl === undefined || ttl > 300) return false;
    const carried = usedEnergy(creep);
    if (carried <= 0) return false;

    // 已经在交付点上：直接交掉
    if (deliverEnergy(creep, data)) return true;

    // 身边 1 格内有容器就倒进去（矿工站在矿源容器旁，这样最省事）
    for (const c of data.containers) {
        if (creep.pos.getRangeTo(c) > 1) continue;
        if (freeEnergyCap(c) <= 0) continue;
        return transferTo(creep, c);
    }

    const spot = retireSpot(creep, data);
    const dist = spot ? creep.pos.getRangeTo(spot) : 99;
    const perTile = tileTime(creep);
    const need = dist * perTile + 3;

    // 时间还充裕：交给正常角色逻辑（它自己会把货送到）
    if (ttl > need + 8) return false;

    if (spot && ttl >= need) {
        say(creep, '🏁');
        moveTo(creep, spot, { range: 1 });
        return true;
    }

    // 来不及了：就地倒掉，形成掉落物让路过的单位捡（好过蒸发 80%）
    const r = creep.drop(RESOURCE_ENERGY);
    if (r === OK) {
        bump('retireDrop');
        say(creep, '💀');
        return true;
    }
    return false;
}

/**
 * 富余能量倾倒点：控制器 3 格内的容器。
 * 这样升级者不用跑到矿源去取能量，直接在控制器旁边就能续杯。
 */
function dumpSurplus(creep, data) {
    let best = null;
    let bestDist = 999;

    // storage 优先（容量大、不会像容器那样被工人顺手抽走）
    if (data.storage && freeEnergyCap(data.storage) > 0) {
        best = data.storage;
        bestDist = creep.pos.getRangeTo(data.storage);
    }

    // 其次：控制器旁的容器（就地喂升级者）
    const controller = data.room.controller;
    if (controller) {
        for (const c of data.containers) {
            if (c.pos.getRangeTo(controller) > 3) continue;
            if (freeEnergyCap(c) <= 0) continue;
            const d = creep.pos.getRangeTo(c);
            if (d < bestDist) { bestDist = d; best = c; }
        }
    }

    if (!best) return false;
    return transferTo(creep, best);
}

/**
 * spawn/扩展已满仓时，把"暂时用不到的"能量搬出去升级。
 * 只在 spawn 完全满时启用，避免影响造兵。
 */
function spawnSurplus(creep, data) {
    let fullSpawn = null;
    for (const s of data.spawns) {
        if ((s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) === 0) { fullSpawn = s; break; }
    }
    if (!fullSpawn) return false;

    // 先从扩展里拿，再动 spawn 本身
    let best = null;
    let bestDist = 999;
    for (const e of data.extensions) {
        if ((e.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < 50) continue;
        const d = creep.pos.getRangeTo(e);
        if (d < bestDist) { bestDist = d; best = e; }
    }
    if (best) return transferFrom(creep, best);
    if ((fullSpawn.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= 200) {
        return transferFrom(creep, fullSpawn);
    }
    return false;
}

module.exports = {
    storeOf,
    usedCap,
    retire,
    tileTime,
    usedEnergy,
    freeCap,
    freeEnergyCap,
    isWorking,
    pickSource,
    harvestSource,
    nearestLooseEnergy,
    nearestEnergyStore,
    withdrawEnergy,
    transferFrom,
    deliverEnergy,
    transferTo,
    dumpSurplus,
    spawnSurplus,
};

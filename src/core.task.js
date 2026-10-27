/**
 * core.task —— L3 任务层：可比较、可度量的任务队列（ARCHITECTURE_V2 §6）
 *
 * 本模块负责三件事：
 *   1. 队列：Memory.fw.tasks2[roomName] = { q, stat, fb, scanAt, seq }
 *      q 里每条任务 = { id, type, targetId, priority, created, deadline,
 *                        estGain, estCost, roles, claim, claimAt, touch }
 *      每房硬上限 maxPerRoom（默认 50），过期 / 目标消失 / 卡住自动清理；
 *   2. 闭环：push（生产）→ pick（按 priority × ROI 认领，意图粘性）→
 *      exec（复用 utils.* 执行）→ finish（记实际耗时、成功率、兑现收益）；
 *   3. 结算移交：stats() / feedback() / drainFeedback() 给 L0（core.ledger）把 η 纳入滑动窗口。
 *
 * 任务类型（第一批）：harvest / haul / upgrade / build / repair / renew / recycle。
 * ROI = estGain / estCost；排序分数 = priority × ROI（同分时挑更近的）。
 * 生产端分工：sync() 只派生"机械可观测"的三类（build / repair / haul）；
 * harvest / upgrade / renew / recycle 属于配额与政策决策，必须由 L2（core.policy / economy）
 * 显式 push，本模块不擅自替上层做决定。
 *
 * 不该放进来：
 *   - 预算分配与角色人数（L2：core.budget / core.policy）；
 *   - 能量流、建造、维修、身体的原语（fw.store / fw.build / fw.body）—— 本模块只调用 utils.* 门面；
 *   - 任何导航补丁：位移一律走 utils.moveTo / utils.moveToRoom（→ fw.nav 的唯一入口）；
 *   - 角色行为本身：任务只描述"做什么、去哪做"，动作全部复用既有 utils.* 实现。
 *
 * 依赖：config、utils（门面）。不 require 任何上层模块（roles / economy），避免循环 require。
 * 开关：config.core.v2（默认关闭）。关闭时 roles.run 根本不会调用本模块，行为与旧路径完全一致。
 */
const config = require('config');
const utils = require('utils');

/* ============================== 可调参数 ============================== */

// 最终应搬进 src/config.js 的 core.task；这里先"config.core.task 覆盖 + 默认值兜底"，
// 避免把魔法数字散落到逻辑里（config 里没有 core 段时也不会报错）。
const DEFAULTS = {
    // 下面两项在 config.js 里已有正式参数（config.core.taskLimit / taskTtl）：
    // 这里的默认值只是"config 缺段时也跑得起来"的兜底，opt() 会优先读 config。
    maxPerRoom: 50,        // 每房队列硬上限（ARCHITECTURE_V2 §6）← config.core.taskLimit
    queueIdleTicks: 300,   // 没人认领的任务最长存活 tick ← config.core.taskTtl
    maxFeedback: 30,       // 结算样本环形缓冲上限（给 L0 算 η）
    leaseTicks: 60,        // 认领租约：多久没推进就释放（也是任务被认领后的默认寿命）
    staleTicks: 30,        // 认领后多少 tick 无推进视为"卡住"→ 释放给别的单位
    rescanTicks: 25,       // 队列太旧时，隔多少 tick 重新派生一次
    maxPushPerScan: 6,     // 一次派生最多新增几条（防止一 tick 塞满队列）
    sync: true,            // 内置生产端总开关（false 时队列只靠外部 push）
    syncBuild: true,       // 派生：工地
    syncRepair: true,      // 派生：维修
    syncHaul: true,        // 派生：搬运
    buildTasks: 3,         // 一次派生最多几条建造任务
    repairTasks: 2,        // 一次派生最多几条维修任务
    haulTasks: 3,          // 一次派生最多几条搬运任务
    minHaulAmount: 50,     // 仓库里少于这个量不值得派搬运
};

/**
 * 读取参数，优先级：
 *   1. config.core.task.<key>（需临时覆盖时可用，config 里没有这一段也不报错）
 *   2. config.core.taskLimit / config.core.taskTtl（Lead 已在 config.js 里定好的两项）
 *   3. 本模块 DEFAULTS
 */
function opt(key) {
    const core = config.core || {};
    const t = core.task;
    if (t && t[key] !== undefined) return t[key];
    if (key === 'maxPerRoom') return num(core.taskLimit, DEFAULTS.maxPerRoom);
    if (key === 'queueIdleTicks') return num(core.taskTtl, DEFAULTS.queueIdleTicks);
    return DEFAULTS[key];
}

/** 总开关：config.core.v2（缺省视为关闭） */
function enabled() {
    return !!(config.core && config.core.v2);
}

// 任务类型的基础优先级；push 时显式给的 priority 优先。
// 这些只是"机械任务"的排序起点，真正该花多少能量是 L2 的事。
const TYPE_PRIORITY = {
    recycle: 95,   // 回收腾名额，最急
    renew: 70,     // 续命，比普通生产任务优先
    haul: 60,      // 搬运：下游缺口是硬约束
    build: 55,
    repair: 50,
    harvest: 45,
    upgrade: 40,
};

// 工地类型的基础优先级（建造任务的排序起点）。
const SITE_PRIORITY = {
    spawn: 90, extension: 80, tower: 80, link: 75, container: 70,
    storage: 60, road: 30, rampart: 20, constructedWall: 20,
};

// 任务需要哪些部件；未登记的类型一律不认领（防止拼错类型名把队列占满）。
// 注意 WORK 类任务同时要求 CARRY：没有 CARRY 的士兵/巡逻兵不该被抽去搬砖（它们打不了工，
// 也没法把能量运到工地）。纯 MOVE 的侦察兵同理天然被排除在外。
const NEED_PART = {
    harvest: ['work', 'carry'],
    build: ['work', 'carry'],
    repair: ['work', 'carry'],
    upgrade: ['work', 'carry'],
    haul: ['carry'],
    renew: null,
    recycle: null,
};

// 这些类型必须带 targetId，且目标消失后整条任务作废。
const NEEDS_TARGET = { harvest: 1, haul: 1, build: 1, repair: 1 };

/* ============================== Memory 存取 ============================== */

function mem() {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.tasks2) Memory.fw.tasks2 = {};
    return Memory.fw.tasks2;
}

/** 取（必要时创建）一个房间的任务箱 */
function roomBox(roomName) {
    const all = mem();
    let box = all[roomName];
    if (!box) box = all[roomName] = { q: [], stat: null, fb: [], scanAt: 0, seq: 0 };
    if (!box.q) box.q = [];
    if (!box.fb) box.fb = [];
    return box;
}

/** 取一个房间的队列长度（诊断用；不触发创建） */
function size(roomName) {
    const all = mem();
    const box = all[roomName];
    return box && box.q ? box.q.length : 0;
}

/* ============================== 数值与度量 ============================== */

function num(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

/** ROI = 预计收益 / 预计成本（成本为 0 时按极小值兜底，避免除零） */
function roiOf(t) {
    const gain = num(t.estGain, 1);
    const cost = Math.max(num(t.estCost, 1), 0.001);
    return gain / cost;
}

/** 任务的比较分数：priority × ROI（ARCHITECTURE_V2 §6 的排序口径） */
function score(t) {
    return Math.max(num(t.priority, 1), 0.001) * roiOf(t);
}

function basePriority(type) {
    const p = TYPE_PRIORITY[type];
    return typeof p === 'number' ? p : 50;
}

/* ============================== 生产：push / sync ============================== */

/**
 * 往房间队列里推一条任务。
 *
 * @param {string} roomName
 * @param {{type:string, targetId?:string, priority?:number,
 *          estGain?:number, estCost?:number, deadline?:number, roles?:string[]}} t
 *        deadline 传绝对 tick；不传则按"没人认领最长存活"（config.core.taskTtl）算。
 *        roles 可选：限定只有这些角色能认领（例如 build 只给 builder）。
 *        不传表示"任何具备相应部件的单位都能接"—— 上层的政策任务建议不传，
 *        让 L2 用配额决定谁去干，而不是在 L3 里再写一份角色表。
 * @returns {string|null} 任务 id；队列满且不比现存的更值得时返回 null。
 *
 * 幂等：同 type + 同 targetId 已在队列里时只刷新估计值/优先级，不重复入队 ——
 * 否则每 tick 派生一次就会把队列塞满重复项。
 */
function push(roomName, t) {
    if (!roomName || !t || !t.type) return null;
    const box = roomBox(roomName);
    const now = Game.time;
    const type = String(t.type);

    const task = {
        id: now.toString(36) + ':' + (box.seq = (box.seq || 0) + 1),
        type: type,
        targetId: t.targetId || null,
        priority: num(t.priority, basePriority(type)),
        created: now,
        deadline: num(t.deadline, now + num(opt('queueIdleTicks'), 300)),
        estGain: num(t.estGain, 1),
        estCost: num(t.estCost, 1),
        roles: Array.isArray(t.roles) && t.roles.length ? t.roles.slice(0, 4) : null,
        claim: null,
        claimAt: 0,
        touch: now,
    };
    // 注意：deadline 是"绝对 tick"，显式传进来的就照办（含已过期的，交给 prune 立刻清掉），
    // 不要在这里做"至少存活 N tick"的宽容处理 —— 那会让上层想立即作废的任务反而活得更久。

    for (let i = 0; i < box.q.length; i++) {
        const q = box.q[i];
        if (q.type === task.type && q.targetId === task.targetId) {
            if (typeof t.priority === 'number') q.priority = t.priority;
            if (typeof t.estGain === 'number') q.estGain = t.estGain;
            if (typeof t.estCost === 'number') q.estCost = t.estCost;
            if (task.deadline > (q.deadline || 0)) q.deadline = task.deadline;
            return q.id;
        }
    }

    const max = num(opt('maxPerRoom'), 50);
    if (box.q.length >= max) {
        // 满队列：只有比"最差的那条"更值得才允许顶替（硬上限 50 条不破）
        let worst = 0;
        let worstScore = score(box.q[0]);
        for (let i = 1; i < box.q.length; i++) {
            const s = score(box.q[i]);
            if (s < worstScore) { worstScore = s; worst = i; }
        }
        if (score(task) <= worstScore) return null;
        box.q[worst] = task;
        return task.id;
    }
    box.q.push(task);
    return task.id;
}

/** 下游（spawn / 扩展 / 塔）的能量缺口总量 */
function downstreamNeed(data) {
    let need = 0;
    const add = list => {
        for (const s of (list || [])) need += Math.max(0, num(utils.freeEnergyCap(s), 0));
    };
    add(data.spawns);
    add(data.extensions);
    add(data.towers);
    return need;
}

function sitePriorityOf(site) {
    const p = SITE_PRIORITY[site.structureType];
    return typeof p === 'number' ? p : 50;
}

/**
 * 派生一批任务（生产端）。只做"机械可观测、无需政策判断"的三类：
 *   build  有工地且还有进度 → 一条（按工地类型给基础优先级）
 *   repair 结构血量低于 config.repairThreshold → 一条（急修优先）
 *   haul   仓库有货且下游有缺口 → 一条
 * harvest / upgrade / renew / recycle 不在这里生成（那是 L2 的决定）。
 * 派生出来的三类任务都带 roles 白名单（build/repair → builder/pioneer，haul → hauler/remoteHauler），
 * 灰度期先保证"不改变现有分工"；等 L2 接管生产端后，push 时不传 roles 即可放开。
 *
 * 返回新增条数；由 pick() 在队列变空/变旧时按 rescanTicks 节流调用。
 */
function sync(roomName, data) {
    if (!data || !data.room) return 0;
    if (opt('sync') === false) return 0;
    // 只在我方房间派生任务：远程房间的工地/容器可能是别人的，别把自家队伍派去打工
    if (!data.room.controller || !data.room.controller.my) return 0;

    const box = roomBox(roomName);
    const now = Game.time;
    const max = num(opt('maxPushPerScan'), 6);
    const idle = num(opt('queueIdleTicks'), 300);
    box.scanAt = now;
    let pushed = 0;

    const add = spec => {
        if (pushed >= max) return false;
        const before = box.q.length;
        push(roomName, spec);
        if (box.q.length > before) { pushed++; return true; }
        return false;
    };

    // ---- 建造：工地还有剩余进度 ----
    if (opt('syncBuild') !== false) {
        let n = 0;
        const sites = data.sites || [];
        for (const site of sites) {
            if (pushed >= max || n >= num(opt('buildTasks'), 3)) break;
            const remain = Math.max(0, num(site.progressTotal, 0) - num(site.progress, 0));
            if (remain <= 0) continue;
            if (add({
                type: 'build', targetId: site.id,
                roles: ['builder', 'pioneer'],
                priority: sitePriorityOf(site),
                estGain: remain,
                estCost: Math.max(1, remain / (typeof BUILD_POWER === 'number' ? BUILD_POWER : 5)),
                deadline: now + idle,
            })) n++;
        }
    }

    // ---- 维修：低于维修阈值的非 wall/rampart 结构 ----
    if (opt('syncRepair') !== false) {
        let n = 0;
        const list = data.damageable || data.structures || [];
        for (const st of list) {
            if (pushed >= max || n >= num(opt('repairTasks'), 2)) break;
            if (!st.hits || !st.hitsMax) continue;
            if (st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART) continue;
            const ratio = st.hits / st.hitsMax;
            if (ratio >= config.repairThreshold) continue;
            const remain = st.hitsMax - st.hits;
            if (add({
                type: 'repair', targetId: st.id,
                roles: ['builder', 'pioneer'],
                priority: ratio < config.repairUrgent ? 85 : 55,
                estGain: remain,
                estCost: Math.max(1, remain / (typeof REPAIR_POWER === 'number' ? REPAIR_POWER : 100)),
                deadline: now + idle,
            })) n++;
        }
    }

    // ---- 搬运：仓库有货 + 下游有缺口 ----
    if (opt('syncHaul') !== false) {
        let n = 0;
        const need = downstreamNeed(data);
        if (need > 0) {
            const stores = [];
            if (data.storage) stores.push(data.storage);
            for (const c of (data.containers || [])) stores.push(c);
            for (const s of stores) {
                if (pushed >= max || n >= num(opt('haulTasks'), 3)) break;
                const amt = s.store ? num(s.store.getUsedCapacity(RESOURCE_ENERGY), 0) : 0;
                if (amt < num(opt('minHaulAmount'), 50)) continue;
                if (add({
                    type: 'haul', targetId: s.id,
                    roles: ['hauler', 'remoteHauler'],
                    priority: basePriority('haul'),
                    estGain: amt,
                    estCost: amt,
                    deadline: now + idle,
                })) n++;
            }
        }
    }

    return pushed;
}

/* ============================== 清理与认领 ============================== */

/** 释放一条任务的认领（不算失败，只是把机会让给别人） */
function releaseClaim(t) {
    t.claim = null;
    t.claimAt = 0;
}

/**
 * 清理队列：过期 / 目标消失 / 认领者已死 / 认领后长期无推进。
 * "长期无推进"只释放认领、不删任务 —— 别的单位接手往往就能推进。
 */
function prune(box) {
    const now = Game.time;
    const stale = num(opt('staleTicks'), 30);
    const keep = [];
    for (let i = 0; i < box.q.length; i++) {
        const t = box.q[i];
        if (!t || !t.type) continue;
        if (t.deadline && now > t.deadline) continue;
        if (t.claim && !Game.creeps[t.claim]) releaseClaim(t);
        else if (t.claim && now - num(t.touch, num(t.claimAt, t.created)) > stale) releaseClaim(t);
        if (t.targetId && NEEDS_TARGET[t.type] && !Game.getObjectById(t.targetId)) continue;
        keep.push(t);
    }
    if (keep.length !== box.q.length) box.q = keep;
}

/** 任务当前是否可以被这只 creep 认领 */
function claimable(t, creep) {
    if (!t.claim) return true;
    if (t.claim === creep.name) return true;
    const holder = Game.creeps[t.claim];
    if (!holder) return true;                       // 认领者已死
    return Game.time > num(t.deadline, 0);           // 租约过期
}

/* ============================== 认领：pick ============================== */

function hasPart(creep, type) {
    const body = creep.body || [];
    const want = type === 'work' ? WORK : CARRY;
    for (let i = 0; i < body.length; i++) {
        if (body[i] && body[i].type === want) return true;
    }
    return false;
}

/**
 * 这只 creep 能不能接这条任务：
 *   1. 类型已登记；
 *   2. 任务若限定了 roles，则 creep 的当前角色必须在名单里
 *      （避免 v2 一打开就把矿工抽去搬砖、把士兵抽去建造）；
 *   3. 部件与状态满足（WORK 类任务还要 CARRY，采集任务还得有空位）。
 */
function canDo(creep, t) {
    const type = t.type;
    if (NEED_PART[type] === undefined) return false;   // 未登记的类型不认领
    if (t.roles && t.roles.length) {
        const role = creep.memory && creep.memory.role;
        if (!role || t.roles.indexOf(role) === -1) return false;
    }
    const need = NEED_PART[type];
    if (!need) return true;
    for (let i = 0; i < need.length; i++) {
        if (!hasPart(creep, need[i])) return false;
    }
    if (type === 'harvest' && num(utils.freeCap(creep), 0) <= 0) return false;
    return true;
}

function findBy(box, id) {
    for (let i = 0; i < box.q.length; i++) {
        if (box.q[i].id === id) return box.q[i];
    }
    return null;
}

/**
 * 给 creep 挑一个任务：优先延续它已在做的（意图粘性，避免每 tick 换目标来回抖），
 * 否则在队列里按 priority × ROI 取最高、且自己做得来、且没被别人占住的那条。
 *
 * 粘性 + 单任务制是刻意的：一个 creep 同时只有一个任务，直到完成/失效/租约到期，
 * 这样任务路径不会和角色路径每 tick 交替（那正是横跳/抖动的来源）。
 *
 * @returns {object|null} 任务引用（同时已写入 creep.memory.coreTask 与任务 claim）
 */
function pick(creep, data) {
    if (!enabled() || !creep || !creep.memory) return null;
    const now = Game.time;

    // 1) 先看手上有没有还没做完的任务（粘性优先，跨房间赶路途中也继续做）
    //    这里按任务记录的归属房间取队列，且只读不建表 —— 别为了看一眼就在 Memory 里
    //    给路过的每个房间都建一个空箱子。
    const cur = creep.memory.coreTask;
    if (cur && cur.id) {
        const box0 = mem()[cur.room || creep.room.name];
        const t = box0 && box0.q ? findBy(box0, cur.id) : null;
        if (t && t.claim === creep.name && now <= num(t.deadline, 0)) return t;
        // 任务没了 / 被清掉 / 租约到期：释放认领，重新挑
        if (t && t.claim === creep.name) releaseClaim(t);
        creep.memory.coreTask = undefined;
    }

    // 2) 只在本方房间领取新任务：远程/中立房间没有任务可言
    //    （sync 有同样的守卫，这里再挡一次是为了不给出差单位乱派活）
    if (!creep.room.controller || !creep.room.controller.my) return null;

    const roomName = creep.room.name;
    const box = roomBox(roomName);

    // 3) 队列清理 + 需要时派生。
    // 清理每只 creep 都做（队列最多 50 条，O(50) 的代价远小于一次寻路），
    // 这样"过期/目标消失"的任务当 tick 就能被跳过，不会让单位先跑一趟再说。
    // 派生（sync）必须节流：它要扫全房结构，按 rescanTicks 每房每 N tick 一次。
    prune(box);
    if (now - num(box.scanAt, 0) >= num(opt('rescanTicks'), 25)) {
        sync(roomName, data);
        prune(box);
    }

    // 4) 按分数挑（同分时选更近的，避免每次都往最远的跑）
    let best = null;
    let bestScore = -Infinity;
    let bestRange = Infinity;
    for (let i = 0; i < box.q.length; i++) {
        const t = box.q[i];
        if (!canDo(creep, t)) continue;
        if (!claimable(t, creep)) continue;
        const s = score(t);
        let range = 0;
        if (t.targetId) {
            const obj = Game.getObjectById(t.targetId);
            if (obj && obj.pos) range = creep.pos.getRangeTo(obj.pos);
        }
        if (s > bestScore || (s === bestScore && range < bestRange)) {
            bestScore = s;
            bestRange = range;
            best = t;
        }
    }
    if (!best) return null;

    best.claim = creep.name;
    best.claimAt = now;
    best.touch = now;
    best.deadline = now + num(opt('leaseTicks'), 60);
    creep.memory.coreTask = { id: best.id, at: now, room: roomName };
    return best;
}

/* ============================== 执行：exec ============================== */

function targetOf(t) {
    return t && t.targetId ? Game.getObjectById(t.targetId) : null;
}

function nearestSpawn(creep, data) {
    const spawns = (data && data.spawns) || [];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < spawns.length; i++) {
        const d = creep.pos.getRangeTo(spawns[i]);
        if (d < bestD) { bestD = d; best = spawns[i]; }
    }
    return best;
}

/** harvest：把粘性选源钉在任务目标上，然后复用 fw.store 的采集原语 */
function execHarvest(creep, t, data) {
    const source = targetOf(t);
    if (!source) return false;
    if (num(utils.freeCap(creep), 0) <= 0) {
        // 装满：先交付，交付完继续回来挖（采集是持续性任务，不在此结算）
        if (utils.deliverEnergy(creep, data)) return true;
        return utils.dumpSurplus(creep, data);
    }
    creep.memory.sourceId = source.id;
    return utils.harvestSource(creep, data);
}

/** haul：身上有货就送，没货就去任务指定的仓库取 */
function execHaul(creep, t, data) {
    if (num(utils.usedEnergy(creep), 0) > 0) {
        if (utils.deliverEnergy(creep, data)) return true;
        return utils.dumpSurplus(creep, data);
    }
    const store = targetOf(t);
    if (!store) { finish(creep, false); return false; }
    if (num(store.store.getUsedCapacity(RESOURCE_ENERGY), 0) <= 0) {
        // 已经搬空：这条任务的目的达成了，结算掉；容器再攒起来时 sync 会重新派生
        finish(creep, true);
        return false;
    }
    return utils.transferFrom(creep, store);
}

/** upgrade：有能量就升级，没能量就去补给 */
function execUpgrade(creep, t, data) {
    const ctrl = data.room && data.room.controller;
    if (!ctrl || !ctrl.my) { finish(creep, false); return false; }
    if (num(utils.usedEnergy(creep), 0) > 0) return utils.upgradeController(creep, data.room);
    return utils.withdrawEnergy(creep, data);
}

/** build：按任务指定的工地建造；建完/工地消失即结算 */
function execBuild(creep, t, data) {
    const site = targetOf(t);
    if (!site) { finish(creep, true); return false; }
    if (num(site.progress, 0) >= num(site.progressTotal, 1)) { finish(creep, true); return false; }
    if (num(utils.usedEnergy(creep), 0) <= 0) return utils.withdrawEnergy(creep, data);

    utils.say(creep, '🔨');
    const r = creep.build(site);
    if (r === ERR_NOT_IN_RANGE) { utils.moveTo(creep, site); return true; }
    if (r === ERR_NOT_ENOUGH_RESOURCES) return utils.withdrawEnergy(creep, data);
    return r === OK;
}

/** repair：按任务指定的结构维修；修够了/结构没了即结算 */
function execRepair(creep, t, data) {
    const st = targetOf(t);
    if (!st) { finish(creep, false); return false; }
    if (!st.hitsMax || st.hits >= st.hitsMax * config.repairThreshold) { finish(creep, true); return false; }
    if (num(utils.usedEnergy(creep), 0) <= 0) return utils.withdrawEnergy(creep, data);

    utils.say(creep, '🔧');
    const r = creep.repair(st);
    if (r === ERR_NOT_IN_RANGE) { utils.moveTo(creep, st); return true; }
    if (r === ERR_NOT_ENOUGH_RESOURCES) return utils.withdrawEnergy(creep, data);
    return r === OK;
}

/** renew：回 spawn 续命（一次性任务，续到满或成功即结算） */
function execRenew(creep, t, data) {
    const spawn = nearestSpawn(creep, data);
    if (!spawn) { finish(creep, false); return false; }
    const r = spawn.renewCreep(creep);
    if (r === ERR_NOT_IN_RANGE) { utils.moveTo(creep, spawn, { range: 1 }); return true; }
    if (r === OK) { finish(creep, true); return true; }
    if (r === ERR_FULL) { finish(creep, true); return false; }
    finish(creep, false);
    return false;
}

/** recycle：回 spawn 回收（一次性任务） */
function execRecycle(creep, t, data) {
    const spawn = nearestSpawn(creep, data);
    if (!spawn) { finish(creep, false); return false; }
    if (creep.pos.getRangeTo(spawn) > 1) { utils.moveTo(creep, spawn); return true; }
    const r = spawn.recycleCreep(creep);
    if (r === OK) { finish(creep, true); return true; }
    finish(creep, false);
    return false;
}

/**
 * 执行一条任务。
 *
 * 返回值约定：
 *   true  —— 本 tick 已经在做这件事（在赶路也算），调用方不要再跑角色行为；
 *   false —— 做不了（没能量且没补给、目标消失、动作被引擎拒绝…），
 *            调用方照常跑角色行为，由角色逻辑去补能量/换目标。
 * 这样任务路径永远有"退回角色路径"的出口，不会把单位卡死。
 */
function exec(creep, t, data) {
    if (!t || !enabled()) return false;

    // 跨房间目标：先走到目标房间再执行具体动作（单房间的 moveTo 到不了隔壁房间）
    if (t.targetId) {
        const obj = Game.getObjectById(t.targetId);
        if (obj && obj.pos && obj.pos.roomName && obj.pos.roomName !== creep.room.name) {
            utils.moveToRoom(creep, obj.pos.roomName);
            t.touch = Game.time;
            t.deadline = Game.time + num(opt('leaseTicks'), 60);
            return true;
        }
    }

    let handled = false;
    switch (t.type) {
        case 'harvest': handled = execHarvest(creep, t, data); break;
        case 'haul': handled = execHaul(creep, t, data); break;
        case 'upgrade': handled = execUpgrade(creep, t, data); break;
        case 'build': handled = execBuild(creep, t, data); break;
        case 'repair': handled = execRepair(creep, t, data); break;
        case 'renew': handled = execRenew(creep, t, data); break;
        case 'recycle': handled = execRecycle(creep, t, data); break;
        default: handled = false; break;
    }
    if (handled) {
        // 有推进就滚动续租：持续性任务（搬运/建造）不会因为租约到点被硬生生掐断
        t.touch = Game.time;
        t.deadline = Game.time + num(opt('leaseTicks'), 60);
    }
    return handled;
}

/* ============================== 结算：finish / stats ============================== */

/** 记一条结算样本：成功率、耗时、兑现的预计收益（给 L0 的 η 用） */
function recordStat(box, t, ok, ticks) {
    if (!box.stat) box.stat = { n: 0, ok: 0, fail: 0, ticks: 0, gain: 0, cost: 0, since: Game.time };
    const st = box.stat;
    st.n++;
    if (ok) st.ok++;
    else st.fail++;
    st.ticks += Math.max(0, Math.floor(ticks));
    if (t) {
        st.gain += ok ? num(t.estGain, 0) : 0;
        st.cost += Math.max(0, num(t.estCost, 0));
    }
    st.until = Game.time;

    const max = num(opt('maxFeedback'), 30);
    box.fb.push({
        t: Game.time,
        ty: t ? t.type : '?',
        ok: ok ? 1 : 0,
        dt: Math.max(0, Math.floor(ticks)),
    });
    while (box.fb.length > max) box.fb.shift();
}

/**
 * 结算当前任务：记实际耗时（从认领到结算）与成败，然后把它从队列里移除。
 * ok=false 表示"没做成"，但同样记一条样本 —— 失败率本身就是 η 的信号。
 *
 * @returns {boolean} 是否真的结算了一条任务
 */
function finish(creep, ok) {
    if (!creep || !creep.memory) return false;
    const cur = creep.memory.coreTask;
    creep.memory.coreTask = undefined;
    if (!cur || !cur.id) return false;

    const box = roomBox(cur.room || creep.room.name);
    const t = findBy(box, cur.id);
    if (!t) {
        // 任务在结算前已经被清理：仍然记一条"失踪"样本，避免统计静默失真
        recordStat(box, null, !!ok, Game.time - num(cur.at, Game.time));
        return false;
    }
    if (t.claim && t.claim !== creep.name) return false;   // 不是自己认领的，别替别人结算
    const spent = Game.time - num(t.claimAt, num(t.created, Game.time));
    recordStat(box, t, !!ok, spent);
    for (let i = 0; i < box.q.length; i++) {
        if (box.q[i].id === t.id) { box.q.splice(i, 1); break; }
    }
    return true;
}

/**
 * 房间任务层的结算指标（给 L0 / 看板用）。
 * eta = 已兑现的预计收益 / 已承诺的预计成本（0..1），可视为"任务层视角的 η"。
 */
function stats(roomName) {
    const box = roomBox(roomName);
    const st = box.stat;
    if (!st) return { n: 0, ok: 0, fail: 0, okRate: 0, avgTicks: 0, gain: 0, cost: 0, eta: 0, queued: box.q.length };
    const n = num(st.n, 0);
    return {
        n: n,
        ok: num(st.ok, 0),
        fail: num(st.fail, 0),
        okRate: n ? st.ok / n : 0,
        avgTicks: n ? st.ticks / n : 0,
        gain: num(st.gain, 0),
        cost: num(st.cost, 0),
        eta: st.cost > 0 ? Math.min(1, st.gain / st.cost) : 0,
        queued: box.q.length,
    };
}

/** 结算样本（只读）：L0 可以拿它算窗口内的任务完成率 */
function feedback(roomName) {
    return roomBox(roomName).fb.slice();
}

/** 结算样本（取走并清空）：L0 每 tick 结算一次都不重复计数 */
function drainFeedback(roomName) {
    const box = roomBox(roomName);
    const out = box.fb.slice();
    box.fb = [];
    return out;
}

/** 清空一个房间的队列（调试 / 灰度切换用；统计保留） */
function clear(roomName) {
    const box = roomBox(roomName);
    box.q = [];
    return true;
}

module.exports = {
    push,
    pick,
    exec,
    finish,
    sync,
    stats,
    feedback,
    drainFeedback,
    clear,
    size,
    enabled,
};

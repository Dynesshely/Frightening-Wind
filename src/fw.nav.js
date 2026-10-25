/**
 * fw.nav —— 导航层：全代码库唯一的移动入口。
 *
 * ============================ 为什么要有这一层 ============================
 *
 * 旧实现里，每个角色自己调 creep.moveTo，每个角色又各自维护一套"防抖/防卡/
 * 防越界"补丁（_lastPos、_lpos、_still、_stuck、_posHist、_rmTrail、_rmCool、
 * _edgeStuck、_jitter、_noPath ...）。这些补丁彼此不知情，还会互相篡改角色
 * 记忆（清空 targetRoom），于是形成正反馈：
 *
 *   角色重新决策 → 目标还是它 → 再次触发保护 → 再清空 → 再决策 → 振荡
 *
 * 结果就是单位在房间边界左右横跳，且越修越乱。根因不是某个补丁写错了，
 * 而是**系统里没有"意图"这个东西**：每 tick 都重新决定去哪，且任何人都能
 * 推翻这个决定。
 *
 * ============================== 本层的契约 ==============================
 *
 *   1. 角色层 setIntent（想去哪），导航层 step（怎么去）。
 *   2. 导航层**只读**意图，永不修改角色的业务记忆（targetRoom / patrolIndex ...）。
 *   3. 意图一旦建立，在到达 / 显式清除 / 过期之前**保持不变**，
 *      所以"每 tick 重新决策"这件事在结构上不可能发生。
 *   4. 跨房间时锁定"下一个出口格"（n.er 记录它属于哪个房间），
 *      进入新房间才重算 —— 中途任何情况都不会让它掉头。
 *   5. 出问题时导航层只做两件事：计数上报 + 拉黑不可达房间，
 *      具体的"换个目标"由角色层在明确的决策点完成。
 *
 * ================================ 字段 ================================
 *   creep.memory.nav = {
 *     r:  目标房间名
 *     x,y: 目标格
 *     g:  到达判定半径（49 = 进房间即算到，用于"只要求到达某房间"的语义）
 *     u:  意图过期 tick
 *     s:  意图序号（每次重建 +1，调试用）
 *     e:  锁定的出口格 {x,y}；er: 该出口格属于哪个房间
 *     p:  上一次位置快照（停滞检测）
 *     st: 连续未移动 tick 数
 *     lr: 上一个所在房间（房间切换检测）
 *     h:  最近的房间切换 tick 列表（振荡检测）
 *     hold: 冻结跨房间移动到该 tick
 *     np: 连续 ERR_NO_PATH 次数
 *     k:  出口格重试次数（用于换一个出口格）
 *   }
 */
const config = require('config');
const log = require('fw.log');

/* ------------------------------ 小工具 ------------------------------ */

/** 名字散列，用于把多个 creep 分散到不同出口格/脱困方向 */
function hash(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 9973;
    return h;
}

function posKey(creep) {
    return creep.room.name + ':' + creep.pos.x + ',' + creep.pos.y;
}

/** 读意图（不创建） */
function intent(creep) {
    return creep.memory && creep.memory.nav;
}

/** 保证有 nav 结构 */
function ensure(creep) {
    const m = creep.memory;
    if (!m.nav) m.nav = { r: '', x: -1, y: -1, g: 0, u: 0, s: 0 };
    return m.nav;
}

/* ------------------------------ 意图设置 ------------------------------ */

/**
 * 设定意图。目标与范围都没变、且未过期时直接复用（这是"不重新决策"的实现）。
 *
 * @param {Creep} creep
 * @param {string} room  目标房间名
 * @param {number} x,y   目标格（g=49 时可填房间中心占位）
 * @param {number} range 到达判定半径
 * @param {number} ttl   意图最长存活 tick；超时视为"可能到不了"，上报 nav.overtime
 */
function setIntent(creep, room, x, y, range, ttl) {
    const n = ensure(creep);
    const g = range || 0;
    const same = n.r === room && n.x === x && n.y === y && n.g === g;
    if (same) {
        if (n.u && Game.time <= n.u) return n;          // 意图有效，原样复用
        // 过期了但角色还在执行同一个意图：续期并上报，交给角色层去判断要不要放弃
        n.u = Game.time + (ttl || config.nav.intentTtl);
        log.ct('nav.overtime');
        return n;
    }
    n.r = room;
    n.x = x;
    n.y = y;
    n.g = g;
    n.u = Game.time + (ttl || config.nav.intentTtl);
    n.s = (n.s || 0) + 1;
    n.e = null;      // 目标变了，出口格必须重算
    n.er = null;
    n.np = 0;
    n.k = 0;
    n.st = 0;
    n.p = posKey(creep);
    return n;
}

/** 显式清除意图（角色完成任务后调用） */
function clear(creep) {
    if (creep.memory) creep.memory.nav = undefined;
}

/* ------------------------------ 出口选择 ------------------------------ */

/**
 * 选"跨到下一跳房间时的落脚格"。
 *
 * ★ 这里曾经是本项目最长寿的 bug 源头，试过两种错法 ★
 *
 *   错法一：把 moveTo 指到"下一房间的入口格"（跨房间坐标）。
 *           以为引擎会自己走完"当前房间 → 边界 → 跨越"。
 *           实测在线上不成立：creep 停在边界附近反复寻路失败，
 *           np/k 计数暴涨到几百，最终被拉黑。跨房间的坐标不能直接喂给 moveTo。
 *
 *   错法二：只把 moveTo 指到当前房间的边界格，指望走过去就自动跨房间。
 *           走到边界格并不会进入下一房间 —— 必须再朝外走一步。
 *           于是 creep 停在边界格上，被判定"停滞"，退回内部再走出去，来回横跳。
 *
 * 正确做法（本实现）：
 *   1. moveTo 的目标是**当前房间的边界格**（引擎完全支持，必定能走到）；
 *   2. 站上边界格后，用 creep.move(出口方向) 真正跨出这一房间。
 *   两步分开做，每一步都有确定的语义，不依赖引擎的跨房间寻路能力。
 *
 * 多个 creep 会挤在同一个出口格上，所以按名字散列在最近的几个格子里分流。
 */
function pickExit(creep, targetRoom) {
    let route;
    try { route = Game.map.findRoute(creep.room.name, targetRoom); } catch (e) { route = null; }
    if (!route || route === ERR_NO_PATH) { log.ct('nav.exitMiss'); return null; }
    if (!route.length) return null;                       // 已经在目标房间

    const dir = route[0].exit;
    const nextRoom = route[0].room;
    let tiles = null;
    try { tiles = creep.room.find(dir); } catch (e) { tiles = null; }
    if (!tiles || !tiles.length) { log.ct('nav.exitMiss'); return null; }

    // 按到自己的距离排序，取最近的若干个，再用名字散列分流
    const n = ensure(creep);
    tiles.sort(function (a, b) { return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b); });
    const picks = Math.min(config.nav.exitSpread, tiles.length);
    const idx = (hash(creep.name) + (n.k || 0) * 7) % picks;
    const tile = tiles[idx];
    return { x: tile.x, y: tile.y, dir: dir, room: nextRoom };
}

/* ------------------------------ 移动原语 ------------------------------ */

/** 8 方向脱困：起点按名字散列，避免所有 creep 往同一边挤 */
function unstick(creep) {
    const h = hash(creep.name);
    for (let k = 0; k < 8; k++) {
        const dir = ((h + k) % 8) + 1;   // TOP=1 ... TOP_LEFT=8
        if (creep.move(dir) === OK) {
            log.ct('nav.unstick');
            return true;
        }
    }
    log.ct('nav.stuck');
    return false;
}

/**
 * 位移一格。这是全代码库唯一真正调用 creep.moveTo 的地方。
 *
 * 停滞处理策略（按严重程度递进，且**从不修改角色业务记忆**）：
 *   连续 st 次没动 → 换一个出口格（跨房间时）/ 8 方向脱困
 *   仍然不动     → 上报 nav.giveUp，并把目标房间拉黑，由角色层下一轮换目标
 */
function doMove(creep, n, x, y, room) {
    const destRoom = room || creep.room.name;
    const key = posKey(creep);
    if (n.p === key) n.st = (n.st || 0) + 1;
    else { n.p = key; n.st = 0; }
    // 注意：这里**不做**"距离 1 格就算到位"的判断。
    // 跨房间时目标是出口格，必须真的踩上去才能 move() 跨出去；
    // 那个"目标格进不去就认了"的特例只在 step 的同房间分支里处理。

    // 停滞到阈值：先脱困，再考虑换出口
    if (n.st >= config.nav.stuckTicks) {
        n.st = 0;
        if (n.er) {                 // 跨房间途中卡住：换一个出口格，但绝不回头
            n.k = (n.k || 0) + 1;
            n.e = null;
            n.er = null;
            log.ct('nav.stuck');
            return false;
        }
        unstick(creep);
        return false;
    }

    let res;
    const crossing = destRoom !== creep.room.name;
    try {
        // 用 RoomPosition 而不是 moveTo(x, y) 双参形式：后者在部分引擎/模拟环境里
        // 拿不到房间信息会直接 ERR_INVALID_ARGS，统一成对象形式最稳。
        res = creep.moveTo(new RoomPosition(x, y, destRoom), {
            reusePath: config.pathReuse,
            ignoreCreeps: true,     // 路径计算忽略同伴，否则多人互相封路会集体 ERR_NO_PATH
            // 跨房间时目标是"隔壁房间的入口格"，要让引擎允许算到下个房间
            maxRooms: crossing ? 2 : 1,
            // ★ 这里必须是 0，不能传 n.g ★
            // n.g 是"意图到达半径"，g=49 表示"进入目标房间就算到达"，只用于本层的
            // 到达判定；把它交给引擎等于告诉它"49 格内都算到了"，creep 一步都不会走。
            // 能走到这里说明还没到到达半径内，所以目标就是精确踩到那一格。
            range: 0,
        });
    } catch (e) {
        res = ERR_NO_PATH;
    }

    if (res === OK) { log.ct('nav.move'); n.np = 0; return true; }
    if (res === ERR_TIRED) { log.ct('nav.tired'); return true; }

    if (res === ERR_NO_PATH) {
        log.ct('nav.noPath');
        n.np = (n.np || 0) + 1;
        if (n.er) { n.e = null; n.er = null; n.k = (n.k || 0) + 1; }
        // 连续寻路失败：判定该目标不可达。只拉黑，不改角色记忆。
        if (n.np >= config.nav.giveUpAfter) giveUp(creep, n);
        return false;
    }

    log.ct('nav.err');
    return false;
}

/** 放弃当前意图：拉黑目标房间 + 让意图立即过期，角色层下一轮会重新决策 */
function giveUp(creep, n) {
    const fw = Memory.fw || (Memory.fw = {});
    if (n.r) {
        if (!fw.unreachable) fw.unreachable = {};
        fw.unreachable[n.r] = Game.time;
        log.alert('nav.unreachable', creep.name + ' → ' + n.r + ' 连续 ' + n.np + ' 次寻路失败，拉黑 3000 tick');
    }
    log.ct('nav.giveUp');
    n.u = 0;            // 意图立即过期（下一 tick setIntent 会重建）
    n.np = 0;
    n.e = null;
    n.er = null;
}

/* ------------------------------ 振荡保护 ------------------------------ */

/**
 * 记录房间切换。作为结构性的安全网：即使上层逻辑有 bug 想来回跑，
 * 这一层也会在检测到振荡后冻结跨房间移动一段时间。
 *
 * 注意这里**不清除任何目标**，只是暂时禁止跨越边界 —— 上一个版本在这里
 * 清空 targetRoom，反而制造了"无目标 → 发呆"的新问题。
 */
function noteRoom(creep, n) {
    const here = creep.room.name;
    if (n.lr === here) return;
    n.lr = here;
    if (!n.h) n.h = [];
    n.h.push(Game.time);
    if (n.h.length > 8) n.h.shift();

    const win = config.nav.oscWindow;
    if (n.h.length >= config.nav.oscCount && (Game.time - n.h[0]) < win) {
        if (!n.hold || Game.time >= n.hold) {
            n.hold = Game.time + config.nav.holdTicks;
            log.ct('nav.osc');
            log.alert('nav.oscillate', creep.name + ' 在 ' + win + ' tick 内跨房间 ' + n.h.length + ' 次，冻结 ' + config.nav.holdTicks + ' tick');
            n.h = [];
        }
    }
}

/* ------------------------------ 主推进 ------------------------------ */

/**
 * 朝意图推进一步。
 * @returns {boolean} true = 已到达（或本 tick 已在目标判定范围内）
 */
function step(creep, n) {
    noteRoom(creep, n);

    // ---- 跨房间冻结（振荡保护的最终形态）----
    // 两个来源：noteRoom 自动检测到的振荡，以及 roles.run 兜底调用的 freeze()。
    // 冻结期内只允许在本房间内部活动，任何"去别的房间"的意图都降级为回房间中心。
    const holdUntil = creep.memory.navHold;
    if (holdUntil) {
        if (Game.time >= holdUntil) {
            creep.memory.navHold = undefined;
        } else if (creep.room.name !== n.r) {
            log.ct('nav.hold');
            if (creep.pos.getRangeTo(25, 25) > config.nav.holdRadius) {
                doMove(creep, n, 25, 25);
            }
            return false;
        }
    }

    // ---- 同房间：直接冲目标格 ----
    if (creep.room.name === n.r) {
        n.e = null;
        n.er = null;

        // ---- 跨房间意图的"深入"要求 ----
        // moveToRoom 的意图半径是 49（进房间即算到）。但如果真的只走到入口格就停下，
        // 下一 tick 角色一看"我还在房间边缘"就会犹豫、掉头，于是两个房间来回跨 ——
        // 线上实测每 2 tick 横跳一次，几百 tick 不停。
        // 所以：进房间之后必须继续走到离边界 roomEntryDepth 格以外，才算这次跨房间真正完成。
        if (n.g >= 10) {
            const depth = Math.min(creep.pos.x, 49 - creep.pos.x, creep.pos.y, 49 - creep.pos.y);
            if (depth < config.nav.roomEntryDepth) {
                doMove(creep, n, 25, 25);
                return false;
            }
            return true;
        }

        const d = Math.max(Math.abs(creep.pos.x - n.x), Math.abs(creep.pos.y - n.y));
        if (d <= n.g) return true;                  // 到达
        // 要求踩到目标格(g=0)却只在旁边 1 格、且连续几 tick 都挤不进去：
        // 说明那格被别人站着。停在旁边就是最优解，不能判成卡住 ——
        // 否则脱困逻辑会把静止挖矿的矿工随机踢开，形成来回踱步。
        if (n.g === 0 && d === 1 && n.st >= config.nav.stuckTicks) {
            n.st = 0;
            return true;
        }
        return doMove(creep, n, n.x, n.y);
    }

    // ---- 跨房间：先走到本房间的出口格，再朝外走一步跨过去 ----
    if (n.er !== creep.room.name || !n.e) {
        const exit = pickExit(creep, n.r);
        if (!exit) {
            // 没有可达出口（地形隔离 / 房间不存在）：走房间中心等下一 tick 重试
            if (creep.pos.getRangeTo(25, 25) > 5) doMove(creep, n, 25, 25);
            n.np = (n.np || 0) + 1;
            if (n.np >= config.nav.giveUpAfter) giveUp(creep, n);
            return false;
        }
        n.e = { x: exit.x, y: exit.y, dir: exit.dir };
        n.er = creep.room.name;
        n.es = 0;
        log.ct('nav.exit');
    }

    // 已经站在出口格上：直接朝外迈一步，这一步就是真正的跨房间
    if (creep.pos.x === n.e.x && creep.pos.y === n.e.y) {
        // ★ 出口格上的停滞检测（线上踩过的坑）★
        // Screeps 里当出口格外侧被另一个 creep 占着时，creep.move() 会返回 OK
        // 但 creep 纹丝不动。如果这里不检测，它会以为"正在跨房间"而无限等下去 ——
        // 线上表现为一大群远程矿工堵在同一个边界格上几百 tick。
        n.es = (n.es || 0) + 1;
        if (n.es > config.nav.stuckTicks) {
            n.es = 0;
            n.k = (n.k || 0) + 1;     // 换一个出口格（绝不回头）
            n.e = null;
            n.er = null;
            log.ct('nav.exitMiss');
            return false;
        }
        const mv = creep.move(n.e.dir);
        if (mv === OK || mv === ERR_TIRED || mv === ERR_BUSY) {
            log.ct('nav.cross');
            n.np = 0;
            // 注意返回 false：跨出去这一步只是"在路上"，真正到达要等下一 tick
            // 站在目标房间里。返回 true 会让角色误以为已经到位，立刻改主意。
            return creep.room.name === n.r;
        }
        // 方向非法 / 被墙挡：立刻换出口格
        log.ct('nav.exitMiss');
        n.k = (n.k || 0) + 1;
        n.es = 0;
        n.e = null;
        n.er = null;
        n.np = (n.np || 0) + 1;
        if (n.np >= config.nav.giveUpAfter) giveUp(creep, n);
        return false;
    }
    n.es = 0;

    log.ct('nav.cross');
    return doMove(creep, n, n.e.x, n.e.y);
}

/* ------------------------------ 对外 API ------------------------------ */

/**
 * 单房间内移动到某个目标（对象 / RoomPosition / {x,y,roomName}），可用 range 指定停止距离。
 * 目标在别的房间时自动切换到跨房间推进。
 */
function moveTo(creep, target, opts) {
    if (!target) return false;
    const o = opts || {};
    const pos = target.pos || target;
    const room = pos.roomName || creep.room.name;
    const range = o.range || 0;
    const n = setIntent(creep, room, pos.x, pos.y, range, o.ttl);
    return step(creep, n);
}

/**
 * 跨房间移动：只要进入目标房间就算到达（g = 49）。
 * 保持旧签名兼容，内部走同一套意图/出口机制。
 */
function moveToRoom(creep, roomName) {
    if (!roomName) return false;
    if (creep.room.name === roomName) {
        const n = ensure(creep);
        n.e = null; n.er = null; n.hold = 0;
        return true;
    }
    const n = setIntent(creep, roomName, 25, 25, 49, config.nav.intentTtl * 2);
    return step(creep, n);
}

/** 是否已经在 (room, x, y) 的 range 范围内 */
function arrived(creep, room, x, y, range) {
    if (creep.room.name !== room) return false;
    const d = Math.max(Math.abs(creep.pos.x - x), Math.abs(creep.pos.y - y));
    return d <= (range || 0);
}

/**
 * 冻结跨房间移动。
 *
 * 存在 creep.memory.navHold（而不是意图对象里），这样意图被重建、被清除都不会丢。
 * 角色层（roles.run 的横跳检测）可以调用它作为最后一道防线 ——
 * 线上出现过角色逻辑绕过 step 的振荡检测、在两个房间之间每 tick 往返的情况。
 */
function freeze(creep, ticks) {
    if (!creep.memory) return;
    creep.memory.navHold = Game.time + (ticks || config.nav.holdTicks);
    log.ct('nav.osc');
}

/** 是否处于跨房间冻结期 */
function frozen(creep) {
    return !!(creep.memory && creep.memory.navHold && Game.time < creep.memory.navHold);
}

/** 当前意图的目标房间（没有意图返回 undefined）——角色层用它判断"要不要重新决策" */
function targetRoom(creep) {
    const n = intent(creep);
    return n && n.u ? n.r : undefined;
}

/** 意图是否已经过期（角色层看到 true 就该换个目标了） */
function expired(creep) {
    const n = intent(creep);
    return !n || !n.u || Game.time > n.u;
}

/** 是否处于振荡冻结中 */
function frozen(creep) {
    const n = intent(creep);
    return !!(n && n.hold && Game.time < n.hold);
}

module.exports = {
    moveTo, moveToRoom, setIntent, clear, step,
    arrived, targetRoom, expired, frozen, intent, freeze,
    // 暴露内部原语给少数需要"原地推一格"的场景（如采矿对位）
    unstick,
};

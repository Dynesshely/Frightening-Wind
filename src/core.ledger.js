/**
 * core.ledger —— L0 观测层：每 tick 的能量流水 + 300 tick 滑动窗口统计。
 *
 * ============================== 这一层解决什么 ==============================
 *
 * 旧代码里"收入多少、钱花哪了"只存在于 role 日志和人的直觉里：调参时只能看
 * controller.progress 的差和 Memory.fw.ct 的累计计数，既算不出净收入，也算不出
 * η（有效产出 / 理论产能）。ARCHITECTURE_V2.md §2 因此把 L0 定成"唯一的事实来源"：
 * 每 tick 记一条流水，滚动 300 tick 求平均，上层（L2 预算）只读 snapshot()。
 *
 * ============================== 契约 ==============================
 *
 *   ledger.record(roomName, {
 *       income: { harvest, passive, link },              // e/tick 分项
 *       spend:  { spawn, upkeep, upgrade, build, tower }, // e/tick 分项
 *       state:  { stored, creepCount, workActive },       // 状态量
 *       structs: { container_owned: n, rampart: n, ... }, // 可选：维护负债用（M12）
 *       traffic: 每 tick 踩格部件数（可选，road 的交通项）
 *       sources: 本房 source 数（可选，缺省沿用上次）
 *       sourceCap: source 库存上限（可选，M08 三档，缺省 3000）
 *   })
 *
 *   ledger.snapshot(roomName) → { income, spend, net, eta, upkeepDebt, samples, detail }
 *
 * ============================== 存储格式 ==============================
 *
 * Memory.fw.ledger2[roomName] = {
 *     ring: [[t, i0,i1,i2, s0,s1,s2,s3,s4, st0,st1,st2], ...],  // 每条 12 个数字
 *     head: 写指针（环形，满后覆盖最旧）,
 *     len:  已填充条数（≤ 300）,
 *     src / q: 最近一次已知的 source 数与库存上限,
 *     st:   [7 个数字] 最近一次已知的结构计数（维护负债用）,
 *     tr:   最近一次的交通项,
 *     t:    最近一次写入的 tick（同 tick 重复 record 时覆盖而不是追加）
 * }
 *
 * 为什么压成数组、为什么全是数字：
 *   1) Memory 有 2MB 上限，对象键名占了 70% 体积；300 条 × 12 个数字 ≈ 30KB/房间，
 *      换成对象会到 100KB+。
 *   2) "只存数字"顺带保证了不会有对象引用混进 Memory（Screeps 的经典事故：
 *      Memory 里存了 RoomObject，序列化后变成一堆 id 字符串）。
 *
 * ============================== 口径（改之前先读） ==============================
 *
 *   income / spend 都是**每 tick 的量**，不是区间累计；record 的调用方（economy）负责
 *   把"本 tick 实际发生了多少"算好传进来。窗口内对每一项取算术平均。
 *   net = income − spend。
 *   eta = 窗口平均"采集收入" / 该 WORK 数在 source 上的稳态产出（estimator.yieldOf）。
 *       **只用 harvest 分项**：passive（spawn 自回 1 e/tick）和 link 不是 source 产出，
 *       算进来会把 η 抬高，掩盖"矿工没在矿上"这件事。
 *   upkeepDebt = 最近一次 structs + 交通项 → estimator.upkeepDebt()，即维护负债 e/tick。
 *       （结构数量变化很慢，没必要每 tick 存一份，所以放在 meta 里而不是流水里。）
 */
const config = require('config');
const est = require('core.estimator');

/* ------------------------------ 流水 schema ------------------------------ */
// 固定顺序，改顺序必须同时 +1 SCHEMA_VER（旧 Memory 会被 reset，见 housekeeping 迁移）
const SCHEMA_VER = 2;
const IN_KEYS = ['harvest', 'passive', 'link'];
const SP_KEYS = ['spawn', 'upkeep', 'upgrade', 'build', 'tower'];
const ST_KEYS = ['stored', 'creepCount', 'workActive'];
const SLOT = 1 + IN_KEYS.length + SP_KEYS.length + ST_KEYS.length;   // tick + 3 + 5 + 3 = 12
// 结构计数的固定顺序（meta.st）
const STRUCT_KEYS = ['container_owned', 'container_unowned', 'rampart', 'wall',
                     'road_plain', 'road_swamp', 'road_wall'];
//: 环形缓冲上限：取 config.core.ledgerWindow（默认 300），硬顶 ≤ 300（ARCHITECTURE_V2 §2）
const CAP = (function () {
    const w = config && config.core && config.core.ledgerWindow;
    const n = Math.round(Number(w));
    if (!isFinite(n) || n <= 0) return 300;
    return n > 300 ? 300 : n;
})();

/* ------------------------------ 小工具 ------------------------------ */

function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
}
/** 保留 3 位小数：收入量级是 0..20，3 位足够；同时把 Memory 体积压到最小。 */
function r3(v) {
    return Math.round(num(v) * 1000) / 1000;
}

function root() {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.ledger2) Memory.fw.ledger2 = {};
    return Memory.fw.ledger2;
}

function ensure(roomName) {
    const store = root();
    let m = store[roomName];
    if (!m || !m.ring || !Array.isArray(m.ring)) {
        m = store[roomName] = { ring: [], head: 0, len: 0, v: SCHEMA_VER, src: 0, q: 0, st: [], tr: 0, t: -1 };
    }
    if (m.v !== SCHEMA_VER) {
        // 版本不一致：整条丢弃重来（迁移期间最多丢一个窗口的数据）
        m = store[roomName] = { ring: [], head: 0, len: 0, v: SCHEMA_VER, src: m.src || 0, q: m.q || 0, st: [], tr: 0, t: -1 };
    }
    if (!Array.isArray(m.ring)) m.ring = [];
    return m;
}

/** 把 structs 的计数压成固定顺序的数字数组（meta.st）。 */
function packStructs(structs) {
    const out = [];
    for (let i = 0; i < STRUCT_KEYS.length; i++) out.push(r3(structs[STRUCT_KEYS[i]] || 0));
    return out;
}
function unpackStructs(arr) {
    const out = {};
    if (!arr || !arr.length) return out;
    for (let i = 0; i < STRUCT_KEYS.length; i++) out[STRUCT_KEYS[i]] = num(arr[i]);
    return out;
}

/** 取一条流水的某一栏（越界一律当 0，纯读）。 */
function slot(entry, idx) {
    const v = entry[idx];
    return isFinite(v) ? v : 0;
}

/* ------------------------------ 写入 ------------------------------ */

/**
 * 记录一条流水。每房每 tick 一次；同一 tick 重复调用会**覆盖**而不是追加
 * （集成点是 economy.runRoom 的收尾 + 可能的角色层补写，重复调用要安全）。
 */
function record(roomName, entry) {
    if (!roomName) return null;
    const m = ensure(roomName);
    const e = entry || {};
    const inc = e.income || {};
    const sp = e.spend || {};
    const st = e.state || {};

    const tick = num(e.tick) || (typeof Game !== 'undefined' && Game.time ? Game.time : 0);
    const row = [tick];
    for (let i = 0; i < IN_KEYS.length; i++) row.push(r3(inc[IN_KEYS[i]]));
    for (let i = 0; i < SP_KEYS.length; i++) row.push(r3(sp[SP_KEYS[i]]));
    for (let i = 0; i < ST_KEYS.length; i++) row.push(r3(st[ST_KEYS[i]]));

    // meta（不占流水位）：结构计数、交通项、source 数、库存上限
    if (e.structs) m.st = packStructs(e.structs);
    if (e.traffic !== undefined) m.tr = r3(e.traffic);
    if (e.sources !== undefined) m.src = Math.max(0, Math.round(num(e.sources)));
    if (e.sourceCap !== undefined) m.q = Math.max(0, Math.round(num(e.sourceCap)));

    const lastIdx = m.len === 0 ? -1 : (m.head - 1 + CAP) % CAP;
    if (lastIdx >= 0 && m.ring[lastIdx] && m.ring[lastIdx][0] === tick) {
        m.ring[lastIdx] = row;                        // 同 tick 覆盖
    } else {
        m.ring[m.head] = row;
        m.head = (m.head + 1) % CAP;
        if (m.len < CAP) m.len++;
    }
    m.t = tick;
    return row;
}

/* ------------------------------ 读取 ------------------------------ */

/**
 * 窗口统计。返回 ARCHITECTURE_V2 §2 规定的 6 个字段，外加 detail（分项均值，
 * L2 budget 要用；键名与 record 的入参一致）。
 */
function snapshot(roomName) {
    const empty = { income: 0, spend: 0, net: 0, eta: 0, upkeepDebt: 0, samples: 0, detail: null };
    if (!roomName) return empty;
    const m = ensure(roomName);
    if (!m.len) return empty;

    const n = m.len;
    const incSum = []; const spSum = []; const stSum = [];
    for (let i = 0; i < IN_KEYS.length; i++) incSum.push(0);
    for (let i = 0; i < SP_KEYS.length; i++) spSum.push(0);
    for (let i = 0; i < ST_KEYS.length; i++) stSum.push(0);

    for (let i = 0; i < n; i++) {
        const row = m.ring[i];
        if (!row) continue;
        for (let k = 0; k < IN_KEYS.length; k++) incSum[k] += slot(row, 1 + k);
        for (let k = 0; k < SP_KEYS.length; k++) spSum[k] += slot(row, 1 + IN_KEYS.length + k);
        for (let k = 0; k < ST_KEYS.length; k++) stSum[k] += slot(row, 1 + IN_KEYS.length + SP_KEYS.length + k);
    }

    const income = {}; const spend = {}; const state = {};
    let incomeTotal = 0; let spendTotal = 0;
    for (let i = 0; i < IN_KEYS.length; i++) {
        income[IN_KEYS[i]] = incSum[i] / n;
        incomeTotal += income[IN_KEYS[i]];
    }
    for (let i = 0; i < SP_KEYS.length; i++) {
        spend[SP_KEYS[i]] = spSum[i] / n;
        spendTotal += spend[SP_KEYS[i]];
    }
    for (let i = 0; i < ST_KEYS.length; i++) state[ST_KEYS[i]] = stSum[i] / n;

    // η：采集收入 / 该 WORK 数在 source 上的稳态产出（M08）
    const q = m.q || est.sourceCapacity('owned');
    const srcCount = m.src || 0;
    const workPerSource = srcCount > 0 ? state.workActive / srcCount : state.workActive;
    const theoretical = srcCount > 0 ? srcCount * est.yieldOf(workPerSource, q) : est.yieldOf(workPerSource, q);
    let eta = theoretical > 0 ? income.harvest / theoretical : 0;
    if (eta < 0) eta = 0;
    if (eta > 1) eta = 1;

    return {
        income: incomeTotal,
        spend: spendTotal,
        net: incomeTotal - spendTotal,
        eta: eta,
        upkeepDebt: est.upkeepDebt(unpackStructs(m.st), m.tr),
        samples: n,
        detail: {
            income: income,
            spend: spend,
            state: state,
            theoretical: theoretical,
            sources: srcCount,
            sourceCap: q,
        },
    };
}

/** 清空某个房间的窗口（迁移/换房/排障用；不是每 tick 调用）。 */
function reset(roomName) {
    if (!roomName) return;
    const store = root();
    delete store[roomName];
}

/** 调试用：把一条流水还原成对象（只读）。 */
function decode(row) {
    if (!row || !row.length) return null;
    const out = { tick: slot(row, 0), income: {}, spend: {}, state: {} };
    for (let i = 0; i < IN_KEYS.length; i++) out.income[IN_KEYS[i]] = slot(row, 1 + i);
    for (let i = 0; i < SP_KEYS.length; i++) out.spend[SP_KEYS[i]] = slot(row, 1 + IN_KEYS.length + i);
    for (let i = 0; i < ST_KEYS.length; i++) out.state[ST_KEYS[i]] = slot(row, 1 + IN_KEYS.length + SP_KEYS.length + i);
    return out;
}

module.exports = {
    record: record,
    snapshot: snapshot,
    reset: reset,
    decode: decode,
    CAP: CAP,
    SLOT: SLOT,
    SCHEMA_VER: SCHEMA_VER,
    IN_KEYS: IN_KEYS,
    SP_KEYS: SP_KEYS,
    ST_KEYS: ST_KEYS,
    STRUCT_KEYS: STRUCT_KEYS,
};

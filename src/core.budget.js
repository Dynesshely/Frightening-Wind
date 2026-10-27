/**
 * core.budget —— L2 预算分配：唯一决定"谁花多少"的地方。
 *
 * ============================== 这一层是什么 ==============================
 *
 * 契约见 docs/ARCHITECTURE_V2.md §4。输入是 L0 账本窗口（core.ledger.snapshot），
 * 输出是各去向的 e/tick 预算；**不推导人数、不碰 Game、不写 Memory**（那是 L2 policy 的事）。
 *
 * 分配顺序（ROI 从高到低）：
 *   1. upkeep  硬约束：维护负债先扣，扣不起就必须降级基建（overBudget=true）
 *   2. spawn   繁殖预算（ROI 最高，先给）
 *   3. upgrade 升级预算（把能量换成 RCL）
 *   4. build   建造预算（有工地才给；没有就把这份份额退到 reserve）
 *   5. defense 防御储备（按入侵频率，平时也留一份，避免临战时没钱）
 *   6. reserve 其余（pixel / 市场，当前不花，留作缓冲）
 *
 * 不该放进来：
 *   - 角色人数 / 身体（core.policy.js）与任务队列（core.task.js）；
 *   - 账本读写（core.ledger.js）—— snap 是入参，本模块只做算术；
 *   - 任何 utils / fw.* 调用（L2 不允许反向依赖 L4，否则灰度开关会绕不过去）。
 *
 * 依赖：config（config.core.budgetShare / upkeepRatio）。
 * 不 require core.ledger：snap 由调用方传入，避免 L2 被 L0 的加载顺序绑住。
 */
const config = require('config');

/* ------------------------------ 默认值 ------------------------------ */

// 与 config.core 同名的阈值在这里再写一份默认值：
// config 里缺项时仍然能跑（单测 / 灰度 / 未来把 core 段挪走都不会炸）。
const DEFAULTS = {
    budgetShare: { spawn: 0.5, upgrade: 0.3, build: 0.15, defense: 0.05 },
    upkeepRatio: 0.3,
};

function coreCfg() {
    return (config && config.core) || {};
}

function shareOf() {
    const s = coreCfg().budgetShare || {};
    const d = DEFAULTS.budgetShare;
    return {
        spawn: pick(s.spawn, d.spawn),
        upgrade: pick(s.upgrade, d.upgrade),
        build: pick(s.build, d.build),
        defense: pick(s.defense, d.defense),
    };
}

function upkeepRatio() {
    return pick(coreCfg().upkeepRatio, DEFAULTS.upkeepRatio);
}

/* ------------------------------ 小工具 ------------------------------ */

/** 非数字一律回退默认值（账本还没攒够样本时 snap 里可能是 undefined）。 */
function pick(value, fallback) {
    const n = Number(value);
    return isFinite(n) ? n : fallback;
}

/** 保留 4 位小数：预算是 e/tick，浮点噪声没必要带进 Memory 和日志。 */
function r4(x) {
    return Math.round(x * 10000) / 10000;
}

/* ------------------------------ 主函数 ------------------------------ */

/**
 * 分配一 tick 的能量预算。
 *
 * @param {Room}   room  当前房间（本模块不用它的方法，保留位置以对齐契约签名）
 * @param {Object} data  roomData 快照（只用 data.sites 判断"有没有建造需求"）
 * @param {Object} snap  core.ledger.snapshot() → {income, spend, net, eta, upkeepDebt, samples}
 * @returns {{total:number, upkeep:number, spawn:number, upgrade:number,
 *            build:number, defense:number, reserve:number, overBudget:boolean}}
 */
function allocate(room, data, snap) {
    const s = snap || {};
    const total = r4(pick(s.net, 0));                       // 窗口净收入（可能为负）
    const upkeep = r4(Math.max(0, pick(s.upkeepDebt, 0)));  // 维护负债是硬约束，恒非负

    // 可支配部分：先扣维护，再按比例分。total 为负时全部为 0（收缩模式）。
    const disposable = r4(Math.max(0, total - upkeep));
    const ratio = upkeepRatio();

    // 超预算判定：净收入为负，或者维护吃掉的比例超过 upkeepRatio（默认 30%）。
    // 维护是"不做就会烂掉"的支出，所以它超限时不是砍维护，而是要求 policy 砍别的东西。
    const overBudget = total <= 0 || upkeep > total * ratio;

    const sh = shareOf();
    const hasSites = !!(data && data.sites && data.sites.length > 0);

    const spawn = r4(disposable * sh.spawn);
    const upgrade = r4(disposable * sh.upgrade);
    // 建造"有门槛"：没工地就不给钱，省下来的份额进 reserve（不许悄悄加到 upgrade 上，
    // 否则无工地时升级会超支、把 spawn 的繁殖预算挤掉）。
    const build = hasSites ? r4(disposable * sh.build) : 0;
    const defense = r4(disposable * sh.defense);
    const reserve = r4(disposable - spawn - upgrade - build - defense);

    return {
        total: total,
        upkeep: upkeep,
        spawn: spawn,
        upgrade: upgrade,
        build: build,
        defense: defense,
        reserve: reserve,
        overBudget: overBudget,
    };
}

module.exports = { allocate: allocate };

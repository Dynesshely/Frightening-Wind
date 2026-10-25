/**
 * fw.log —— 统一的可观测性层。
 *
 * 设计原则：
 *   1. 所有计数器都写进 Memory.fw.ct，键名受白名单约束，避免 Memory 无限膨胀。
 *   2. 所有"沉默降级"（本该做某事但放弃了）必须打一次计数 + 一条告警，不允许静默。
 *   3. say() 同时把文本写进 creep.memory.lastSay，方便外部采样时读取角色状态。
 *
 * 只依赖 config，不依赖任何上层模块（避免循环 require）。
 */
const config = require('config');

// 计数器键白名单：只有登记过的键才允许写入，防止拼写错误/临时调试键污染 Memory。
// 新增计数器必须在这里登记 —— 这是刻意的摩擦，用来逼开发者为指标命名。
const KEYS = [
    // 导航
    'nav.move', 'nav.tired', 'nav.noPath', 'nav.err',
    'nav.cross', 'nav.exit', 'nav.exitMiss',
    'nav.stuck', 'nav.unstick', 'nav.osc', 'nav.hold',
    'nav.overtime', 'nav.giveUp',
    // 经济
    'work.harvest', 'work.deliver', 'work.build', 'work.repair', 'work.upgrade',
    // 调度
    'spawn.ok', 'spawn.fail', 'spawn.idle',
    // 兼容旧键名（历史看板仍在读）
    'move', 'noPath', 'tired', 'unstick', 'stuckHard', 'jitter',
    'moveRoom', 'moveRoomNoPath', 'moveRoomGiveUp',
];
const KEY_SET = {};
for (let i = 0; i < KEYS.length; i++) KEY_SET[KEYS[i]] = true;

const MAX_ALERTS = 20;
const MAX_KEYS = 120;

function mem() {
    if (!Memory.fw) Memory.fw = {};
    if (!Memory.fw.ct) Memory.fw.ct = { since: Game.time };
    return Memory.fw;
}

/**
 * 计数器 +1。
 *
 * 允许任意键（历史代码里有 bump('harvestErr_' + r) 这类动态键），
 * 但用 MAX_KEYS 兜住上限，防止某个 bug 把带时间戳的键写进 Memory 撑爆内存。
 */
function ct(name) {
    const fw = mem();
    const c = fw.ct;
    if (c[name] === undefined) {
        // 新键：先数一下当前键数量，超限就拒绝并告警一次
        let n = 0;
        for (const k in c) n++;
        if (n >= MAX_KEYS) {
            if (!fw.ctFull) {
                fw.ctFull = Game.time;
                console.log('[FW] 计数器已达上限 ' + MAX_KEYS + '，拒绝新键: ' + name);
            }
            return;
        }
    }
    c[name] = (c[name] || 0) + 1;
    c.until = Game.time;
}

/** 计数器累加 n（用于批量数值，如搬运量） */
function add(name, n) {
    const fw = mem();
    if (!fw.ct) fw.ct = { since: Game.time };
    fw.ct[name] = (fw.ct[name] || 0) + (n || 0);
    fw.ct.until = Game.time;
}

/**
 * 强化告警：会保留最近 MAX_ALERTS 条，供外部诊断读取。
 * detail 里不要放大对象，只放能定位问题的短数据。
 */
function alert(kind, detail) {
    const fw = mem();
    if (!fw.alerts) fw.alerts = [];
    fw.alerts.push({ t: Game.time, k: kind, d: String(detail || '').slice(0, 120) });
    if (fw.alerts.length > MAX_ALERTS) fw.alerts.shift();
    console.log('[FW] ⚠ ' + kind + ': ' + detail);
}

/**
 * 在 creep 头顶说话，并同步写入 memory.lastSay。
 * 外部采样脚本靠 lastSay 判断角色当前在干什么，所以这里必须写。
 */
function say(creep, text) {
    if (!creep || creep.spawning) return;
    if (creep.memory) creep.memory.lastSay = text;
    try { creep.say(text); } catch (e) { /* 正在死亡/被回收的 creep 可能没有 say */ }
}

/** 定期整理：计数器只保留需要的，防止 Memory 老化 */
function maintain() {
    const fw = mem();
    if (fw.unknownCt && Game.time % 1000 === 0) fw.unknownCt = undefined;
    // 计数器每秒清零一次？不 —— 保留累计值供人工分析，只重置窗口起点
    if (Game.time % 10000 === 0 && fw.ct) {
        fw.ctPrev = { at: Game.time };
        for (const k in fw.ct) if (k !== 'since' && k !== 'until' && k !== 'ctPrev') fw.ct[k] = 0;
    }
}

module.exports = { ct, add, say, alert, maintain, KEYS };

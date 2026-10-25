/**
 * defense —— 防御门面（facade）。
 *
 * 本文件只做两件事：把防御策略编排成每 tick 的 run()，以及把子模块的公开接口原样转发出去。
 * 原先 800 多行的实现已按职责拆成四个模块（行为、键名、调用点均不变）：
 *
 *   fw.threat.js   威胁认知 + 防御记忆 + 共享原语（attempt/noteError、rangeTo/posOf…）、
 *                  isEmergency、activateSafeModeIfNeeded、trackRoom
 *   mgr.tower.js   塔的调度：对敌作战 → 治疗 → 维修（runTowers）
 *   mgr.wall.js    防御工事规划：rampart 工地门槛、来敌方向、候选格打分（planDefense）
 *   mgr.flee.js    撤退决策：触发、落点、状态清理、isFleeing（fleeIfNeeded / isFleeing）
 *
 * 依赖方向（单向，无循环）：
 *   defense → mgr.tower / mgr.wall / mgr.flee → fw.threat；mgr.flee 另依赖 utils（位移走 utils.moveTo）。
 *   子模块之间互不 require；新逻辑请加到对应子模块，不要往门面里堆。
 *
 * 设计原则（对四个子模块同样成立）：
 *  1. 每一次游戏 API 调用都有返回值检查或 try/catch —— 任何一步失败都只降级、不抛异常。
 *     主循环虽然会兜住异常，但每 tick 抛一次会刷屏控制台并刷爆 Memory.fw.errors。
 *  2. 不修改 Creep/Room 原型；不往 Memory 里存游戏对象，只存 tick 数字、id 字符串和 {x,y} 坐标。
 *  3. 重活（防御工事规划）有前置门槛：没有威胁历史且 RCL<5 时完全不花能量。
 *  4. 位移只允许经过 utils.moveTo / utils.moveToRoom（委托 fw.nav），
 *     任何子模块都不允许直接写 creep.moveTo / creep.move。
 *
 * 导出（键名与拆分前完全一致，调用点无需改动）：
 *  run(room, data)                  每 tick 每间我方房间调用一次，内部依次执行 trackRoom / 塔 / 安全模式 / 逃跑 / 规划
 *  runTowers(room, data)            塔：打敌人 / 治疗 / 维修
 *  activateSafeModeIfNeeded(room, data)  紧急安全模式
 *  fleeIfNeeded(room, data)         敌人靠近时逃跑
 *  planDefense(room, data)          防御工事（rampart）规划
 *  isFleeing(creep)                 给 roles.js 用：本 tick 该 creep 是否处于逃跑状态
 */

const utils = require('utils');
const threat = require('fw.threat');
const towerMgr = require('mgr.tower');
const wallMgr = require('mgr.wall');
const fleeMgr = require('mgr.flee');

/* ------------------------------ 入口 ------------------------------ */

/**
 * 每 tick 每间我方房间调用一次。
 * 返回汇总对象（只用于调试/统计，不参与决策）。
 */
function run(room, data) {
    const out = { towers: null, safeMode: false, flee: null, defense: null, error: null };
    try {
        if (!room) {
            out.error = 'no-room';
            return out;
        }
        let d = data;
        if (!d) {
            d = threat.attempt(function () { return utils.roomData(room); }, null);
        }
        if (!d) {
            out.error = 'no-data';
            return out;
        }

        threat.trackRoom(room, d);

        out.towers = towerMgr.runTowers(room, d);
        out.safeMode = threat.activateSafeModeIfNeeded(room, d);
        out.flee = fleeMgr.fleeIfNeeded(room, d);
        out.defense = wallMgr.planDefense(room, d);
        return out;
    } catch (e) {
        threat.noteError(e);
        out.error = e && e.message ? String(e.message) : 'unknown';
        return out;
    }
}

/* ------------------------------ 门面转发 ------------------------------ */

module.exports = {
    runTowers: towerMgr.runTowers,
    planDefense: wallMgr.planDefense,
    fleeIfNeeded: fleeMgr.fleeIfNeeded,
    activateSafeModeIfNeeded: threat.activateSafeModeIfNeeded,
    run,
    isFleeing: fleeMgr.isFleeing,
};

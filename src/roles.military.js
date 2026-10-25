/**
 * roles.military —— 军事与扩张角色的注册表 / 门面
 *
 * 原 554 行巨石已按职责拆分为：
 *   role.soldier.js  士兵（正面作战 / 清场 / 护航 escort）
 *   role.patrol.js   边防巡逻兵 patroller + 路线规划 patrolRoute + keyNodes / firstBlocker 原语
 *   role.scout.js    侦查兵 scout + pickScoutTarget（情报新鲜度）
 *   role.recon.js    侦察兵 recon + pickReconTarget（危险 / 有主房间，短期侦察）
 *   role.pioneer.js  开拓者 pioneer（新占房间建 spawn / 升控制器）
 *
 * 本文件只做两件事：把各模块的行为拼成 BEHAVIORS，把对外原语原样转发。
 * 不该放进来：任何角色策略逻辑。改行为请去对应 role.*.js。
 *
 * 对外导出键名与拆分前完全一致，调用方（roles.js / quota.js 等）无需改动。
 */
const soldierMod = require('role.soldier');
const patrolMod = require('role.patrol');
const scoutMod = require('role.scout');
const reconMod = require('role.recon');
const pioneerMod = require('role.pioneer');

module.exports = {
    BEHAVIORS: {
        soldier: soldierMod.soldier,
        escort: soldierMod.escort,
        recon: reconMod.recon,
        patroller: patrolMod.patroller,
        scout: scoutMod.scout,
        pioneer: pioneerMod.pioneer,
    },
    keyNodes: patrolMod.keyNodes,
    firstBlocker: patrolMod.firstBlocker,
    patrolRoute: patrolMod.patrolRoute,
    pickScoutTarget: scoutMod.pickScoutTarget,
    pickReconTarget: reconMod.pickReconTarget,
};

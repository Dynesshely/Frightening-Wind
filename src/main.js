/**
 * Frightening-Wind AI 主入口
 */
const config = require('config');
const economy = require('economy');
const roles = require('roles');
const status = require('status');
const defense = require('defense');

module.exports.loop = function () {
    try {
        // 代码热更新检测（全局对象在每次代码上传后重置）
        if (!global.__fw || global.__fw.version !== config.version) {
            global.__fw = { version: config.version, startedAt: Game.time };
            // ★ 部署后保护期 ★
            // 每次上传代码 global 都会重置，而 Memory 是持久的：
            //   - spawnReserve / spawnWait 这类"正在攒钱"的临时状态会失效
            //   - creep.memory.roleSince 还是旧值，mgr.roster 会按新配额立刻重排角色
            // 结果就是每部署一次，人口和体型就抖一次（线上实测：13 人全员退化成 1W1C1M，
            // progress 停摆十几分钟）。所以给一个冷静期：这段时间内只维持现状，不重排角色。
            Memory.fw = Memory.fw || {};
            Memory.fw.bootAt = Game.time;
            // 清掉可能残留的攒钱状态，让 spawn 重新决策
            if (Memory.fw.spawnReserve) Memory.fw.spawnReserve = {};
            if (Memory.fw.spawnWait) Memory.fw.spawnWait = {};
            console.log('[FW] ' + config.name + ' v' + config.version + ' 已加载 | tick ' + Game.time
                + ' | 进入 ' + (config.bootGraceTicks || 300) + ' tick 冷静期');
        }

        economy.housekeeping();

        const rooms = economy.ownedRooms();
        for (let i = 0; i < rooms.length; i++) {
            try {
                economy.runRoom(rooms[i]);
            } catch (e) {
                console.log('[FW] 房间 ' + rooms[i].name + ' 调度异常: ' + e.stack);
                status.recordError('room:' + rooms[i].name, e);
            }
        }

        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            try {
                // 逃跑中的 creep 不再执行经济行为，免得把逃跑方向覆盖掉
                if (defense.isFleeing(creep)) continue;
                roles.run(creep);
            } catch (e) {
                console.log('[FW] creep ' + name + ' 行为异常: ' + e.stack);
                status.recordError('creep:' + name, e);
            }
        }

        status.report();
        if (Game.time % 5 === 0) status.snapshot(rooms);
    } catch (e) {
        console.log('[FW] 主循环异常: ' + e.stack);
        try { status.recordError('main', e); } catch (err) { }
    }
};

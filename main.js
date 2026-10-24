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
            console.log('[FW] ' + config.name + ' v' + config.version + ' 已加载 | tick ' + Game.time);
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

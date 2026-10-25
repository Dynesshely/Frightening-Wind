/**
 * fw.geo —— 地形与可达性（纯几何计算）。
 *
 * 负责：
 *   - accessCount：把候选位置当成障碍后，从中心点做 BFS，数还能摸到几个"环边出口"；
 *   - wouldBlockAccess：基于上面同一个判定，回答"在这里放东西会不会封路"。
 *   规划期选址（construction）与运行期巡检共用这一份判定，避免两套逻辑漂移。
 *
 * 以后凡是"房间名 ↔ 全局坐标互转"（房间名解析、getRoomLinearCoordinates 之类）
 * 也属于本模块 —— 只要是坐标系 / 地形层面的纯计算就放这里。
 *
 * 不该放进来：
 *   - 房间快照缓存（fw.room）；
 *   - 寻路与实际位移、卡住/振荡处理（fw.nav，全库唯一移动入口）；
 *   - 建造/维修决策（construction / fw.build）。
 *   本模块不读 Memory、不调用任何游戏写接口，也没有 require 依赖。
 */

/**
 * 连通性校验（地形感知）：把候选位置当成障碍后，看 spawn 还能摸到几个出口。
 * 规划期（选址）和运行期（巡检）共用同一套判定，避免两套逻辑漂移。
 */
function accessCount(room, occ, extraBlocked, center) {
    const R = 5;
    const terrain = room.getTerrain();
    const key = (x, y) => x + ',' + y;
    const blocked = {};
    for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            const x = center.x + dx;
            const y = center.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) { blocked[key(x, y)] = true; continue; }
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) blocked[key(x, y)] = true;
            else if (occ && occ[key(x, y)]) blocked[key(x, y)] = true;
        }
    }
    if (extraBlocked) blocked[key(extraBlocked.x, extraBlocked.y)] = true;
    blocked[key(center.x, center.y)] = false;
    const seen = {};
    seen[key(center.x, center.y)] = true;
    const queue = [[center.x, center.y]];
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    let border = 0;
    while (queue.length) {
        const cur = queue.shift();
        if (Math.abs(cur[0] - center.x) === R || Math.abs(cur[1] - center.y) === R) border++;
        for (let i = 0; i < 4; i++) {
            const nx = cur[0] + dirs[i][0];
            const ny = cur[1] + dirs[i][1];
            const k = key(nx, ny);
            if (seen[k] || blocked[k]) continue;
            if (nx < 1 || nx > 48 || ny < 1 || ny > 48) continue;
            seen[k] = true;
            queue.push([nx, ny]);
        }
    }
    return border;
}

/** 放这个位置会不会封路（出口少于 6 个） */
function wouldBlockAccess(room, occ, spot, center) {
    return accessCount(room, occ, spot, center) < 6;
}

module.exports = { accessCount, wouldBlockAccess };

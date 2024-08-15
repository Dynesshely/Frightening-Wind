module.exports.findMostClose = function (targets, creep) {
    var distances = _.map(targets, (target) => creep.pos.getRangeTo(target));
    var min = Math.min(...distances);
    var index = distances.indexOf(min);
    var target = targets[index];
    return target;
};

module.exports.getSourceWorkersLimitation = function (source) {
    var center = source.pos;

    var terrain = source.room.getTerrain();

    var top = terrain.get(center.x, center.y - 1);
    var right = terrain.get(center.x + 1, center.y);
    var bottom = terrain.get(center.x, center.y + 1);
    var left = terrain.get(center.x - 1, center.y);
    var leftTop = terrain.get(center.x - 1, center.y - 1);
    var rightTop = terrain.get(center.x + 1, center.y - 1);
    var rightBottom = terrain.get(center.x + 1, center.y + 1);
    var leftBottom = terrain.get(center.x - 1, center.y + 1);

    var round = [
        top,
        right,
        bottom,
        left,
        leftTop,
        rightTop,
        rightBottom,
        leftBottom,
    ];

    var count = 0;

    for (var i = 0; i < round.length; i++) {
        switch (round[i]) {
            case TERRAIN_MASK_WALL:
                count++;
                break;
            case TERRAIN_MASK_SWAMP:
                count++;
                break;
        }
    }

    return 8 - count;
};

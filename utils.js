module.exports.findMostClose = function (targets, creep) {
    var distances = _.map(targets, (target) => creep.pos.getRangeTo(target));
    var min = Math.min(...distances);
    var index = distances.indexOf(min);
    var target = targets[index];
    return target;
};

module.exports.getHarvestableLimitation = function (harvestable) {
    var center = harvestable.pos;

    var terrain = harvestable.room.getTerrain();

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

module.exports.initializeCreepsLimit = function (harvestables, harvestableCreeps, harvestableCreepsLimit, config, type) {
    for (let harvestable of harvestables) {
        harvestableCreeps[harvestable.id] = [];
        harvestableCreepsLimit[harvestable.id] = this.getHarvestableLimitation(harvestable);
    }

    var maxWorkersCount = 0;

    for (let count of Object.values(harvestableCreepsLimit)) {
        maxWorkersCount += count;
    }

    config.basicRoomCreepsCount[type] = maxWorkersCount;
};

module.exports.queryCreeps = function (creeps, type) {
    var filtered = _.filter(
        creeps,
        (creep) => {
            if (creep.memory == undefined) return false;

            return creep.memory.role == type;
        }
    );
    return filtered;
};

module.exports.queryUsableHarvestable = function (name, harvestableCreeps, harvestableCreepsLimit) {
    var minCount = 10000000;
    var minHarvestable = '';

    for (let id of Object.keys(harvestableCreeps)) {
        var creeps = harvestableCreeps[id];

        if (creeps.indexOf(name) != -1) {
            if (Game.creeps[name] == undefined) {
                delete creeps[creeps.indexOf(name)];
            } else {
                return Game.getObjectById(id);
            }
        }

        if (creeps.length >= harvestableCreepsLimit[id]) {
            continue;
        }

        if (creeps.length < minCount) {
            minCount = creeps.length;
            minHarvestable = id;
        }
    }

    if (minHarvestable == '') {
        return null;
    }

    harvestableCreeps[minHarvestable].push(name);

    return Game.getObjectById(minHarvestable);
};

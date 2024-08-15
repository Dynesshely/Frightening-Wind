const configuration = require('configuration');
const logger = require('logger');
const utils = require('utils');

const config = new configuration.Config();

module.exports.Logistics = class {
    constructor(controller, getSpawns, getCreeps, getSources, getFlags, getTombstones, getStructures, getExtensions) {
        this.controller = controller;
        this.getSpawns = getSpawns;
        this.getCreeps = getCreeps;
        this.getSources = getSources;
        this.getFlags = getFlags;
        this.getTombstones = getTombstones;
        this.getStructures = getStructures;
        this.getExtensions = getExtensions;

        this.sourcesWorkers = {};
        this.sourcesWorkersLimitation = {};
        this.config = {
            basicRoomCreepsCount: config.basicRoomCreepsCount,
        };

        this.initialize();
    }

    initialize() {
        logger.log('        - Init new logistics manager:');

        var sources = this.getSources();

        for (let source of this.getSources()) {
            this.sourcesWorkers[source.id] = [];
            this.sourcesWorkersLimitation[source.id] = utils.getSourceWorkersLimitation(source);
        }

        var maxWorkersCount = 0;

        for (let count of Object.values(this.sourcesWorkersLimitation)) {
            maxWorkersCount += count;
        }

        this.config.basicRoomCreepsCount['worker'] = maxWorkersCount;

        logger.log('        -     Each source workers limitation details:');
        logger.log('        -         ' + JSON.stringify(this.sourcesWorkersLimitation));
    }

    queryCreeps(creeps, type) {
        var filtered = _.filter(creeps, (creep) => creep.memory.role == type);
        return filtered;
    }

    prepairCreeps() {
        var spawns = this.getSpawns();
        var creeps = this.getCreeps();

        var base = this.config.basicRoomCreepsCount;

        for (let key of Object.keys(base)) {
            if (this.controller.level < config.creepsMinRcl[key]) continue;

            var value = base[key];
            var count = this.queryCreeps(creeps, key).length;
            logger.log('            - Owning `' + key + '` creeps: ' + count + ' / ' + value);
            if (count < value) {
                logger.log('            - Generating creep `' + key + '`');

                this.generateCreep(spawns, key);
                return;
            }
        }
    }

    generateCreep(spawns, type) {
        var name = '<spawn>-<time>'.replace('<time>', Game.time);

        for (let spawn of spawns) {
            if (spawn.spawning) continue;

            name = name.replace('<spawn>', spawn.id);

            var body = this.controller.level > 4 ? config.enhancedRoomCreepsBody[type] : config.basicRoomCreepsBody[type];
            var result = spawn.spawnCreep(body, name);

            switch (result) {
                case OK:
                    logger.log('            -     Creep `' + name + '` generated with ' + body);

                    var creep = Game.creeps[name];

                    creep.memory.role = type;
                    creep.memory.spawn = spawn.id;
                    creep.memory.task = 'normal';
                    break;
                case ERR_BUSY:
                    break;
                case ERR_NOT_ENOUGH_ENERGY:
                    logger.log('            -     Energy not enough to generate');
                    break;
                case ERR_NAME_EXISTS:
                    logger.log('            -     Name already exists: ' + name);
                    break;
                default:
                    logger.log('            -     Generating failed with: ' + result);
                    break;
            }

            return;
        }
    }

    querySource(name) {
        var minCount = 10000;
        var minSource = '';

        for (let id of Object.keys(this.sourcesWorkers)) {
            var workers = this.sourcesWorkers[id];

            if (workers.indexOf(name) != -1) {
                return Game.getObjectById(id);
            }

            if (workers.length >= this.sourcesWorkersLimitation[id]) {
                continue;
            }

            if (workers.length < minCount) {
                minCount = workers.length;
                minSource = id;
            }
        }

        if (minSource == '') {
            return null;
        }

        logger.log('            - Assigning creep `' + name + '` to source `' + minSource + '`');

        this.sourcesWorkers[minSource].push(name);

        return Game.getObjectById(minSource);
    }

    harvestSource() {
        var creeps = this.getCreeps();
        var workers = _.filter(creeps, (creep) => creep.memory.role == 'worker');

        for (let worker of workers) {
            if (worker.memory.task == undefined) {
                worker.memory.task = 'normal';
            }

            switch (worker.memory.task) {
                case 'normal':
                    if (worker.store.getFreeCapacity() > 0) {
                        worker.say('🔄');

                        var source = this.querySource(worker.name);
                        var result = worker.harvest(source);

                        switch (result) {
                            case OK:
                                break;
                            case ERR_NOT_IN_RANGE:
                                worker.moveTo(source);
                                break;
                        }
                    } else {
                        worker.say('🏠');

                        var extensions = _.filter(this.getExtensions(), (ext) => ext.store.getFreeCapacity(RESOURCE_ENERGY) > 0 || ext.store == undefined);
                        var spawn = Game.getObjectById(worker.memory.spawn);
                        var target = utils.findMostClose([spawn].concat(extensions), worker);

                        if (target == undefined) target = spawn;

                        var result = worker.transfer(target, RESOURCE_ENERGY);

                        switch (result) {
                            case OK:
                                break;
                            case ERR_NOT_IN_RANGE:
                                worker.moveTo(target);
                                break;
                            case ERR_FULL:
                                if (extensions.length == 0)
                                    worker.memory.task = 'upgrade';
                                break;
                            default:
                                logger.log('            - Unknown error: ' + result + ' & target detail: ' + JSON.stringify(target));
                                break;
                        }
                    }
                    break;
                case 'upgrade':
                    worker.say('⚡');

                    var result = worker.upgradeController(this.controller);

                    switch (result) {
                        case OK:
                            break;
                        case ERR_NOT_IN_RANGE:
                            worker.moveTo(this.controller);
                            break;
                        case ERR_NOT_ENOUGH_RESOURCES:
                            worker.memory.task = 'normal';
                            break;
                    }
                    break;
            }
        }
    }

    buildStructures() {
        this.autoBuild();
    }

    autoBuild() {
        var creeps = this.getCreeps();
        var builders = this.queryCreeps(creeps, 'builder');

        for (let builder of builders) {
            if (builder.store.getUsedCapacity() == 0) {
                builder.say('🖐');

                builder.memory.task = 'fetching';

                var tombstones = this.getTombstones();

                if (tombstones.length > 0) {
                    var tombstone = tombstones[0];
                    var result = builder.withdraw(tombstone, RESOURCE_ENERGY);

                    switch (result) {
                        case OK:
                            break;
                        case ERR_NOT_IN_RANGE:
                            builder.moveTo(tombstone);
                            break;
                    }
                } else {
                    var extensions = _.filter(this.getExtensions(), (ext) => ext.store.getUsedCapacity() > 0);
                    var spawn = Game.getObjectById(builder.memory.spawn);
                    var target = utils.findMostClose([spawn].concat(extensions), builder);
                    var result = builder.withdraw(target, RESOURCE_ENERGY);

                    switch (result) {
                        case OK:
                            break;
                        case ERR_NOT_IN_RANGE:
                            builder.moveTo(target);
                            break;
                    }
                }
            } else {
                var sites = this.controller.room.find(FIND_CONSTRUCTION_SITES);
                if (sites.length > 0) {
                    var site = utils.findMostClose(sites, builder);

                    var extensions = _.filter(sites, (site) => site.structureType == STRUCTURE_EXTENSION);

                    if (extensions.length > 0) {
                        var min = 1000000000;
                        for (let extension of extensions) {
                            var leftProgress = extension.progressTotal - extension.progress;
                            if (leftProgress < min) {
                                min = leftProgress;
                                site = extension;
                            }
                        }
                    }

                    builder.say('🔨');

                    logger.log('            - Building structure `' + site.structureType + '` ' + site.pos);

                    builder.memory.task = 'building';

                    var result = builder.build(site);

                    switch (result) {
                        case OK:
                            break;
                        case ERR_NOT_IN_RANGE:
                            builder.moveTo(site);
                            break;
                    }
                } else {
                    builder.say('🔧');

                    var structures = this.controller.room.find(FIND_STRUCTURES);
                    var walls = _.filter(
                        structures,
                        (structure) => structure.structureType == STRUCTURE_WALL && structure.hits < config.minWallHits
                    );

                    var targets = walls;

                    // if (targets.length == 0) {
                    //     var ramparts = _.filter(
                    //         this.getStructures(),
                    //         (structure) => structure.structureType == STRUCTURE_RAMPART && structure.hits < config.minRampartHits
                    //     );
                    //     targets = ramparts;
                    // }

                    // // Below leads to repairing same wall

                    // if (targets.length == 0) {
                    //     targets = _.filter(structures,
                    //         (structure) => structure.structureType == STRUCTURE_WALL
                    //     );
                    // }

                    if (targets.length == 0) {
                        var towers = _.filter(
                            this.getStructures(),
                            (structure) => structure.structureType == STRUCTURE_TOWER
                        );
                        targets = _.filter(towers, (tower) => tower.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                    }

                    var target = utils.findMostClose(targets, builder);

                    if (target == undefined) {
                        var bornFlag = _.filter(this.getFlags(), (flag) => flag.name == 'Born')[0];
                        var result = builder.moveTo(bornFlag);

                        builder.memory.task = 'pending';
                    } else {

                        builder.memory.task = 'repairing';

                        var result = 0;
                        if (target.structureType && target.structureType == STRUCTURE_TOWER) {
                            var result = builder.transfer(target, RESOURCE_ENERGY);
                        } else {
                            var result = builder.repair(target);
                        }

                        logger.log('            - Repairing structure ' + result);

                        switch (result) {
                            case OK:
                                break;
                            case ERR_NOT_IN_RANGE:
                                builder.moveTo(target);
                                break;
                            default:
                                logger.log('            -     Failed ' + result);
                                logger.log('            -     Target detail ' + JSON.stringify(target));
                                break;
                        }
                    }
                }
            }
        }
    }

    gotoBorn() {
        var creeps = this.getCreeps();
        var flags = this.getFlags();

        var assigned = ['worker', 'builder'];

        var notWorkers = _.filter(creeps, (creep) => assigned.indexOf(creep.memory.role) == -1);
        var bornFlag = _.filter(flags, (flag) => flag.name == 'Born')[0];

        for (let creep of notWorkers) {
            var result = creep.moveTo(bornFlag);
        }
    }

    cleanCreepsMemory() {
        var toRemove = [];
        for (let creepName of Object.keys(Memory.creeps)) {
            if (Object.keys(Game.creeps).indexOf(creepName) == -1) {
                toRemove.push(creepName);
            }
        }
        for (let name of toRemove) {
            delete Memory.creeps[name];

            logger.log('            - Cleaned non-exist memory `' + name + '`');
        }
    }

    renewCreeps() {
        var creeps = this.getCreeps();

        for (let creep of creeps) {
            if (creep.ticksToLive < config.minTtlToRecycle) {
                if (creep.memory.ttlTarget == undefined)
                    creep.memory.ttlTarget = config.minTtlToRenew;
            }

            if (creep.memory.ttlTarget != undefined && creep.ticksToLive < creep.memory.ttlTarget) {
                creep.say('😰');
                logger.log('            - Renew creep `' + creep.name + '`');

                var spawn = Game.getObjectById(creep.memory.spawn);
                var result = spawn.renewCreep(creep);

                switch (result) {
                    case OK:
                        break;
                    case ERR_NOT_IN_RANGE:
                        creep.moveTo(spawn);
                        break;
                }
            } else {
                creep.memory.ttlTarget = undefined;
            }
        }
    }
};


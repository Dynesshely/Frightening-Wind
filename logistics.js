const configuration = require('configuration');
const logger = require('logger');
const utils = require('utils');

const config = new configuration.Config();

module.exports.Logistics = class {
    constructor(
        controller,
        getSpawns,
        getCreeps,
        getSources,
        getMinerals,
        getFlags,
        getTombstones,
        getStructures,
        getExtensions
    ) {
        this.controller = controller;
        this.getSpawns = getSpawns;
        this.getCreeps = getCreeps;
        this.getSources = getSources;
        this.getMinerals = getMinerals;
        this.getFlags = getFlags;
        this.getTombstones = getTombstones;
        this.getStructures = getStructures;
        this.getExtensions = getExtensions;

        this.sourcesWorkers = {};
        this.sourcesWorkersLimit = {};
        this.mineralsMiners = {};
        this.mineralsMinersLimit = {};

        this.initialize();
    }

    initialize() {
        logger.log('        - Init new logistics manager:');

        utils.initializeCreepsLimit(
            this.getSources(),
            this.sourcesWorkers,
            this.sourcesWorkersLimit,
            config,
            'worker'
        );

        utils.initializeCreepsLimit(
            this.getMinerals(),
            this.mineralsMiners,
            this.mineralsMinersLimit,
            config,
            'miner'
        );

        logger.log('        -     Each source workers limitation details:');
        logger.log('        -         ' + JSON.stringify(this.sourcesWorkersLimit));
        logger.log('        -     Each mineral miners limitation details:');
        logger.log('        -         ' + JSON.stringify(this.mineralsMinersLimit));
    }

    prepairCreeps() {
        var spawns = this.getSpawns();
        var creeps = this.getCreeps();

        var base = config.basicRoomCreepsCount;

        logger.log('            - You can generate `' + config.generableCreeps + '`');

        for (let key of Object.keys(base)) {
            if (this.controller.level < config.creepsMinRcl[key]) continue;
            if (config.generableCreeps.indexOf(key) == -1) continue;

            var value = base[key];
            var count = utils.queryCreeps(creeps, key).length;
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

    harvestSource() {
        var workers = utils.queryCreeps(this.getCreeps(), 'worker');

        for (let worker of workers) {
            if (worker.memory.task == undefined) {
                worker.memory.task = 'normal';
            }

            switch (worker.memory.task) {
                case 'normal':
                    if (worker.store.getFreeCapacity() > 0) {
                        worker.say('🔄');

                        var source = utils.queryUsableHarvestable(
                            worker.name,
                            this.sourcesWorkers,
                            this.sourcesWorkersLimit
                        );
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
                        var spawns = _.filter(this.getSpawns(), (spawn) => spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                        var spawn = worker.pos.findClosestByPath(FIND_MY_SPAWNS);
                        if (spawn == null) spawn = Game.getObjectById(worker.memory.spawn);
                        var targets = spawns.concat(extensions);
                        var target = utils.findMostClose(targets, worker);

                        if (target == undefined) target = spawn;

                        var result = worker.transfer(target, RESOURCE_ENERGY);

                        switch (result) {
                            case OK:
                                break;
                            case ERR_NOT_IN_RANGE:
                                worker.moveTo(target);
                                break;
                            case ERR_FULL:
                                if (targets.length == 0)
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

    mine() {
        var miners = utils.queryCreeps(this.getCreeps(), 'miner');

        for (let miner of miners) {
            if (miner.memory.task == undefined) {
                miner.memory.task = 'normal';
            }

            switch (miner.memory.task) {
                case 'normal':
                    if (miner.store.getFreeCapacity() > 0) {
                        miner.say('⛏');

                        var mine = utils.queryUsableHarvestable(
                            miner.name,
                            this.mineralsMiners,
                            this.mineralsMinersLimit
                        );
                        var result = miner.harvest(mine);

                        switch (result) {
                            case OK:
                                break;
                            case ERR_NOT_IN_RANGE:
                                miner.moveTo(mine);
                                break;
                        }
                    } else {
                        miner.say('📦');

                        var store = miner.store;
                        var resourceTypes = Object.keys(store);
                        var resourceType = resourceTypes[0];

                        var storages = _.filter(
                            this.getStructures(),
                            (structure) => {
                                var con1 = structure.structureType == STRUCTURE_STORAGE;
                                if (con1 == false) return false;

                                var con2 = false;
                                for (let r of resourceTypes) {
                                    var con = structure.store.getFreeCapacity(r) > 0;
                                    con2 = con2 || con;
                                    if (con) resourceType = r;
                                }
                                return con1 && con2;
                            }
                        );
                        var target = utils.findMostClose(storages, miner);

                        if (target == undefined) return;

                        var result = miner.transfer(target, resourceType);

                        switch (result) {
                            case OK:
                                break;
                            case ERR_NOT_IN_RANGE:
                                miner.moveTo(target);
                                break;
                            case ERR_FULL:
                                break;
                            default:
                                logger.log('            - Unknown error: ' + result + ' & target detail: ' + JSON.stringify(target));
                                break;
                        }
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
        var builders = utils.queryCreeps(creeps, 'builder');

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

        var notWorkers = _.filter(creeps, (creep) => config.generableCreeps.indexOf(creep.memory.role) == -1);
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

    recycleCreeps() {
        var dyingOccupiers = _.filter(
            this.getCreeps(),
            (creep) => creep.memory.role == 'occupier' && creep.ticksToLive < config.minTtlToRecycle
        );

        for (let creep of dyingOccupiers) {
            creep.say('😵');
            logger.log('            - Recycle creep `' + creep.name + '` (' + creep.ticksToLive + ') ' + creep.pos);

            var spawn = Game.getObjectById(creep.memory.spawn);
            var result = spawn.recycleCreep(creep);

            switch (result) {
                case OK:
                    break;
                case ERR_NOT_IN_RANGE:
                    creep.moveTo(spawn);
                    break;
                default:
                    logger.log('            -     Unknown error: ' + result);
                    break;
            }
        }
    }

    renewCreeps() {
        var creeps = this.getCreeps();

        creeps = _.filter(creeps, (creep) => creep.memory.role != 'occupier');

        for (let creep of creeps) {
            if (creep.ticksToLive < config.minTtlToRecycle) {
                if (creep.memory.ttlTarget == undefined)
                    creep.memory.ttlTarget = config.minTtlToRenew;
            }

            if (creep.memory.ttlTarget != undefined && creep.ticksToLive < creep.memory.ttlTarget) {
                creep.say('😰');
                logger.log('            - Renew creep `' + creep.name + '` (' + creep.ticksToLive + '/' + creep.memory.ttlTarget + ') ' + creep.pos);

                var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
                if (spawn == null) spawn = Game.getObjectById(creep.memory.spawn);
                var result = spawn.renewCreep(creep);

                switch (result) {
                    case OK:
                        break;
                    case ERR_NOT_IN_RANGE:
                        creep.moveTo(spawn);
                        break;
                    case ERR_INVALID_TARGET:
                        logger.log('            -     This creep may carried `CLAIM` body or target isn\'t creep');
                        break;
                    default:
                        logger.log('            -     Unknown error: ' + result);
                        break;
                }
            } else {
                creep.memory.ttlTarget = undefined;
            }
        }
    }
};


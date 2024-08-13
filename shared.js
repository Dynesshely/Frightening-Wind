const logistics = require('logistics');
const logger = require('logger');

module.exports.Room = class {
    constructor(name) {
        this.name = name;

        this.initialize();
    }

    initialize() {
        this.room = Game.rooms[this.name];
        this.controller = this.room.controller;

        this.sources = this.room.find(FIND_SOURCES);
        this.minerals = this.room.find(FIND_MINERALS);
        this.exits = this.room.find(FIND_EXIT);

        this.update();

        this.logistics = new logistics.Logistics(
            this.controller,
            () => this.spawns,
            () => this.creeps,
            () => this.sources,
            () => this.flags,
        );

        logger.log('    - Inited new room with `name`: ' + this.name);
    }

    update() {
        this.creeps = this.room.find(FIND_CREEPS);
        this.flags = this.room.find(FIND_FLAGS);
        this.spawns = this.room.find(FIND_MY_SPAWNS);
        this.tombstones = this.room.find(FIND_TOMBSTONES);
    }

    dispatch() {
        this.update();


        logger.log('        - Prepair creeps');

        this.logistics.prepairCreeps();


        logger.log('        - Harvest sources');

        this.logistics.harvestSource();


        logger.log('        - Build structures');

        this.logistics.buildStructures();


        logger.log('        - Goto born flag');

        this.logistics.gotoBorn();


        logger.log('        - Clean creeps memory');

        this.logistics.cleanCreepsMemory();
    }
};


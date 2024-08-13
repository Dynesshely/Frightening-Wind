const logistics = require('logistics');

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
        
        this.logistics = new logistics.Logistics(
            this.controller,
            () => this.spawns,
            () => this.creeps,
            () => this.sources,
            () => this.flags,
        );
    }
    
    update() {
        this.creeps = this.room.find(FIND_CREEPS);
        this.flags = this.room.find(FIND_FLAGS);
        this.spawns = this.room.find(FIND_MY_SPAWNS);
        this.tombstones = this.room.find(FIND_TOMBSTONES);
    }
    
    dispatch() {
        this.update();
        
        this.logistics.prepairCreeps();
        
        this.logistics.harvestSource();
        
        this.logistics.gotoBorn();
    }
};


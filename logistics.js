const configuration = require('configuration');

const config = new configuration.Config();

const dateTime = new Date();

module.exports.Logistics = class {
    constructor(getSpawns, getCreeps, getSources) {
        this.getSpawns = getSpawns;
        this.getCreeps = getCreeps;
        this.getSources = getSources;
        
        this.sourcesWorkers = {};
        
        this.initialize();
    }
    
    initialize() {
        var sources = this.getSources();
        
        for (let source of this.getSources()) {
           this.sourcesWorkers[source.id] = [];
        }
    }
    
    queryCreeps(creeps, type) {
        var filtered = _.filter(creeps, (creep) => creep.memory.role == type);
        return filtered;
    }
    
    prepairCreeps() {
        var spawns = this.getSpawns();
        var creeps = this.getCreeps();
        
        var base = config.basicRoomCreepsCount;
        
        for (let key of Object.keys(base)) {
            var value = base[key];
            if (this.queryCreeps(creeps, key).length < value) {
                this.generateCreep(spawns, key);
                return;
            }
        }
    }
    
    generateCreep(spawns, type) {
        var name = 'creep-<type>-<time>'.replace('<type>', type).replace('<time>', dateTime.toISOString());
        
        for (let spawn of spawns) {
            if (spawn.spawning == null) {
                var body = config.basicRoomCreepsBody[type];
                var result = spawn.spawnCreep(body, name);
                
                switch (result) {
                    case OK:
                        var creep = Game.creeps[name];
                        
                        creep.memory.role = type;
                        creep.memory.spawn = spawn.id;
                        break;
                    case ERR_BUSY:
                        break;
                    case ERR_NOT_ENOUGH_ENERGY:
                        break;
                }
                
                return;
            }
        }
    }
    
    querySource(name) {
        var minCount = 10000;
        var minSource = '';
        
        console.log(JSON.stringify(this.sourcesWorkers));
        
        for (let id of Object.keys(this.sourcesWorkers)) {
            var workers = this.sourcesWorkers[id];
            
            if (workers.indexOf(name) != -1) {
                return Game.getObjectById(id);
            }
            
            if (workers.length < minCount) {
                minCount = workers.length;
                minSource = id;
            }
        }
        
        if (minSource == '') {
            return null;
        }
        
        this.sourcesWorkers[minSource].push(name);
        
        return Game.getObjectById(minSource);
    }
    
    harvestSource() {
        var creeps = this.getCreeps();
        var workers = _.filter(creeps, (creep) => creep.memory.role == 'worker');
        
        for (let worker of workers) {
            if (worker.store.getFreeCapacity() > 0) {
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
                var spawn = Game.getObjectById(worker.memory.spawn);
                var result = worker.transfer(spawn, RESOURCE_ENERGY);
                
                switch (result) {
                    case OK:
                        break;
                    case ERR_NOT_IN_RANGE:
                        worker.moveTo(spawn);
                        break;
                    default:
                        console.log('    Unknown error: ' + result);
                        break;
                }
            }
        }
    }
};


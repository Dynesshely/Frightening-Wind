module.exports.Config = class {
  constructor() {
    this.basicRoomCreepsCount = {
      'worker': 6,
      'builder': 6,
      'miner': 3,
      'soldier': 3,
      'shooter': 2,
      'doctor': 1,
    };

    this.basicRoomCreepsBody = {
      'worker': [MOVE, WORK, CARRY],
      'builder': [MOVE, WORK, CARRY],
      'miner': [MOVE, WORK, CARRY],
      'soldier': [MOVE, ATTACK],
      'shooter': [MOVE, RANGED_ATTACK],
      'doctor': [MOVE, HEAL],
    };

    // If RCL > 4
    this.enhancedRoomCreepsBody = {
      'worker': [MOVE, MOVE, MOVE, WORK, WORK, CARRY, CARRY],
      'builder': [MOVE, MOVE, WORK, WORK, WORK, CARRY, CARRY],
      'miner': [MOVE, MOVE, WORK, WORK, WORK, CARRY, CARRY, CARRY],
      'soldier': [MOVE, MOVE, ATTACK, ATTACK, ATTACK],
      'shooter': [MOVE, MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK],
      'doctor': [MOVE, MOVE, MOVE, HEAL, HEAL, HEAL],
    };

    this.creepsMinRcl = {
      'worker': 0,
      'builder': 0,
      'miner': 6,
      'soldier': 5,
      'shooter': 5,
      'doctor': 5,
    };

    this.minTtlToRecycle = 300;
    this.minTtlToRenew = 1000;
    this.minWallHits = 1000;
    this.minRampartsHits = 5000;
  }
};




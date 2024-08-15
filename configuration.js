module.exports.Config = class {
  constructor() {
    this.basicRoomCreepsCount = {
      'worker': 6,
      'builder': 6,
      'miner': 3,
      'soldier': 5,
      'shooter': 3,
      'doctor': 2,
    };

    this.basicRoomCreepsBody = {
      'worker': [MOVE, WORK, CARRY],
      'builder': [MOVE, WORK, CARRY],
      'miner': [MOVE, WORK, CARRY],
      'soldier': [MOVE, ATTACK],
      'shooter': [MOVE, ATTACK, RANGED_ATTACK],
      'doctor': [MOVE, HEAL],
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
  }
};




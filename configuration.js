module.exports.Config = class {
    constructor() {
        this.basicRoomCreepsCount = {
          'worker': 6,
          'builder': 3,
          'miner': 3,
          'soldier': 5,
          'shooter': 3,
          'doctor': 2,
        };
        
        this.basicRoomCreepsBody = {
          'worker':     [MOVE, WORK, CARRY],
          'builder':    [MOVE, WORK, CARRY],
          'miner':      [MOVE, WORK, CARRY],
          'soldier':    [MOVE, ATTACK],
          'shooter':    [MOVE, ATTACK, RANGED_ATTACK],
          'doctor':     [MOVE, HEAL],
        };
    }
};
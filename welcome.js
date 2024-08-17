const logger = require('logger');
const configuration = require('configuration');

const config = new configuration.Config();

function printWelcome() {
    logger.log('');
    logger.log('* Welcome to use FW AI System (Frightening Wind) !');
    logger.log('* Global Info: ');
    logger.log('    - Game detail:');
    logger.log('    -     Game time: ' + Game.time);
    logger.log('    -     GCL: ' + Game.gcl.level + ' (' + Game.gcl.progress + '/' + Game.gcl.progressTotal + ')');
    logger.log('    -     GPL: ' + Game.gpl.level + ' (' + Game.gpl.progress + '/' + Game.gpl.progressTotal + ')');
    logger.log('    - CPU Info:');
    logger.log('    -     Limit: ' + Game.cpu.limit);
    logger.log('    -     Bucket: ' + Game.cpu.bucket);
    logger.log('    - Your territory: ' + _.filter(Object.values(Game.rooms), (roome) => roome.controller && roome.controller.my).length);
    logger.log('    - Your creeps: ' + Object.keys(Game.creeps).length);
    logger.log('* This message will appear per ' + config.welcomeInterval + ' ticks, next is: ' + (Game.time + config.welcomeInterval));
}

module.exports.welcome = function (force = false) {
    if (force) {
        printWelcome();
        return;
    }

    if (Memory.nextWelcomeTick === undefined) {
        printWelcome();
        Memory.nextWelcomeTick = Game.time + config.welcomeInterval;
    } else {
        if (Game.time === Memory.nextWelcomeTick) {
            Memory.nextWelcomeTick = Game.time + config.welcomeInterval;
            printWelcome();
        }
    }
};



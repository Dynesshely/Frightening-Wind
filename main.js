const gamer = require('gamer');
const logger = require('logger');
const welcome = require('welcome');

logger.log('');
logger.log('+-------------------------+');
logger.log('| & Application Started ! |');
logger.log('+-------------------------+');
logger.log('');

const me = new gamer.Gamer();

if (Memory.nextWelcomeTick != undefined) {
    delete Memory.nextWelcomeTick;
}

module.exports.loop = function () {
    welcome.welcome();
    me.dispatch();
}



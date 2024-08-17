const gamer = require('gamer');
const logger = require('logger');

logger.log('');
logger.log('+-------------------------+');
logger.log('| & Application Started ! |');
logger.log('+-------------------------+');
logger.log('');

const me = new gamer.Gamer();

module.exports.loop = function () {
    me.dispatch();
}



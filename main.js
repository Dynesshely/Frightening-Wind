const dispatcher = require('dispatcher');
const logger = require('logger');

logger.log('');
logger.log('+-----------------------+');
logger.log('| Application Started ! |');
logger.log('+-----------------------+');

const mainDispatcher = new dispatcher.Dispatcher('W7N2');

function main() {
    mainDispatcher.dispatch();
}

module.exports.loop = function () {
    main();
}



const dispatcher = require('dispatcher');
const logistics = require('logistics');
const shared = require('shared');

const mainDispatcher = new dispatcher.Dispatcher('W7N2');

function main() {
    mainDispatcher.dispatch();
}

module.exports.loop = function() {
    main();
}
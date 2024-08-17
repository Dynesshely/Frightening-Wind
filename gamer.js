const dispatcher = require('dispatcher');

module.exports.Gamer = class {
    constructor() {
        this.dispatchers = [];
        this.initialize();
    }

    initialize() {
        var roomsNames = _.filter(
            Object.keys(Game.rooms),
            (name) => {
                var room = Game.rooms[name];
                return room.controller && room.controller.my;
            }
        );

        for (let name of roomsNames) {
            this.dispatchers.push(
                new dispatcher.Dispatcher(name)
            );
        }
    }

    dispatch() {
        for (let dispatcher of this.dispatchers) {
            dispatcher.dispatch();
        }
    }
};



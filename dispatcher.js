const logger = require('logger');
const shared = require('shared');

module.exports.Dispatcher = class {
    constructor(originRoomName) {
        logger.log('+ Inited new dispatcher with `originRoomName`: ' + originRoomName);

        this.originRoomName = originRoomName;
        this.originRoom = new shared.Room(originRoomName);
        this.myRooms = [
            this.originRoom,
        ];

        this.initialize();
    }

    initialize() {

    }

    dispatch() {
        logger.log('');
        logger.log('+ Dispatching rooms');

        for (let room of this.myRooms) {
            logger.log('    - Dispatching room with `name`: ' + room.name);

            room.dispatch();
        }
    }
};

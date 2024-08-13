const logger = require('logger');
const shared = require('shared');

module.exports.Dispatcher = class {
    constructor(originRoomName) {
        logger.logEvent('System', 'Dispatch', 'Inited new dispatcher with `originRoomName`: ' + originRoomName);
        
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
        for (let room of this.myRooms) {
           room.dispatch();
        }
    }
};

const logger = require('logger');

module.exports.Occupation = class {
    constructor(controller) {
        this.controller = controller;

        this.initialize();
    }

    initialize() {
        logger.log('        - Init new occupation manager:');

    }
};

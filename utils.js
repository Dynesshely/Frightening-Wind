module.exports.findMostClose = function (targets, creep) {
    var distances = _.map(targets, (target) => creep.pos.getRangeTo(target));
    var min = Math.min(...distances);
    var index = distances.indexOf(min);
    var target = targets[index];
    return target;
};

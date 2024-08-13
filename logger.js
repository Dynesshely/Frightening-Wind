const dateTime = new Date();

function getDateTime() {
    // var d = dateTime;
    // var result = d.getFullYear().toString() + "-" + ((d.getMonth() + 1).toString().length == 2 ? (d.getMonth() + 1).toString() : "0" + (d.getMonth() + 1).toString()) + "-" + (d.getDate().toString().length == 2 ? d.getDate().toString() : "0" + d.getDate().toString()) + " " + (d.getHours().toString().length == 2 ? d.getHours().toString() : "0" + d.getHours().toString()) + ":" + ((parseInt(d.getMinutes() / 5) * 5).toString().length == 2 ? (parseInt(d.getMinutes() / 5) * 5).toString() : "0" + (parseInt(d.getMinutes() / 5) * 5).toString()) + ":00";

    var result = dateTime.toDateString();

    return result;
}

module.exports.log = function (message) {
    console.log('[' + getDateTime() + '] ' + message);
};

module.exports.logEvent = function (name, level, message) {
    this.log('[' + name + '] [' + level + '] ' + message);
};

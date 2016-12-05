"use strict";

var winston = require('winston');

function pad(val) {
    val = '' + val;
    if (val.length == 0) {
        return '00';
    } else if (val.length == 1) {
        return '0' + val;
    } else {
        return val;
    }
}

module.exports = function (level) {
    return new (winston.Logger)({
        transports: [
            new (winston.transports.Console)({
                json: false,
                level: level,
                colorize: true,
                prettyPrint: true,
                timestamp: function () {
                    var dt = new Date();
                    return dt.getFullYear() + "-" + (pad(dt.getMonth() + 1)) + "-" + pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
                }
            })
        ],
        exceptionHandlers: [
            new (winston.transports.Console)({json: false, timestamp: true})
        ],
        exitOnError: false
    });
}

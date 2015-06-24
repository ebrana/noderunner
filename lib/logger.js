var winston = require('winston');

var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({
            json: false,
            timestamp: true,
            level:'silly',
            colorize: true,
            prettyPrint: true
            /*, timestamp: function() {
                return new Date().toUTCString();
            },formatter:function(options){
                return options.timestamp() +' '+ options.level.toUpperCase() +' '+ (undefined !== options.message ? options.message : '') + (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' );
            }*/
        })/*, new winston.transports.File({
            filename: __dirname + '/debug.log',
            json: false
        })*/
    ], 
    exceptionHandlers: [
        new (winston.transports.Console)({ json: false, timestamp: true })
        /*new winston.transports.File({ filename: __dirname + '/exceptions.log', json: false })*/
    ],
    exitOnError: false
});


module.exports = logger;
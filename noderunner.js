var MongoClient = require('mongodb').MongoClient,
    nconf       = require('nconf'),
    Immediate   = require('./lib/queue/immediate'),
    Planned     = require('./lib/queue/planned'),
    History     = require('./lib/queue/history'),
    Gui         = require('./lib/gui'),
    Watchdog    = require('./lib/watchdog');

// Config from ENV, CLI, default file and local file
nconf.argv().env().file('custom', {file: 'config/custom.json'}).file({file: 'config/defaults.json'}).defaults({'logLevel':'error'});

// Init logger
var logger = require('./lib/logger')(nconf.get('logLevel'));

var immediate, planned, history, watchdog, gui;

// Mongo connection check
(function tryMongoConnection() {
    MongoClient.connect(nconf.get('mongoDSN'), function(err, db){
        logger.info('Connected to mongo queuerunner DB');
        if (err) {
            logger.error('Mongo connection error, try in 10 secs. ', err);
            setTimeout(tryMongoConnection, 3000)
        } else {
            
            immediate = new Immediate(db, nconf, logger).run();
            planned   = new Planned(db, nconf, logger).run();
            history   = new History(db, nconf, logger).run();
            watchdog  = new Watchdog(db, nconf, logger).run(immediate);
            gui       = new Gui(db, nconf, logger, {
                            immediate: immediate,
                            planned:   planned,
                            history:   history
                        }).run();
        }
    });
}())

// Graceful restart handler
process.on( "SIGABRT", function() {
    var timeout = nconf.get('gracefulShutdownTimeout');
    logger.warn('SHUTDOWN: Graceful shutdown request detected. Stop queues and wait for '+timeout/1000+' seconds.');

    gui.stop();
    planned.stop();
    history.stop();
    watchdog.stop();
    immediate.stop(function(){
        logger.warn('SHUTDOWN: Last thread finished. Exitting now...');
        process.exit();
    });

    setTimeout(function() {
        logger.warn('SHUTDOWN: Graceful shutdown timeout exceeded. Exitting now...');
        process.exit();
    }, timeout);
});
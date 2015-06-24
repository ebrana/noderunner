var MongoClient = require('mongodb').MongoClient,
    nconf       = require('nconf'),
    Immediate   = require('./lib/queue/immediate'),
    Planned     = require('./lib/queue/planned')
    History     = require('./lib/queue/history')
    Watchdog    = require('./lib/watchdog');

// Config from ENV, CLI, default file and local file
nconf.argv().env().file('custom', {file: 'config/custom.json'}).file({file: 'config/defaults.json'}).defaults({'logLevel':'error'});

// Init logger
var logger = require('./lib/logger')(nconf.get('logLevel'));

// Kontrola pripojeni k mongu
(function tryMongoConnection() {
    MongoClient.connect(nconf.get('mongoDSN'), function(err, db){
        logger.info('Connected to mongo queuerunner DB');
        if (err) {
            logger.error('Mongo connection error, try in 10 secs. ', err);
            setTimeout(tryMongoConnection, 3000)
        } else {
            // Spustit jednotlive fronty
            new Immediate(db, nconf, logger).run();
            new Planned(db, nconf, logger).run();
            new History(db, nconf, logger).run();
            new Watchdog(db, nconf, logger).run();
        }
    });
}())

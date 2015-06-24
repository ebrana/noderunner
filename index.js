var MongoClient = require('mongodb').MongoClient,
    nconf       = require('nconf'),
    logger      = require('./lib/logger'),
    Immediate   = require("./lib/queue/immediate"),
    Planned     = require("./lib/queue/planned")
    History     = require("./lib/queue/history");

// Config from ENV, CLI, default file and local file
nconf.argv().env().file('custom', {file: 'config/custom.json'}).file({file: 'config/defaults.json'});

// Kontrola pripojeni k mongu
(function tryMongoConnection() {
    MongoClient.connect(nconf.get('mongoDSN'), function(err, db){
        if (err) {
            logger.error('Mongo connection error, try in 10 secs. ', err);
            setTimeout(tryMongoConnection, 3000)
        } else {
            // Spustit jednotlive fronty
            new Immediate(db, nconf, logger).run();
            new Planned(db, nconf, logger).run();
            new History(db, nconf, logger).run();
        }
    });
}())

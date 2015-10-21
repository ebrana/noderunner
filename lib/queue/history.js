var Job = require("../job.js");
var EventEmitter = require('events').EventEmitter;
var util = require('util');

exports = module.exports = History;

function History(db, nconf, logger) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.timeout = null
}

util.inherits(History, EventEmitter);

History.prototype.getJobs = function(callback) {
    var data = [];

    this.db.collection('history').find().each(function(err, doc) {
        if(doc == null) {
            callback(data);
            return;
        }
        data.push(doc);
    });
}

History.prototype.run = function () {
    var self = this;

    // nacist naplanovane ulohy a projit je po jedne
    self.db.collection('immediate').find({
        status: {$in:[this.nconf.get('statusAlias:success'),this.nconf.get('statusAlias:error')]},
        finished: {$lt:new Date().valueOf()/1000 - this.nconf.get('history:maxAge')/1000}
    }).toArray(function (err, docs) {
        if (docs.length > 0) {
            docs.forEach(function (doc) {
                var job = new Job(self.db, self.nconf, self.logger, self);
                job.initByDocument(doc);
                job.moveToHistory();
                self.logger.info('HISTORY: moving job ' + job.toString());
            })
        } else {
            self.logger.verbose('HISTORY: nothing to move, sleep for '+self.nconf.get('history:interval')/1000+' secs');
        }

        // spoustet v smycce konfigurovatelne delky
        self.timeout = setTimeout(function () {
            self.run()
        }, self.nconf.get('history:interval'));
    })
    return this;
}

History.prototype.stop = function () {
    this.logger.info('HISTORY: stopped')
    clearTimeout(this.timeout);
}


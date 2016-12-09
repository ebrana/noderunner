var Job = require("../job.js");
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var ObjectID = require('mongodb').ObjectID;

exports = module.exports = History;

function History(db, nconf, logger) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.timeout = null
}

util.inherits(History, EventEmitter);

// TODO zobecnit pro vsechny fronty
History.prototype.getJobs = function(callback, filter) {
    var data = [];

    if (typeof filter.host != 'undefined') {
        filter.host = new RegExp(filter.host);
    }

    if (typeof filter.job != 'undefined') {
        filter.job = new RegExp(filter.job);
    }

    if (typeof filter.output != 'undefined') {
        filter.output = new RegExp(filter.output);
    }

    this.logger.info('HISTORY: filtering GUI ', filter);

    this.db.collection('history').find(filter, {"limit":"100", "sort": [['finished','desc']]}).each(function(err, doc) {
        if(doc == null) {
            callback(data);
            return;
        }
        data.push(doc);
    });
}

History.prototype.rerunJob = function(id, queue) {
  var self = this;
    this.db.collection(queue).findOne({_id: new ObjectID(id)}, function(err, doc) {
        if(doc != null) {
            var job = new Job(self);
            job.initByDocument(doc);
            job.rerun();
        }
    });
}

History.prototype.getJobsCount = function(callback) {
    this.db.collection('history').count(function(err, count) {
        callback(count);
    });
}

History.prototype.run = function () {
    var self = this;

    // load done immediate jobs and move them to history one by one
    self.db.collection('immediate').find({
        status: {$in:[this.nconf.get('statusAlias:success'),this.nconf.get('statusAlias:error')]},
        finished: {$lt:new Date().valueOf()/1000 - this.nconf.get('history:maxAge')/1000}
    }).toArray(function (err, docs) {

        if (typeof docs !== 'undefined' && docs && docs.length > 0) {
            self.logger.info('HISTORY: moving '+docs.length+' old jobs from immediate queue to history');
            docs.forEach(function (doc) {
                var job = new Job(self);
                job.initByDocument(doc);
                job.moveToHistory();
                self.logger.debug('HISTORY: moving job ' + job.document._id);
            })
        } else {
            self.logger.verbose('HISTORY: nothing to move, sleep for '+self.nconf.get('history:interval')/1000+' secs');
        }

        // delete history items older than cleanHours
        self.clean(self.nconf.get('history:cleanHours'));

        // run again after specified interval
        self.timeout = setTimeout(function () {
            self.run()
        }, self.nconf.get('history:interval'));
    })
    return this;
}

History.prototype.clean = function (hoursCount) {
    var self = this;
    var lowerThanTime = Math.floor(new Date().getTime() / 1000) - hoursCount * 60 * 60;
    self.db.collection('history').deleteMany({finished:{$lt: lowerThanTime}}, function(err, result){
        if (err) {
            self.logger.error('HISTORY: clean finished<'+lowerThanTime+' failed', err);
        } else {
            self.logger.info('HISTORY: clean finished<'+lowerThanTime+' ('+self.nconf.get('history:cleanHours')+' hours) success - ' + result.deletedCount + ' deleted');
            self.emit('historyCountDecreased', result.deletedCount);
        }
    });
}

History.prototype.stop = function () {
    this.logger.info('HISTORY: stopped')
    clearTimeout(this.timeout);
}


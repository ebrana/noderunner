var Job = require("../job.js");
var EventEmitter = require('events').EventEmitter;
var util = require('util');

exports = module.exports = Planned;

function Planned(db, nconf, logger) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.timeout = null
}

util.inherits(Planned, EventEmitter);

Planned.prototype.getJobs = function(callback, filter) {
    var data = [];

    if (typeof filter.implementation != 'undefined') {
        filter.args = new RegExp(filter.implementation);
        delete filter.implementation;
    }

    if (typeof filter.job != 'undefined') {
        filter.args = new RegExp(filter.job);
        delete filter.job;
    }

    this.db.collection('planned').find(filter).each(function(err, doc) {
        if(doc == null) {
            callback(data);
            return;
        }
        data.push(doc);
    });
}

Planned.prototype.checkRunningJobBySource = function(id, callback) {
    var self = this;
    self.db.collection('immediate').find({sourceId:id, status:'running'}).toArray(function (err, docs) {
        callback(docs.length > 0);
    });
}

Planned.prototype.run = function () {
    var self = this;

    // load planned jobs and move them one by one to immediate
    self.db.collection('planned').find().toArray(function (err, docs) {
        if (typeof docs !== 'undefined' && docs && docs.length > 0) {
            var someDueJob = false;
            docs.forEach(function (doc) {
                var job = new Job(self);
                job.initByDocument(doc);

                if (job.isDue()) {
                    // concurrenceMode skip runs planned job only if last instance is not running
                    switch (doc.concurrenceMode) {
                        case 'skip':
                            someDueJob = true;
                            self.checkRunningJobBySource(doc._id, function(isRunning){
                                if (isRunning) {
                                    self.logger.warn('PLANNED: job ' + doc._id + ' skipped due to concurrence mode (same job already running)');
                                } else {
                                    self.logger.info('PLANNED: moving job '+job.toString());
                                    job.copyToImmediate();
                                }
                            });
                            break;
                        case 'kill':
                            // TODO kill all running jobs with same source
                            self.logger.warn('PLANNED: concurrency mode kill is not supported yet - using allow instead');
                        case 'allow':
                        default:
                            self.logger.info('PLANNED: moving job '+job.toString());
                            someDueJob = true;
                            job.copyToImmediate();
                    }

                    // TODO if not repetitive=true, delete original
                }
            })
            if (!someDueJob) {
                self.logger.verbose('PLANNED: no due job, sleep for 1 minute');
            }
        } else {
            self.logger.verbose('PLANNED: no planed job, sleep for 1 minute');
        }

        // timeout must be exactly 1min - otherwise some jobs wont run or run twice a time
        self.timeout = setTimeout(function () {
            self.run()
        }, 60000);
    })
    return this;
}

Planned.prototype.stop = function () {
    this.logger.info('PLANNED: stopped')
    clearTimeout(this.timeout);
}
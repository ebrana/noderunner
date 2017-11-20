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
    this.db.collection('planned').find(filter, {limit: 100}).toArray(function(err, docs) {
        if (err) {
            this.logger.error(err);
        } else {
            return callback(docs);
        }
    });
}

Planned.prototype.getJobsCount = function(callback) {
    this.db.collection('planned').count(function(err, count) {
        callback(count);
    });
}

Planned.prototype.checkRunningJobBySource = function(id, callback) {
    var self = this;
    self.db.collection('immediate').find({sourceId:id, $or:[{status:"running"},{status:"fetched"},{status:"planed"}]}).toArray(function (err, docs) {
        callback(docs.length > 0);
    });
}

Planned.prototype.run = function () {
    var self = this;

    // load planned jobs and move them one by one to immediate
    self.db.collection('planned').find().toArray(function (err, docs) {
        if (typeof docs !== 'undefined' && docs && docs.length > 0) {

            var dueJobsCount        = 0;
            var checkIntervalLength = self.nconf.get('planned:interval');
            var checkIntervalStart  = self.lastCheckTime ? self.lastCheckTime : (Date.now() - checkIntervalLength);
            var checkIntervalEnd    = self.lastCheckTime = Date.now();

            docs.forEach(function (doc) {
                var job = new Job(self);
                job.initByDocument(doc);

                if (job.isDue(checkIntervalStart, checkIntervalEnd)) {
                    // concurrenceMode skip runs planned job only if last instance is not running
                    switch (doc.concurrenceMode) {
                        case 'skip':
                            dueJobsCount++;
                            self.checkRunningJobBySource(doc._id, function(isRunning){
                                if (isRunning) {
                                    self.logger.warn('PLANNED: job ' + doc._id + ' skipped due to concurrence mode (same job already running)');
                                } else {
                                    self.logger.debug('PLANNED: moving job '+job.document._id/*job.toString()*/);
                                    job.copyToImmediate(function(){
                                        self.emit('waitingCountIncreased', 1);
                                    });
                                }
                            });
                            break;
                        case 'kill':
                            // TODO kill all running jobs with same source
                            self.logger.warn('PLANNED: concurrency mode kill is not supported yet - using allow instead');
                        case 'wait':
                            // TODO do nothing and try again in next round
                            self.logger.warn('PLANNED: concurrency mode wait is not supported yet - using allow instead');
                        case 'allow':
                        default:
                            self.logger.debug('PLANNED: moving job '+job.document._id/*job.toString()*/);
                            dueJobsCount++;
                            job.copyToImmediate(function(){
                                self.emit('waitingCountIncreased', 1);
                            });
                    }

                    // TODO if not repetitive=true, delete original
                }
            })
            if (dueJobsCount > 0) {
                self.logger.info('PLANNED: moving '+dueJobsCount+' due planned jobs to immediate queue');
            } else {
                self.logger.verbose('PLANNED: no due job, sleep for '+self.nconf.get('planned:interval')/1000+'s');
            }
        } else {
            self.logger.verbose('PLANNED: no planed job, sleep for '+self.nconf.get('planned:interval')/1000+'s');
        }

        // timeout must be exactly 1min - otherwise some jobs wont run or run twice a time
        self.timeout = setTimeout(function () {
            self.run()
        }, self.nconf.get('planned:interval'));
    })
    return this;
}

Planned.prototype.stop = function () {
    this.logger.info('PLANNED: stopped')
    clearTimeout(this.timeout);
}

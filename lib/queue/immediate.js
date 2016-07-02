var Job = require("../job.js");
var EventEmitter = require('events').EventEmitter;
var util = require('util');

exports = module.exports = Immediate;


function Immediate(db, nconf, logger) {
    EventEmitter.call(this);

    this.db = db
    this.nconf = nconf
    this.logger = logger
    
    this.timeout = null
    this.maxThreadsCount = nconf.get('immediate:maxThreadsCount');
    this.activeThreadsCount = 0;
    this.running = false;
    this.lastFinishedCallback = null;
}

util.inherits(Immediate, EventEmitter);

Immediate.prototype.getJobs = function(callback, filter) {
    var data = [];

    if (typeof filter.implementation != 'undefined') {
        filter.args = new RegExp(filter.implementation);
        delete filter.implementation;
    }

    if (typeof filter.job != 'undefined') {
        filter.args = new RegExp(filter.job);
        delete filter.job;
    }

    if (typeof filter.output != 'undefined') {
        filter.output = new RegExp(filter.output);
    }

    this.db.collection('immediate').find(filter, {"sort": [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']]}).each(function(err, doc) {
        if(doc == null) {
            callback(data);
            return;
        }
        data.push(doc);
    });
}

Immediate.prototype.run = function () {
    this.running = true;
    this._removeStuckRunningJobs();
    this._check();
    return this;
}

Immediate.prototype._removeStuckRunningJobs = function() {
    var self = this;
    var documentsToMove = self.db.collection('immediate').find({$or:[{status:"running"},{status:"fetched"}]}).each(function(err, doc){
        if(doc != null) {
            self.db.collection('immediate').remove(doc);
            delete doc._id;
            doc.status = "stucked";
            doc.finished = Math.floor(new Date().getTime() / 1000);
            self.db.collection('history').insert(doc);
            self.logger.warn('moving stuck running/fetched job');
        }
    });
}

Immediate.prototype._check = function () {
    var self = this;

    clearTimeout(self.timeout);

    // if queue is already stopped, do nothing
    if (this.running == false) {
        if (self.activeThreadsCount == 0 && self.lastFinishedCallback) {
            self.lastFinishedCallback();
        }
        return;
    }

    // no available thread - do nothing - _check will be called in thread end callback
    if (!self._isAvailableThread()) {
        self.logger.info('IMMEDIATE: no available thread, waiting');
        return;
    }

    // get next job in immediate queue
    self.fetchNextJob(function (job) {
        if (job) {
            // job fetched - run immediately
            self._changeActiveThreadsCount( +1 );
            job.run(self.activeThreadsCount, function () {
                // job done - try fetch and run another immediately
                self._changeActiveThreadsCount( -1 );
                self._check();
            });

            // job done - try fetch and run another immediately
            self._check();
        } else {
            // no immediate job available - check later
            self.logger.verbose('IMMEDIATE: nothing to run, sleep for ' + nconf.get('immediate:interval')/1000 + ' secs');

            clearTimeout(self.timeout);
            self.timeout = setTimeout(function () {
                self._check();
            }, nconf.get('immediate:interval'));
        }
    });
}

Immediate.prototype.fetchNextJob = function (callback) {
    var self = this;

    var changes = {
        status: self.nconf.get('statusAlias:fetched'),
        started: Math.floor(new Date().getTime() / 1000)
    };

    this.db.collection('immediate').findAndModify(
        {status: self.nconf.get('statusAlias:planned')},
        [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']],
        {$set: changes},
        {new: true},
        function (err, doc) {
            if (err) {
                self.logger.error('IMMEDIATE: cannot load job from queue', err);
                callback(false);
            } else if (!doc.value) {
                // no next job found in immediate queue
                callback(false);
            } else {
                // next job found in immediate queue
                var job = new Job(self);
                job.initByDocument(doc.value);
                callback(job);

                self.emit('jobChanged', {changes: changes, newDocument: job.document})
            }
        }
    );
};

Immediate.prototype._changeActiveThreadsCount = function (difference) {
    this.activeThreadsCount += difference;
    this.emit('runningCountChanged', this.activeThreadsCount);
}

Immediate.prototype._isAvailableThread = function () {
    return this.activeThreadsCount < this.maxThreadsCount;
}

Immediate.prototype.stop = function (callback) {
    if (this.activeThreadsCount == 0 && typeof callback == 'function') {
        callback();
        return
    }

    this.lastFinishedCallback = callback
    this.logger.info('IMMEDIATE: stopped')
    this.running = false;
    clearTimeout(this.timeout);
}

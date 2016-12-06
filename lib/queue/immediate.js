var Job = require("../job.js");
var EventEmitter = require('events').EventEmitter;
var util = require('util');

exports = module.exports = Immediate;

function Immediate(db, nconf, logger) {
    EventEmitter.call(this);

    this.db = db;
    this.nconf = nconf;
    this.logger = logger;
    
    this.timeout = null;
    this.running = false;
    this.lastFinishedCallback = null;
    this.lastCheckTime = null;

    // entry for every thread with null value when free and non-null ('booked' or job _id when currently used)
    this.threads = [];
    this.threadsUsageCounter = [];
    for (var i = 0; i < nconf.get('immediate:maxThreadsCount'); i++) {
        this.threads[i] = null;
        this.threadsUsageCounter[i] = 0.0;
    }
}

util.inherits(Immediate, EventEmitter);

Immediate.prototype.run = function () {
    this.running = true;
    this._removeStuckRunningJobs();
    this._check();
    return this;
}

Immediate.prototype._removeStuckRunningJobs = function() {
    var self = this;
    self.db.collection('immediate').find({$or:[{status:"running"},{status:"fetched"}]}).each(function(err, doc){
        if (doc != null) {
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
    self.lastCheckTime = Date.now();

    clearTimeout(self.timeout);

    // if queue is already stopped, do nothing
    if (this.running == false) {
        if (!this.isAnyBookedThread() && self.lastFinishedCallback) {
            self.lastFinishedCallback();
        }
        return;
    }

    // try to book any free thread
    var threadIndex = self.bookThread();

    // if available - do nothing - _check will be called in thread end callback
    if (threadIndex === null) {
        self.logger.debug('IMMEDIATE: no available thread, waiting...');
        return;
    }

    // get next job in immediate queue
    self.fetchNextJob(function (job) {
        // job found - run immediately
        job.run(threadIndex, function (code, duration) {
            // job done - try fetch and run another immediately
            self.threadsUsageCounter[threadIndex] += duration;
            self.releaseThread(threadIndex);
            self._check();
        });

        // job done - try fetch and run another immediately without wait
        self._check();
    }, function(e) {
        self.releaseThread(threadIndex);

        // no job found or error
        if (e) {
            self.logger.error('IMMEDIATE: error during fetch, sleep for ' + self.nconf.get('immediate:interval')/1000 + ' secs', r);
        } else {
            self.logger.verbose('IMMEDIATE: nothing to run, sleep for ' + self.nconf.get('immediate:interval')/1000 + ' secs');
        }

        clearTimeout(self.timeout);
        self.timeout = setTimeout(function () {
            self._check();
        }, self.nconf.get('immediate:interval'));
    });
}

// return index of lowest free thread and lock it
Immediate.prototype.bookThread = function() {
    for (var i = 0; i < this.threads.length; i++) {
        if (this.threads[i] === null) {
            this.logger.silly('IMMEDIATE: booked thread '+i);
            this.threads[i] = 'booked';
            return i;
        }
    }
    return null;
}

Immediate.prototype.releaseThread = function(index) {
    this.logger.silly('IMMEDIATE: released thread '+index);
    this.threads[index] = null;
}

Immediate.prototype.isAnyBookedThread = function(){
    for (var i = 0; i < this.threads.length; i++) {
        if (this.threads[i] !== null) {
            return true;
        }
    }
    return false;
}

Immediate.prototype.fetchNextJob = function (callback, fallback) {
    var self = this;

    var changes = {
        status: self.nconf.get('statusAlias:fetched'),
        started: Math.floor(new Date().getTime() / 1000)
    };

    try {
        this.db.collection('immediate').findAndModify(
            {status: self.nconf.get('statusAlias:planned')},
            [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']],
            {$set: changes},
            {new: true},
            function (err, doc) {
                if (err) {
                    self.logger.error('IMMEDIATE: cannot load job from queue', err);
                    fallback(false);
                } else if (!doc.value) {
                    // no next job found in immediate queue
                    fallback(false);
                } else {
                    // next job found in immediate queue
                    var job = new Job(self);
                    job.initByDocument(doc.value);
                    callback(job);

                    self.emit('jobChanged', {changes: changes, newDocument: job.document})
                }
            }
        );
    } catch (e) {
        fallback(e);
    }
};

Immediate.prototype.stop = function (callback) {
    if (!this.isAnyBookedThread() && typeof callback == 'function') {
        callback();
        return
    }

    this.lastFinishedCallback = callback;
    this.logger.info('IMMEDIATE: stopped');
    this.running = false;
    clearTimeout(this.timeout);
}

Immediate.prototype.resetThreadsUsageCounter = function() {
    this.threadsUsageCounter = this.threadsUsageCounter.map(function() {
        return 0;
    });
}

Immediate.prototype.getThreadsInfo = function(highlightIndex) {
    return '['+this.threads.map(function(t, i){
        return typeof highlightIndex != 'undefined' && highlightIndex==i ? 'o' : (t === null ? '-' : 'x');
    }).join('')+']';
}

// TODO move filters to gui
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

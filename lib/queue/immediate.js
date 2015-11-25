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
    this.interval = nconf.get('immediate:interval')
    this.maxThreadsCount = nconf.get('immediate:maxThreadsCount');
    this.activeThreadsCount = 0;
    this.running = false;
    this.lastFinishedCallback = null;
}

util.inherits(Immediate, EventEmitter);

Immediate.prototype.getJobs = function(callback) {
    var data = [];

    this.db.collection('immediate').find({}, {"sort": [['added','desc'], ['started','desc']]}).each(function(err, doc) {
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
            self.db.collection('history').insert(doc);
            self.logger.warn('moving stuck running/fetched job');
        }
    });
}

Immediate.prototype._check = function () {
    var self = this;

    // if queue is already stopped, do nothing
    if (this.running == false) {
        if (self.activeThreadsCount == 0 && self.lastFinishedCallback) {
            self.lastFinishedCallback();
        } else {
            return;
        }
    }

    // pokud neni k dispozici volne vlakno, pak nic nedelame - _check() se znovu zavola po dokonceni nektereho beziciho jobu
    if (!self._isAvailableThread()) {
        self.logger.info('IMMEDIATE: no available thread, waiting');
        return false;
    }

    // zkontrolujeme zdali je nejaky job k dispozici
    var job = new Job(this.db, this.nconf, this.logger, this);
    job.isAvailable(function (result) {
        if (result) {
            // mame job k dispozici, hned spustime
            self.activeThreadsCount++;
            self.emit('freeThreadsCountChanged', self.maxThreadsCount - self.activeThreadsCount);
            self.emit('runningCountChanged', self.activeThreadsCount);
            job.run(self.activeThreadsCount, function () {
                // job dobehl, hned bez timeoutu zkusime naplanovat dalsi
                self.activeThreadsCount--;
                self.emit('freeThreadsCountChanged', self.maxThreadsCount - self.activeThreadsCount);
                self.emit('runningCountChanged', self.activeThreadsCount);
                clearTimeout(self.timeout);
                self._check();
            });
            // po spusteni jednoho jobu hned kontrolujeme, jestli neni dostupny dalsi
            clearTimeout(self.timeout);
            self._check();
        } else {
            // zadny immediate job k dispozici, zkusime to znovu za chvili
            self.logger.verbose('IMMEDIATE: nothing to run, sleep for ' + self.interval/1000 + ' secs');
            // self.gui.emit('immediateIdle');
            clearTimeout(self.timeout);
            self.timeout = setTimeout(function () {
                self._check();
            }, self.interval);
        }
    });
    return true;
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

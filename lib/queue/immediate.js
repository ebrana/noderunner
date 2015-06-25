var Job = require("../job.js");

exports = module.exports = Immediate;


function Immediate(db, nconf, logger) {
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

Immediate.prototype.run = function () {
    this.running = true;
    this._check()
    return this;
}

Immediate.prototype._check = function () {
    var self = this;

    // if queue is already stopped, do nothing
    if (this.running == false) {
        if (self.activeThreadsCount == 0 && self.lastFinishedCallback) {
            self.lastFinishedCallback()
        } else {
            return
        }
    }

    // pokud neni k dispozici volne vlakno, pak nic nedelame - _check() se znovu zavola po dokonceni nektereho beziciho jobu
    if (!self._isAvailableThread()) {
        self.logger.warn('IMMEDIATE: no available thread, waiting');
        return false;
    }

    // zkontrolujeme zdali je nejaky job k dispozici
    var job = new Job(this.db, this.nconf, this.logger);
    job.isAvailable(function (result) {
        if (result) {
            // mame job k dispozici, hned spustime
            self.activeThreadsCount++;
            job.run(self.activeThreadsCount, function () {
                // job dobehl, hned bez timeoutu zkusime naplanovat dalsi
                self.activeThreadsCount--;
                clearTimeout(self.timeout);
                self._check();
            });
            // po spusteni jednoho jobu hned kontrolujeme, jestli neni dostupny dalsi
            clearTimeout(self.timeout);
            self._check();
        } else {
            // zadny immediate job k dispozici, zkusime to znovu za chvili
            self.logger.verbose('IMMEDIATE: nothing to run, sleep for ' + self.interval/1000 + ' secs');

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
    this.lastFinishedCallback = callback
    this.logger.info('IMMEDIATE: stopped')
    this.running = false;
    clearTimeout(this.timeout);
}
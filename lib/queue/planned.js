var Job = require("../job.js");

exports = module.exports = Planned;

function Planned(db, nconf, logger) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.timeout = null
}

Planned.prototype.run = function () {
    var self = this;

    // nacist naplanovane ulohy a projit je po jedne
    self.db.collection('planned').find().toArray(function (err, docs) {
        if (docs && docs.length > 0) {
            var someDueJob = false;
            docs.forEach(function (doc) {
                var job = new Job(self.db, self.nconf, self.logger);
                job.initByDocument(doc);

                if (job.isDue()) {
                    // TODO if not repetitive=true, delete original
                    job.copyToImmediate();
                    self.logger.info('PLANNED: moving job '+job.toString());
                    someDueJob = true;
                }
            })
            if (!someDueJob) {
                self.logger.verbose('PLANNED: no due job, sleep for 1 minute');
            }
        } else {
            self.logger.verbose('PLANNED: no planed job, sleep for 1 minute');
        }

        // prodleva mezi behy tohoto skriptu musi byt presne minuta, aby nepreskocil nektere cronjoby nebo je nespustil 2x
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
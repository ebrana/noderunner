var Job = require("../job.js");

exports = module.exports = Planned;

function Planned(db, nconf, logger) {
    this.db = db
    this.nconf = nconf
    this.timeout = null
    this.logger = logger
}

Planned.prototype.run = function () {
    var self = this;

    // nacist naplanovane ulohy a projit je po jedne
    self.db.collection('planned').find().toArray(function (err, docs) {
        if (docs.length > 0) {
            docs.forEach(function (doc) {
                var job = new Job(self.db);
                job.initByDocument(doc);

                if (job.isDue()) {
                    job.copyToImmediate();
                    self.logger.verbose('PLANNED: moving job '+job._id);
                }
            })
        } else {
            self.logger.verbose('PLANNED: nothing to move, sleep for 1 minute');
        }

        // prodleva mezi behy tohoto skriptu musi byt presne minuta, aby nepreskocil nektere cronjoby nebo je nespustil 2x
        setTimeout(function () {
            self.run()
        }, 60000);
    })
}


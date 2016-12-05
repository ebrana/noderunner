var os = require("os");

exports = module.exports = Watchdog;

function Watchdog(db, nconf, logger) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.interval = null
    this.badSamplesLimit = nconf.get('watchdog:badSamplesLimit');
    this.badSamplesCount = 0;
    this.lastSample = null;
    this.emailSent = false;
    this.emailResetInterval = null;
    this.email2Sent = false;
    this.immediateQueue = null;
}

Watchdog.prototype.run = function (immediateQueue) {
    var self = this;
    self.immediateQueue = immediateQueue;

    self._calculateLoad(15*60, function(avgLoad) {
        self.logger.info('avg load for last 15 minutes: ' + avgLoad);
    });

    // check repeatedly
    self.interval = setInterval(function () {
        self._run()
    }, self.nconf.get('watchdog:interval'));

    // send info email max once per hour
    self.emailResetInterval = setInterval(function(){
        self.emailSent = false;
        self.email2Sent = true;
    }, 60*60*1000);

    return self;
}

Watchdog.prototype._calculateLoad = function(forSeconds, callback) {
    var self         = this;
    var intervalTo   = Date.now()/1000;
    var intervalFrom = intervalTo - forSeconds;
    var intervalDuration = (intervalTo - intervalFrom);

    // load done jobs contained in measured interval
    self.db.collection('history').find({
        $or: [
            {$and:[{finished: {$gt: intervalFrom}}, {finished: {$lt: intervalTo}}]},
            {$and:[{started:  {$gt: intervalFrom}}, {started:  {$lt: intervalTo}}]}
        ]
    }).toArray(function (err, jobs) {
        var totalUsedSeconds = 0;
        for (var i in jobs) {
            // get duration of job in measured interval (truncate by interval boundaries)
            var jobFrom = Math.max(jobs[i].started, intervalFrom);
            var jobTo   = Math.min(jobs[i].finished, intervalTo);
            totalUsedSeconds += (jobTo - jobFrom);
        }
        console.log(totalUsedSeconds+'/'+intervalDuration)
        callback(Math.round(totalUsedSeconds/intervalDuration*100)/100 + '/' + self.immediateQueue.threads.length + ' (' + Math.round((totalUsedSeconds/intervalDuration)/self.immediateQueue.threads.length*100) + ' %)');
    });

}

Watchdog.prototype._run = function() {
    var self = this;

    self._calculateLoad(15*60, function(avgLoad) {
        self.logger.info('avg load for last 15 minutes: ' + avgLoad);
    });

    // check immediate jobs count
    self.db.collection('immediate').count({$or: [{status: self.nconf.get('statusAlias:planned')}, {status: self.nconf.get('statusAlias:running')}]},function(err, count) {
        // actual count bigger than the last one - increment counter
        if (count > self.lastSample && self.lastSample !== null) {
            self.badSamplesCount ++
        } else if (count < self.lastSample) {
            self.badSamplesCount = 0
        }

        var percents = Math.round(self.badSamplesCount/self.badSamplesLimit*100);
        if (percents < 100) {
            self.logger.verbose('WATCHDOG: danger of congestion is on ' + percents + '%')
        }
        self.logger.debug('WATCHDOG: sample=' + count + ' badSamplesLimit=' + self.badSamplesLimit + ' badSamplesCount=' + self.badSamplesCount + ' lastSample=' + self.lastSample)

        // if counter bigger than limit - send email
        if (self.badSamplesCount >= self.badSamplesLimit) {
            if (!self.emailSent) {
                self._sendEmail('Noderunner immediate queue planned/running jobs count is growing rapidly. Danger of congestion! Please repair problem and restart noderuner service.', function () {
                    self.emailSent = true;
                });
            }
            self.logger.warn('WATCHDOG: Immediate planned/running jobs count is growing rapidly! Danger of congestion!')
            return self
        }

        self.lastSample = count;
    })

    // check last immediate check time
    var sinceLastCheck = (Date.now()-self.immediateQueue.lastCheckTime);
    self.logger.debug('WATCHDOG: last immediate queue check time ' + sinceLastCheck + 'ms ago');
    if (sinceLastCheck > self.nconf.get('immediate:interval') * 3) {
        self.logger.warn('WATCHDOG: Time since last immediate queue check is more than 3 times greater than set check interval!')
        if (!self.email2Sent) {
            self._sendEmail('Time since last immediate queue check is more than 3 times greater than set check interval! Immediate queue is probably not working.', function () {
                self.email2Sent = true;
            });
        }
    }
}

Watchdog.prototype._sendEmail = function(text, cb) {

    var self = this;
    var nodemailer = require('nodemailer');
    var smtpTransport = require('nodemailer-smtp-transport');

    nodemailer.createTransport(smtpTransport({host: 'mail.ebrana.cz', port: 25})).sendMail({
        from: self.nconf.get('watchdog:email:from'),
        to: self.nconf.get('watchdog:email:to'),
        subject: 'NodeRunner watchdog - '+os.hostname(),
        text: text
    },function(error, info){
        if(error){
            self.logger.error('WATCHDOG: cannot send warning email', error);
        } else {
            cb(info);
            self.logger.verbose('WATCHDOG: warning email sent ', info.response);
        }
    });
}

Watchdog.prototype.stop = function () {
    this.logger.info('WATCHDOG: stopped')
    this.running = false;
    clearInterval(this.interval);
    clearInterval(this.emailResetInterval);
}
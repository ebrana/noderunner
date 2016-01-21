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
    this.email2Sent = false;
    this.immediateQueue = null;
}

Watchdog.prototype.run = function (immediateQueue) {
    var self = this;
    self.immediateQueue = immediateQueue;

    // spoustet v smycce konfigurovatelne delky
    self.interval = setInterval(function () {
        self._run()
    }, self.nconf.get('watchdog:interval'));

    return self;
}

Watchdog.prototype._run = function() {
    var self = this;

    // zjistit pocet naplanovanych uloh ve fronte immediate
    self.db.collection('immediate').count({$or: [{status: self.nconf.get('statusAlias:planned')}, {status: self.nconf.get('statusAlias:running')}]},function(err, count) {
        // pokud je aktualni pocet vetsi nez minuly, zvysime pocitadlo
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

        // pokud je pocitadlo vetsi nez limit, spustime poplach
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
    });

    // zjistit cas posledni kontroly immediate fronty
    var sinceLastCheck = (Date.now()-self.immediateQueue.lastCheckTime);
    self.logger.debug('WATCHDOG: last immediate queue check time ' + sinceLastCheck + 'ms ago');
    if (sinceLastCheck > self.nconf.get('immediate:interval') * 3) {
        self.logger.warn('WATCHDOG: Time since last immediate queue check is more than 3 times greater than set check interval!')
        if (!self.emailSent2) {
            self._sendEmail('Time since last immediate queue check is more than 3 times greater than set check interval! Immediate queue is probably not working.', function () {
                self.emailSent2 = true;
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
}
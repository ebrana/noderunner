exports = module.exports = Watchdog;

function Watchdog(db, nconf, logger) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.timeout = null
    this.badSamplesLimit = nconf.get('watchdog:badSamplesLimit');
    this.badSamplesCount = 0;
    this.lastSample = null;
    this.emailSent = false;
    this.emailResetInterval = null;
}

Watchdog.prototype.run = function () {
    var self = this;

    // zjistit pocet naplanovanych uloh ve fronte immediate
    self.db.collection('immediate').count({status: self.nconf.get('statusAlias:planned')},function(err, count) {
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
            self._sendEmail();
            self.logger.warn('WATCHDOG: Immediate planned jobs count is growing rapidly! Danger of congestion!')
            return self
        }

        self.lastSample = count;
    })

    // send info email max once per hour
    if (!self.emailResetInterval) self.emailResetInterval = setInterval(function(){
        self.emailSent = false;
    }, 60*60*1000);

    // spoustet v smycce konfigurovatelne delky
    self.timeout = setTimeout(function () {
        self.run()
    }, self.nconf.get('watchdog:interval'));

    return self
}

Watchdog.prototype._sendEmail = function() {
    if (this.emailSent) return;

    var self = this;
    var nodemailer = require('nodemailer');
    var smtpTransport = require('nodemailer-smtp-transport');

    nodemailer.createTransport(smtpTransport({host: 'mail.ebrana.cz', port: 25})).sendMail({
        from: self.nconf.get('watchdog:email:from'),
        to: self.nconf.get('watchdog:email:to'),
        subject: 'Noderunner congestion warning',
        text: 'Noderunner immediate queue planned jobs count is growing rapidly. Danger of congestion! Please repair problem and restart noderuner service.'
    },function(error, info){
        if(error){
            self.logger.error('WATCHDOG: cannot send warning email', error);
        } else {
            self.emailSent = true;
            self.logger.verbose('WATCHDOG: warning email sent ', info.response);
        }
    });
}

Watchdog.prototype.stop = function () {
    this.logger.info('WATCHDOG: stopped')
    this.running = false;
    clearTimeout(this.timeout);
}
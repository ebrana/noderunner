exports = module.exports = Job;

var parser = require('cron-parser'),
    ObjectID = require('mongodb').ObjectID;

function Job(db, nconf, logger) {
    this.db = db;
    this.nconf = nconf;
    this.logger = logger;
};

Job.prototype.isAvailable = function (callback) {
    var self = this;

    this.db.collection('immediate').findAndModify(
        {status: self.nconf.get('statusAlias:planned')},
        [['nextRun', 'asc'], ['priority', 'desc']],
        {$set: {status: self.nconf.get('statusAlias:fetched'), started: new Date().getTime()/1000}},
        {new: true},
        function (err, doc) {
            if (err) {
                self.logger.error('IMMEDIATE: cannot load job from queue', err)
            }

            if (!err && doc.value) {
                self.document = doc.value;
                callback(true);
            } else {
                self.document = null;
                callback(false);
            }
        }
    );
}

Job.prototype.run = function (activeThreadsCount, callback) {
    var self = this;
    var command = this._buildCommandArray();
    this.threadName = this._buildThreadName(activeThreadsCount);

    this.logger.info('THREAD ' + this.threadName + ': running ', self.toString());

    var spawn = require('child_process').spawn;
    var child = spawn(command[0], command[1]);

    self.document.pid = child.pid;
    self.document.status = self.nconf.get('statusAlias:running');
    self._save();

    child.stdout.on('data', function (data) {
        // TODO dodelat buffer, aby se nevolalo mongo pri kazdem radku
        self.logger.verbose('THREAD ' + self.threadName + ': data ', data.toString().replace('\n', ' '));
        self._appendToProperty('output', data.toString());
    });
    child.stderr.on('data', function (data) {
        self._appendToProperty('errors', data.toString());
    });
    child.on('close', function (code) {
        self._finish(code);
        callback(code);
    });
}

Job.prototype.isDue = function () {
    // next() vraci pristi spusteni daneho cronu, proto se musime vratit o minutu v case abychom ziskali aktualni spusteni
    var now = new Date();
    var next = parser.parseExpression(this.document.schedule, {currentDate: now.valueOf() - 60000}).next();
    now.setSeconds(0);

    return now.valueOf() == next.valueOf();
}

Job.prototype.copyToImmediate = function () {
    var newDocument = this.document
    newDocument.sourceId = newDocument._id;
    delete newDocument._id
    newDocument.status = this.nconf.get('statusAlias:planned');
    this.logger.debug('copyToImmediate')
    this.db.collection('immediate').insert(newDocument)
}

Job.prototype.moveToHistory = function () {
    var newDocument = this.document
    this.db.collection('immediate').remove({_id:newDocument._id});
    delete newDocument._id;
    this.logger.debug('moveToHistory')
    this.db.collection('history').insert(newDocument)
}

Job.prototype.initByDocument = function (doc) {
    this.document = doc;
}

Job.prototype.toString = function() {
    return this.document._id + ' ' + this._buildCommand();
}

Job.prototype._finish = function (code) {
    this.document.finished = new Date().getTime()/1000;
    if (code == 0) {
        this.document.status = this.nconf.get('statusAlias:success');
        this.logger.info('THREAD ' + this.threadName + ': done with SUCCESS');
    } else {
        this.document.status = this.nconf.get('statusAlias:error');
        this.logger.error('THREAD ' + this.threadName + ': done with ERROR, status '+code);
    }
    this._save();
}

Job.prototype._appendToProperty = function (property, value) {
    this.document[property] += value;
    this._save();
}

Job.prototype._save = function () {
    var self = this
    this.logger.debug('_save')
    this.db.collection('immediate').update(
        {_id: this.document._id},
        {$set: this.document},
        {},
        function (err, doc) {
            if (err) {
                self.logger.error('THREAD ' + self.threadName + ':', 'cannot save document', err, doc);
            }
        }
    );
}

Job.prototype._buildCommandArray = function() {
    return this._buildCommand(true);
}

Job.prototype._buildCommand = function (returnAsArray) {
    args = ['-u', this.nconf.get('sudo:user'), '-g', this.nconf.get('sudo:group')];
    args = args.concat(this._hasProperty('nice') ? ['nice', '-n', this.document.nice] : []);
    args = args.concat(this._hasProperty('interpreter') ? [this.document.interpreter] : []);
    if (this._hasProperty('basePath')) {
        var path = this.document.basePath + '/';
        if (this._hasProperty('executable')) {
            path += this.document.executable;
        }
        args.push(path);
    }
    args = args.concat(this._hasProperty('args') ? this.document.args.split(' ') : []);

    if (typeof returnAsArray === 'undefined' || !returnAsArray) {
        return 'sudo ' + args.join(' ')
    } else {
        return ['sudo', args];
    }
}

Job.prototype._buildThreadName = function (activeThreadsCount) {
    var name = '#'+activeThreadsCount;

    var threadNames = this.nconf.get('debug:threadNames');
    if (threadNames) {
        var name = threadNames[activeThreadsCount];
    }

    return name;
}

Job.prototype._hasProperty = function (prop) {
    return typeof this.document[prop] !== 'undefined' && this.document[prop] !== null;
}

exports = module.exports = Job;

var parser = require('cron-parser');

function Job(queue) {
    this.db = queue.db;
    this.nconf = queue.nconf;
    this.logger = queue.logger;
    this.queue = queue;
}

Job.prototype.run = function (callback, fallback, onStatusSaved) {
    var self = this;
    var command = this._buildCommandArray();
    this.threadName = this._buildThreadName(self.document.thread);
    this.threadIndex = self.document.thread;

    this.logger.info('THREAD ' + this.threadName + ' ' + this.queue.getThreadsInfo(this.threadIndex) + ' running ' + /*self.toString()*/this.document._id);

    self._save({
        status: self.nconf.get('statusAlias:running'),
        executedCommand: command[0] + ' ' + command[1].join(' ')
    }, function (document) {
        if (typeof onStatusSaved != 'undefined') {
            onStatusSaved(document);
        }

        var spawn = require('child_process').spawn;
        var child = spawn(command[0], command[1]);

        self._save({
            'pid': child.pid
        });

        child.stdout.on('data', function (data) {
            // TODO dodelat buffer, aby se nevolalo mongo pri kazdem radku
            //self.logger.verbose('THREAD ' + self.threadName + ': data ', data.toString().replace('\n', ' '));
            self._appendToProperty('output', data.toString());
        });
        child.stderr.on('data', function (data) {
            self.logger.warn('THREAD ' + self.threadName + ': error ', data.toString().replace('\n', ' '));
            self._appendToProperty('errors', data.toString());
        });
        child.on('close', function (code) {
            self._finish(code);
            callback(code);
        });
    }, function () {
        if (typeof fallback != 'undefined') {
            fallback();
        }
    });
}

Job.prototype.isDue = function () {
    // next() vraci pristi spusteni daneho cronu, proto se musime vratit o minutu v case abychom ziskali aktualni spusteni
    var now = new Date();
    var next = parser.parseExpression(this.document.schedule, {currentDate: now.valueOf() - 60000}).next();
    now.setSeconds(0);

    return now.valueOf() == next.valueOf();
}

Job.prototype.copyToImmediate = function (callback) {
    var self = this;
    var newDocument = this.document
    newDocument.sourceId = newDocument._id;
    delete newDocument._id
    newDocument.status = this.nconf.get('statusAlias:planned');
    newDocument.added = new Date().getTime() / 1000;
    this.logger.silly('copyToImmediate')
    this.db.collection('immediate').insert(newDocument, function () {
        self.logger.silly('copyToImmediate DONE')
        // self.queue.emit('copiedToImmediate', {oldDocument: self.document, newDocument: newDocument});
        callback();
    })
}

Job.prototype.moveToHistory = function () {
    var self = this;
    var newDocument = this.document
    this.db.collection('immediate').remove({_id: newDocument._id});
    delete newDocument._id;
    this.logger.silly('moveToHistory')
    this.db.collection('history').insert(newDocument, function () {
        self.logger.silly('moveToHistory DONE')
        // self.queue.emit('movedToHistory', {oldDocument: self.document, newDocument: newDocument});
    })
}

Job.prototype.rerun = function () {
    var self = this;
    var newDocument = this.document;

    delete newDocument._id;
    newDocument.status = this.nconf.get('statusAlias:planned');
    newDocument.added = new Date().getTime() / 1000;
    newDocument.output = '';
    newDocument.errors = '';
    this.logger.debug('rerun')
    this.db.collection('immediate').insert(newDocument, function () {
        self.logger.debug('rerun DONE')
        self.queue.emit('rerunDone', {oldDocument: self.document, newDocument: newDocument});
    })
}

Job.prototype.initByDocument = function (doc) {
    this.document = doc;
}

Job.prototype.toString = function () {
    return this.document._id + ' ' + this._buildCommand();
}

Job.prototype._finish = function (code) {
    var finished = new Date().getTime() / 1000;

    if (code == 0) {
        this._save({status: this.nconf.get('statusAlias:success'), finished: finished});
        this.logger.info('THREAD ' + this.threadName + ' ' + this.queue.getThreadsInfo(this.threadIndex) + '  -> ' + this.document._id + ' done with SUCCESS');
    } else {
        this._save({status: this.nconf.get('statusAlias:error'), finished: finished});
        this.logger.warn('THREAD ' + this.threadName + ' ' + this.queue.getThreadsInfo(this.threadIndex) + '  -> ' + this.document._id + ' done with ERROR, status ' + code);
    }
    return finished - this.document.started;
}

Job.prototype._appendToProperty = function (property, value) {
    if (this.document[property] === null || typeof this.document[property] == 'undefined') {
        this.document[property] = value;
    } else {
        this.document[property] += value;
    }

    var data = {}
    data[property] = this.document[property]
    this._save(data)
}

Job.prototype._save = function (data, callback, fallback) {
    var self = this
    var saveId = Math.random();
    this.db.collection('immediate').findAndModify(
        {_id: this.document._id},
        [],
        {$set: data},
        {new: true},
        function (err, doc) {
            if (err || doc === null) {
                self.logger.error('THREAD ' + self.threadName + ':', 'cannot save document', err, doc !== null ? doc.value : '');
                if (typeof fallback != 'undefined') {
                    fallback();
                }
            } else {
                if (typeof callback != 'undefined') {
                    callback(doc.value);
                }
            }
        }
    );
}

Job.prototype._buildCommandArray = function () {
    return this._buildCommand(true);
}

Job.prototype._buildCommand = function (returnAsArray) {
    if (this.nconf.get('sudo:user') && this.nconf.get('sudo:user').length > 0) {
        var args = ['sudo', '-u', this.nconf.get('sudo:user'), '-g', this.nconf.get('sudo:group')];
    } else {
        var args = [];
    }

    args = args.concat(this._hasProperty('nice') ? ['nice', '-n', this.document.nice] : []);

    // if we had command property, use it instead of deprecated interpreter, basepath, executable, args
    if (this._hasProperty('command')) {
        args = args.concat(this.document.command.split(' '));
    } else {
        args = args.concat(this._hasProperty('interpreter') ? [this.document.interpreter] : []);
        if (this._hasProperty('basePath') && this.document.basePath.length > 0) {
            var path = this.document.basePath + '/';
            if (this._hasProperty('executable')) {
                path += this.document.executable;
            }
            args.push(path);
        }
        args = args.concat(this._hasProperty('args') ? this.document.args.split(' ') : []);
    }

    var exe = args.shift();

    if (typeof returnAsArray === 'undefined' || !returnAsArray) {
        return exe + ' ' + args.join(' ')
    } else {
        return [exe, args];
    }
}

Job.prototype._buildThreadName = function (threadIndex) {
    var name = '#' + (threadIndex + 1);

    var threadNames = this.nconf.get('debug:threadNames');
    if (threadNames) {
        var name = threadNames[threadIndex];
    }

    return name;
}

Job.prototype._hasProperty = function (prop) {
    return typeof this.document[prop] !== 'undefined' && this.document[prop] !== null;
}

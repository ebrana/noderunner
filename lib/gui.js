exports = module.exports = Gui;

function Gui(db, nconf, logger, queues, watchdog) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.queues = queues
    this.watchdog = watchdog

    this.timeouts = {};
    this.timeoutsOnEndTime = {};
}

Gui.prototype._initSocket = function () {
    var express = require('express');
    var app = express();
    var listener = app.listen(8001);
    app.use('/', express.static('public'));
    return require('socket.io')(listener);
}

Gui.prototype.run = function () {
    var self = this;
    self.io = self._initSocket();

    self.logger.info('GUI socket.io listens on ' + 8001);

    // INCOMING EVENTS
    // Immediate -- runningJobsList, runningCountChanged, jobFetched, jobCompleted, jobStarted, historyCountIncreased, waitingCountDecreased
    // History --  historyCountDecreased
    // Planned -- waitingCountIncreased

    // on user connected
    self.io.on('connection', function (socket) {
        self.logger.info('GUI: user ' + socket.id + ' connected');

        self.updateRunningList(socket);

        self.watchdog.loadThreadsStats(function (data) {
            self.emit(socket, 'threadsStats', data);
        });

        self.emit(socket, 'threadsCount', self.queues.immediate.getThreads().length);

        self.queues.history.getJobsCount(function(cnt){
            self.emit(socket, 'historyCount', cnt);
        });

        self.queues.immediate.getWaitingJobsCount(function(cnt){
            self.emit(socket, 'waitingCount', cnt);
        });

        self.queues.planned.getJobsCount(function(cnt){
            self.emit(socket, 'plannedCount', cnt);
        });

        socket.on('rerun', function (params) {
            self.logger.verbose('rerun event detected', params);
            self.queues.history.rerunJob(params.id, params.queue);
        })

    });

    self.queues.immediate.on('jobFetched', function (job) {
        self.emitToAll('jobFetched', job);
    });

    self.queues.immediate.on('jobCompleted', function (job) {
        self.emitToAll('jobCompleted', job);
    });

    self.queues.immediate.on('jobStarted', function (job) {
        self.emitToAll('jobStarted', job);
    });

    self.queues.planned.on('waitingCountIncreased', function (diff) {
        self.updateWaitingCount();
    });

    self.queues.immediate.on('waitingCountDecreased', function (diff) {
        self.updateWaitingCount();
    });

    self.queues.immediate.on('historyCountIncreased', function (diff) {
        self.emitToAll('historyCountIncreased', diff);
    });

    self.queues.history.on('historyCountDecreased', function (diff) {
        self.emitToAll('historyCountDecreased', diff);
    });

    self.watchdog.on('newThreadsStat', function (data) {
        self.emitToAll('newThreadsStat', data);
    });

    self.queues.history.on('rerunDone', function (params) {
        self.updateWaitingCount();
    });

    return this;
}

Gui.prototype.updateWaitingCount = function() {
    var self = this;
    if (self.io.sockets.sockets.length > 0) {
        self.queues.immediate.getWaitingJobsCount(function(cnt){
            self.emitToAll('waitingCount', cnt);
        });
    }
}

Gui.prototype.updateRunningList = function (socket) {
    var self = this;

    self.queues.immediate.getJobs(function (data) {
        self.emit(socket, 'runningJobsList', data);
    }, {
        $or: [
            {status: self.nconf.get('statusAlias:fetched')},
            {status: self.nconf.get('statusAlias:running')}
        ]
    });
}


Gui.prototype.updateClientQueue = function (queueName, socket) {
    var self = this;

    self.queues[queueName].getJobs(function (data) {

        data = data.map(function (job) {
            job.queue = queueName;
            return job;
        });

        switch (queueName) {

            case 'immediate':
                self.emit(socket, 'waitingCountChanged', data.reduce(function (sum, job) {
                    return sum + (job.status == 'planed' ? 1 : 0);
                }, 0));

                // dont show done jobs in immediate
                data = data.filter(function (job) {
                    return job.status != 'success' && job.status != 'error' && job.status != 'planed';
                });
                self.emit(socket, 'initial' + queueName + 'Data', data);
                break;

            case 'planned':

                self.emit(socket, 'plannedCountChanged', data.length);
                break;

            case 'history':
                /*self.queues.history.getJobsCount(function(count){
                 self.emit(socket, 'historyCountChanged', count);
                 });*/

                // prepend done jobs from immediate
                self.queues.immediate.getJobs(function (immediateJobs) {
                    immediateJobs = immediateJobs.filter(function (job) {
                        return job.status == 'success' || job.status == 'error';
                    });
                    immediateJobs = immediateJobs.map(function (job) {
                        job.queue = 'immediate';
                        return job;
                    });
                    var jobs = immediateJobs.concat(data);
                    // self.emit(socket, 'initial' + queueName + 'Data', jobs);
                    self.emit(socket, 'historyCountChanged', jobs.length);
                }, socket.queueFilters.history)
                break;
        }

    }, socket.queueFilters[queueName]);
}

Gui.prototype.emitToAll = function(action, params) {
    this.logger.debug('GUI: emitToAll event ' + action)
    this.io.emit(action, params);
}

Gui.prototype.emit = function (socket, action, params, logDetails) {
    this.logger.debug('GUI: emit event ' + action, logDetails ? logDetails : '')
    socket.emit(action, params);
}


Gui.prototype.stop = function () {
    this.io.close();
    this.logger.info('GUI: stopped');
}


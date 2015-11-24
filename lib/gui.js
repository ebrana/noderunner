exports = module.exports = Gui;

function Gui(db, nconf, logger, queues) {
  this.db = db
  this.nconf = nconf
  this.logger = logger
  this.queues = queues
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
  var io   = self._initSocket();

  self.logger.verbose('socket.io listens on ' + 8001);

  // on user connected
  io.on('connection', function (socket) {
    self.logger.info('GUI: user ' + socket.id + ' connected');

    // send initial data
    Object.keys(self.queues).forEach(function (queueName) {
      self.updateClientQueue(queueName, socket);
    });

    // send initial data to top number indicators
    self.emit(socket, 'freeThreadsCountChanged', self.queues.immediate.maxThreadsCount - self.queues.immediate.activeThreadsCount);
    self.emit(socket, 'runningCountChanged', self.queues.immediate.activeThreadsCount);
  });

  // for every queue bind job change updates
  Object.keys(self.queues).forEach(function (queueName) {
    self.queues[queueName].on('jobChanged', function (params) { // {changes:..., newDocument:...}
      io.sockets.sockets.forEach(function(socket) {
        // TODO temporary solution - complete update instead of single document only
        self.updateClientQueue(queueName, socket);
      });
    });
  });

  // update top numbers indicators
  self.queues.immediate.on('freeThreadsCountChanged', function (params) {
    io.sockets.sockets.forEach(function(socket) {
      self.emit(socket, 'freeThreadsCountChanged', params);
    })
  });
  self.queues.immediate.on('runningCountChanged', function (params) {
    io.sockets.sockets.forEach(function(socket) {
      self.emit(socket, 'runningCountChanged', params);
    })
  });
  self.queues.history.on('movedToHistory', function (params) { // {oldDocument:..., newDocument:...}
    io.sockets.sockets.forEach(function(socket) {
      self.emit(socket, 'movedToHistory', params, params.changes);

      // TODO prehodit job v clientovi do jine fronty bez full updatu
      self.updateClientQueue('immediate', socket);
      self.updateClientQueue('history', socket);
    });
  });
  self.queues.planned.on('copiedToImmediate', function (params) { // {oldDocument:..., newDocument:...}
    io.sockets.sockets.forEach(function(socket) {
      self.emit(socket, 'copiedToImmediate', params, params.changes);

      // TODO prehodit job v clientovi do jine fronty bez full updatu
      self.updateClientQueue('immediate', socket);
      self.updateClientQueue('planned', socket);
    });
  });


  return this;
}

Gui.prototype.updateClientQueue = function(queueName, socket) {
  this.queues[queueName].getJobs(data => {
    if (queueName == 'immediate') {
      this.emit(socket, 'waitingCountChanged', data.reduce(function(sum, job){
        return sum + (job.status == 'planed' ? 1 : 0);
      },0));
    } else if (queueName == 'planned') {
      this.emit(socket, 'plannedCountChanged', data.length);
    } else if (queueName == 'history') {
      this.queues.history.getJobsCount(count => {
        this.emit(socket, 'historyCountChanged', count);
      })
    }
    this.emit(socket, 'initial' + queueName + 'Data', data);
  });
}

Gui.prototype.emit = function (socket, action, params, logDetails) {
  this.logger.verbose('GUI: emit event ' + action, logDetails ? logDetails : '')
  socket.emit(action, params);
}


Gui.prototype.stop = function () {
  this.logger.info('GUI: stopped');
}


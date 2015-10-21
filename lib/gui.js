exports = module.exports = Gui;

function Gui(db, nconf, logger, queues) {
  this.db = db
  this.nconf = nconf
  this.logger = logger
  this.queues = queues
  this.initialQueueData = {};
}

Gui.prototype.run = function () {
  var self = this;

  // init express and socket.io
  var express = require('express');
  var app = express();
  var listener = app.listen(8001);
  app.use('/', express.static('public'));
  var io = require('socket.io')(listener);
  self.logger.verbose('socket.io listens on ' + 8001);

  // on user connected
  io.on('connection', function (socket) {
    self.logger.info('GUI: user ' + socket.id + ' connected');

    // send initial data
    Object.keys(self.queues).forEach(function (queueName) {
      self.queues[queueName].getJobs(function (data) {
        self.emit(socket, 'initial' + queueName + 'Data', data);
        if (queueName == 'immediate') {
          self.emit(socket, 'waitingCountChanged', data.reduce(function(sum, job){
            return sum + (job.status == 'planed' ? 1 : 0);
          },0));
        } else if (queueName == 'planned') {
          self.emit(socket, 'plannedCountChanged', data.length);
        } else if (queueName == 'history') {
          self.emit(socket, 'historyCountChanged', data.length);
        }
      });
    });

    self.emit(socket, 'freeThreadsCountChanged', self.queues.immediate.maxThreadsCount - self.queues.immediate.activeThreadsCount);
    self.emit(socket, 'runningCountChanged', self.queues.immediate.activeThreadsCount);
  });

  // for every queue
  // TODO add periodic update
  Object.keys(self.queues).forEach(function (queueName) {

    // job changed
    // TODO update single document only
    // TODO reset periodic update
    self.queues[queueName].on('jobChanged', function (params) { // {changes:..., newDocument:...}
      io.sockets.sockets.forEach(function(socket) {
        self.updateClientQueue(queueName, socket);
      });
    });
  });

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
      // TODO prehodit job v clientovi do jine fronty bez full updatu
      self.updateClientQueue('immediate', socket);
      self.updateClientQueue('planned', socket);

      self.emit(socket, 'copiedToImmediate', params, params.changes);
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
      this.emit(socket, 'historyCountChanged', data.length);
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


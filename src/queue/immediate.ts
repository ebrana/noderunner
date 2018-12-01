var Job = require('../job')
var EventEmitter = require('events').EventEmitter
var util = require('util')
var isRunning = require('is-running')

exports = module.exports = Immediate

function Immediate(db, nconf, logger) {
  EventEmitter.call(this)

  this.db = db
  this.nconf = nconf
  this.logger = logger

  this.timeout = null
  this.running = false
  this.lastFinishedCallback = null
  this.lastCheckTime = null
  this.isStuckJobsCheckPlanned = false

  // entry for every thread with null value when free and non-null ('booked' or job _id when currently used)
  this.threads = []
  for (var i = 0; i < nconf.get('immediate:maxThreadsCount'); i++) {
    this.threads[i] = null
  }

  // store job timing stats (stared, finished, duration) for analysis in watchdog queue
  this.jobStats = {}
}

util.inherits(Immediate, EventEmitter)

Immediate.prototype.run = function() {
  var self = this

  this.running = true
  this._removeStuckRunningJobs(true)
  this._check()

  return this
}

Immediate.prototype._removeStuckRunningJobs = function(evenWithoutPid) {
  var self = this
  self.logger.warn(
    'IMMEDIATE: try to move stuck running/fetched jobs - evenWithoutPid=',
    evenWithoutPid
  )
  self.db
    .collection('immediate')
    .find({ $or: [{ status: 'running' }, { status: 'fetched' }] })
    .each(function(err, doc) {
      if (doc != null) {
        if ((evenWithoutPid && !doc.pid) || (doc.pid && !isRunning(doc.pid))) {
          self.db.collection('immediate').remove(doc)
          self.logger.warn(
            'IMMEDIATE: moving stuck running/fetched job with PID and _id: ',
            doc.pid,
            doc._id.toString()
          )
          delete doc._id
          doc.status = 'stucked'
          doc.finished = Math.floor(new Date().getTime() / 1000)
          self.db.collection('history').insert(doc)
        }
      }
    })
}

Immediate.prototype._check = function() {
  var self = this
  self.lastCheckTime = Date.now()

  clearTimeout(self.timeout)

  // if queue is already stopped, do nothing
  if (this.running == false) {
    if (!this.isAnyBookedThread() && self.lastFinishedCallback) {
      self.lastFinishedCallback()
    }
    return
  }

  // try to book any free thread
  var threadIndex = self.bookThread()

  // if available - do nothing - _check will be called in thread end callback
  if (threadIndex === null) {
    self.logger.debug('IMMEDIATE: no available thread, waiting...')
    return
  }

  // get next job in immediate queue
  self.fetchNextJob(
    threadIndex,
    function(job) {
      self.rebookThread(threadIndex, job.document._id)

      self.emit('jobFetched', job.document)
      self.emit('waitingCountDecreased', 1)

      // job found - save stats and run immediately
      self.createJobStat(job, threadIndex)
      job.run(
        function() {
          self.updateJobStat(job, threadIndex)

          // job done - try fetch and run another immediately
          self.releaseThread(threadIndex)
          self.emit('jobCompleted', job.document)
          self.emit('historyCountIncreased', 1)

          self._check()
        },
        function() {
          // cannot save document, try wait for another round
          self.releaseThread(threadIndex)
          self.emit('jobCompleted', job.document)
          self.emit('historyCountIncreased', 1)

          self.logger.error(
            'IMMEDIATE: error during job run, sleep for ' +
              self.nconf.get('immediate:interval') / 1000 +
              ' secs',
            job.document
          )

          // plan stuck jobs control after half hour - should be enough for mongo to be up again
          if (!self.isStuckJobsCheckPlanned) {
            self.logger.warn('IMMEDIATE: planning stucked jobs check after one hour')
            self.isStuckJobsCheckPlanned = true
            setTimeout(function() {
              self.isStuckJobsCheckPlanned = false
              self._removeStuckRunningJobs(false)
            }, 30 * 60 * 1000)
          } else {
            self.logger.warn('IMMEDIATE: stucked jobs check already planned')
          }

          clearTimeout(self.timeout)
          self.timeout = setTimeout(function() {
            self._check()
          }, self.nconf.get('immediate:interval'))
        },
        function(document) {
          self.emit('jobStarted', document)
        }
      )

      // job done - try fetch and run another immediately without wait
      self._check()
    },
    function(e) {
      // no job to fetch or error
      self.releaseThread(threadIndex)

      if (e) {
        self.logger.error(
          'IMMEDIATE: error during fetch, sleep for ' +
            self.nconf.get('immediate:interval') / 1000 +
            ' secs'
        )
      } else {
        self.logger.verbose(
          'IMMEDIATE: nothing to run, sleep for ' +
            self.nconf.get('immediate:interval') / 1000 +
            ' secs'
        )
      }

      clearTimeout(self.timeout)
      self.timeout = setTimeout(function() {
        self._check()
      }, self.nconf.get('immediate:interval'))
    }
  )
}

Immediate.prototype.createJobStat = function(job, threadIndex) {
  var id = job.document._id
  if (!this.jobStats[id]) {
    this.jobStats[id] = {
      started: job.document.started,
      thread: threadIndex
    }
  }
}

Immediate.prototype.updateJobStat = function(job, threadIndex) {
  var id = job.document._id
  // job stat not found so it was already removed - create without started
  if (!this.jobStats[id]) {
    this.jobStats[id] = {
      started: null,
      thread: threadIndex
    }
  }
  this.jobStats[id].finished = Date.now() / 1000
}

// return index of lowest free thread and lock it
Immediate.prototype.bookThread = function() {
  for (var i = 0; i < this.threads.length; i++) {
    if (this.threads[i] === null) {
      this.logger.silly('IMMEDIATE: booked thread ' + i)
      this.threads[i] = 'booked'
      return i
    }
  }
  return null
}

Immediate.prototype.fetchNextJob = function(threadIndex, callback, fallback) {
  var self = this

  var changes = {
    status: self.nconf.get('statusAlias:fetched'),
    started: new Date().getTime() / 1000,
    thread: threadIndex
  }

  try {
    this.db
      .collection('immediate')
      .findAndModify(
        { status: self.nconf.get('statusAlias:planned') },
        [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']],
        { $set: changes },
        { new: true },
        function(err, doc) {
          if (err) {
            self.logger.error('IMMEDIATE: cannot load job from queue', err)
            fallback(false)
          } else if (!doc.value) {
            // no next job found in immediate queue
            fallback(false)
          } else {
            // next job found in immediate queue
            var job = new Job(self)
            job.initByDocument(doc.value)
            callback(job)
          }
        }
      )
  } catch (e) {
    fallback(e)
  }
}

Immediate.prototype.stop = function(callback) {
  if (!this.isAnyBookedThread() && typeof callback == 'function') {
    callback()
    return
  }

  this.lastFinishedCallback = callback
  this.logger.info('IMMEDIATE: stopped')
  this.running = false
  clearTimeout(this.timeout)
}

Immediate.prototype.resetFinishedJobStats = function() {
  for (var id in this.jobStats) {
    if (this.jobStats[id].finished) {
      delete this.jobStats[id]
    } else {
      this.jobStats[id].started = Date.now() / 1000
    }
  }
}

Immediate.prototype.rebookThread = function(threadIndex, jobId) {
  this.threads[threadIndex] = jobId
}

Immediate.prototype.releaseThread = function(index) {
  this.logger.silly('IMMEDIATE: released thread ' + index)
  this.threads[index] = null
}

Immediate.prototype.getThreads = function() {
  return this.threads
}

Immediate.prototype.getRunningThreads = function() {
  return this.threads.filter(function(t) {
    return t !== null && t != 'booked'
  })
}

Immediate.prototype.getBookedThreads = function() {
  return this.threads.filter(function(t) {
    return t !== null
  })
}

Immediate.prototype.isAnyBookedThread = function() {
  return this.getBookedThreads().length > 0
}

Immediate.prototype.getThreadsInfo = function(highlightIndex) {
  return (
    '[' +
    this.threads
      .map(function(t, i) {
        return typeof highlightIndex != 'undefined' && highlightIndex == i
          ? 'o'
          : t === null
          ? '-'
          : 'x'
      })
      .join('') +
    ']'
  )
}

Immediate.prototype.getWaitingJobsCount = function(callback) {
  this.db
    .collection('immediate')
    .count({ status: this.nconf.get('statusAlias:planned') }, function(err, count) {
      callback(count)
    })
}

Immediate.prototype.getJobs = function(callback, filter) {
  this.db
    .collection('immediate')
    .find(filter, {
      limit: 100,
      sort: [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']]
    })
    .toArray(function(err, docs) {
      if (err) {
        this.logger.error(err)
      } else {
        return callback(docs)
      }
    })
}

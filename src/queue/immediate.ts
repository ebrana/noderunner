import { EventEmitter } from 'events'

var Job = require('../job')
var isRunning = require('is-running')

export default class Immediate extends EventEmitter {
  db
  nconf
  logger
  timeout
  running
  lastFinishedCallback
  lastCheckTime
  isStuckJobsCheckPlanned
  threads
  jobStats

  constructor(db, nconf, logger) {
    super()

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

  run() {
    this.running = true
    this._removeStuckRunningJobs(true)
    this._check()

    return this
  }

  private _removeStuckRunningJobs(evenWithoutPid) {
    this.logger.warn('try to move stuck running/fetched jobs - evenWithoutPid=', evenWithoutPid)
    this.db
      .collection('immediate')
      .find({ $or: [{ status: 'running' }, { status: 'fetched' }] })
      .each((err, doc) => {
        if (doc != null) {
          if ((evenWithoutPid && !doc.pid) || (doc.pid && !isRunning(doc.pid))) {
            this.db.collection('immediate').remove(doc)
            this.logger.warn(
              'moving stuck running/fetched job with PID and _id: ',
              doc.pid,
              doc._id.toString()
            )
            delete doc._id
            doc.status = 'stucked'
            doc.finished = Math.floor(new Date().getTime() / 1000)
            this.db.collection('history').insert(doc)
          }
        }
      })
  }

  private _check() {
    this.lastCheckTime = Date.now()

    clearTimeout(this.timeout)

    // if queue is already stopped, do nothing
    if (this.running == false) {
      if (!this.isAnyBookedThread() && this.lastFinishedCallback) {
        this.lastFinishedCallback()
      }
      return
    }

    // try to book any free thread
    var threadIndex = this.bookThread()

    // if available - do nothing - _check will be called in thread end callback
    if (threadIndex === null) {
      this.logger.debug('no available thread, waiting...')
      return
    }

    // get next job in immediate queue
    this.fetchNextJob(
      threadIndex,
      job => {
        this.rebookThread(threadIndex, job.document._id)

        this.emit('jobFetched', job.document)
        this.emit('waitingCountDecreased', 1)

        // job found - save stats and run immediately
        this.createJobStat(job, threadIndex)
        job.run(
          () => {
            this.updateJobStat(job, threadIndex)

            // job done - try fetch and run another immediately
            this.releaseThread(threadIndex)
            this.emit('jobCompleted', job.document)
            this.emit('historyCountIncreased', 1)

            this._check()
          },
          () => {
            // cannot save document, try wait for another round
            this.releaseThread(threadIndex)
            this.emit('jobCompleted', job.document)
            this.emit('historyCountIncreased', 1)

            this.logger.error(
              'error during job run, sleep for ' +
                this.nconf.get('immediate:interval') / 1000 +
                ' secs',
              job.document
            )

            // plan stuck jobs control after half hour - should be enough for mongo to be up again
            if (!this.isStuckJobsCheckPlanned) {
              this.logger.warn('planning stucked jobs check after one hour')
              this.isStuckJobsCheckPlanned = true
              setTimeout(() => {
                this.isStuckJobsCheckPlanned = false
                this._removeStuckRunningJobs(false)
              }, 30 * 60 * 1000)
            } else {
              this.logger.warn('stucked jobs check already planned')
            }

            clearTimeout(this.timeout)
            this.timeout = setTimeout(() => {
              this._check()
            }, this.nconf.get('immediate:interval'))
          },
          document => {
            this.emit('jobStarted', document)
          }
        )

        // job done - try fetch and run another immediately without wait
        this._check()
      },
      e => {
        // no job to fetch or error
        this.releaseThread(threadIndex)

        if (e) {
          this.logger.error(
            'error during fetch, sleep for ' + this.nconf.get('immediate:interval') / 1000 + ' secs'
          )
        } else {
          this.logger.verbose(
            'nothing to run, sleep for ' + this.nconf.get('immediate:interval') / 1000 + ' secs'
          )
        }

        clearTimeout(this.timeout)
        this.timeout = setTimeout(() => {
          this._check()
        }, this.nconf.get('immediate:interval'))
      }
    )
  }

  createJobStat(job, threadIndex) {
    var id = job.document._id
    if (!this.jobStats[id]) {
      this.jobStats[id] = {
        started: job.document.started,
        thread: threadIndex
      }
    }
  }

  updateJobStat(job, threadIndex) {
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
  bookThread() {
    for (var i = 0; i < this.threads.length; i++) {
      if (this.threads[i] === null) {
        this.logger.silly('booked thread ' + i)
        this.threads[i] = 'booked'
        return i
      }
    }
    return null
  }

  fetchNextJob(threadIndex, callback, fallback) {
    var changes = {
      status: this.nconf.get('statusAlias:fetched'),
      started: new Date().getTime() / 1000,
      thread: threadIndex
    }

    try {
      this.db
        .collection('immediate')
        .findAndModify(
          { status: this.nconf.get('statusAlias:planned') },
          [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']],
          { $set: changes },
          { new: true },
          (err, doc) => {
            if (err) {
              this.logger.error('cannot load job from queue', err)
              fallback(false)
            } else if (!doc.value) {
              // no next job found in immediate queue
              fallback(false)
            } else {
              // next job found in immediate queue
              var job = new Job(this)
              job.initByDocument(doc.value)
              callback(job)
            }
          }
        )
    } catch (e) {
      fallback(e)
    }
  }

  stop(callback) {
    if (!this.isAnyBookedThread() && typeof callback == 'function') {
      callback()
      return
    }

    this.lastFinishedCallback = callback
    this.logger.info('stopped')
    this.running = false
    clearTimeout(this.timeout)
  }

  resetFinishedJobStats() {
    for (var id in this.jobStats) {
      if (this.jobStats[id].finished) {
        delete this.jobStats[id]
      } else {
        this.jobStats[id].started = Date.now() / 1000
      }
    }
  }

  rebookThread(threadIndex, jobId) {
    this.threads[threadIndex] = jobId
  }

  releaseThread(index) {
    this.logger.silly('released thread ' + index)
    this.threads[index] = null
  }

  getThreads() {
    return this.threads
  }

  getRunningThreads() {
    return this.threads.filter(t => {
      return t !== null && t != 'booked'
    })
  }

  getBookedThreads() {
    return this.threads.filter(t => {
      return t !== null
    })
  }

  isAnyBookedThread() {
    return this.getBookedThreads().length > 0
  }

  getThreadsInfo(highlightIndex) {
    return (
      '[' +
      this.threads
        .map((t, i) => {
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

  getWaitingJobsCount(callback) {
    this.db
      .collection('immediate')
      .count({ status: this.nconf.get('statusAlias:planned') }, (err, count) => {
        callback(count)
      })
  }

  getJobs(callback, filter) {
    this.db
      .collection('immediate')
      .find(filter, {
        limit: 100,
        sort: [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']]
      })
      .toArray((err, docs) => {
        if (err) {
          this.logger.error(err)
        } else {
          return callback(docs)
        }
      })
  }
}

import { EventEmitter } from 'events'

var Job = require('../job')

export default class Planned extends EventEmitter {
  db
  nconf
  logger
  timeout
  lastCheckTime

  constructor(db, nconf, logger) {
    super()
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.timeout = null
  }

  getJobs(callback, filter) {
    this.db
      .collection('planned')
      .find(filter, { limit: 100 })
      .toArray((err, docs) => {
        if (err) {
          this.logger.error(err)
        } else {
          return callback(docs)
        }
      })
  }

  getJobsCount(callback) {
    this.db.collection('planned').count((err, count) => {
      callback(count)
    })
  }

  checkRunningJobBySource(id, callback) {
    this.db
      .collection('immediate')
      .find({
        sourceId: id,
        $or: [{ status: 'running' }, { status: 'fetched' }, { status: 'planed' }]
      })
      .toArray((err, docs) => {
        callback(docs.length > 0)
      })
  }

  run() {
    // load planned jobs and move them one by one to immediate
    this.db
      .collection('planned')
      .find()
      .toArray((err, docs) => {
        if (typeof docs !== 'undefined' && docs && docs.length > 0) {
          var dueJobsCount = 0
          var checkIntervalLength = this.nconf.get('planned:interval')
          var checkIntervalStart = this.lastCheckTime
            ? this.lastCheckTime
            : Date.now() - checkIntervalLength
          var checkIntervalEnd = (this.lastCheckTime = Date.now())

          docs.forEach(doc => {
            var job = new Job(this)
            job.initByDocument(doc)

            if (
              job.isDue(Math.floor(checkIntervalStart / 1000), Math.floor(checkIntervalEnd / 1000))
            ) {
              // concurrencyMode skip runs planned job only if last instance is not running
              switch (doc.concurrencyMode) {
                case 'skip':
                  dueJobsCount++
                  this.checkRunningJobBySource(doc._id, isRunning => {
                    if (isRunning) {
                      this.logger.warn(
                        'job ' +
                          doc._id +
                          ' skipped due to concurrence mode (same job already running)'
                      )
                    } else {
                      this.logger.debug('moving job ' + job.document._id /*job.toString()*/)
                      job.copyToImmediate(() => {
                        this.emit('waitingCountIncreased', 1)
                      })
                    }
                  })
                  break
                case 'kill':
                  // TODO kill all running jobs with same source
                  this.logger.warn(
                    'concurrency mode kill is not supported yet - using allow instead'
                  )
                case 'wait':
                  // TODO do nothing and try again in next round
                  this.logger.warn(
                    'concurrency mode wait is not supported yet - using allow instead'
                  )
                case 'allow':
                default:
                  this.logger.debug('moving job ' + job.document._id /*job.toString()*/)
                  dueJobsCount++
                  job.copyToImmediate(() => {
                    this.emit('waitingCountIncreased', 1)
                  })
              }

              // TODO if not repetitive=true, delete original
            }
          })
          if (dueJobsCount > 0) {
            this.logger.info('moving ' + dueJobsCount + ' due planned jobs to immediate queue')
          } else {
            this.logger.verbose(
              'no due job, sleep for ' + this.nconf.get('planned:interval') / 1000 + 's'
            )
          }
        } else {
          this.logger.verbose(
            'no planed job, sleep for ' + this.nconf.get('planned:interval') / 1000 + 's'
          )
        }

        // timeout must be exactly 1min - otherwise some jobs wont run or run twice a time
        this.timeout = setTimeout(() => {
          this.run()
        }, this.nconf.get('planned:interval'))
      })
    return this
  }

  stop() {
    this.logger.info('stopped')
    clearTimeout(this.timeout)
  }
}

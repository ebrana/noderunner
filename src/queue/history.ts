import { EventEmitter } from 'events'

var Job = require('../job')
var ObjectID = require('mongodb').ObjectID

export default class History extends EventEmitter {
  db
  nconf
  logger
  timeout

  constructor(db, nconf, logger) {
    super()
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.timeout = null
  }

  getJobs(callback, filter) {
    this.logger.info('filtering GUI ', filter)
    this.db
      .collection('history')
      .find(filter, { limit: 100, sort: [['finished', 'desc']] })
      .toArray((err, docs) => {
        if (err) {
          this.logger.error(err)
        } else {
          return callback(docs)
        }
      })
  }

  rerunJob(id, queue) {
    this.db.collection(queue).findOne({ _id: new ObjectID(id) }, (err, doc) => {
      if (doc != null) {
        var job = new Job(this)
        job.initByDocument(doc)
        job.rerun()
      }
    })
  }

  getJobsCount(callback) {
    this.db.collection('history').count((err, count) => {
      callback(count)
    })
  }

  run() {
    // load done immediate jobs and move them to history one by one
    this.db
      .collection('immediate')
      .find({
        status: {
          $in: [this.nconf.get('statusAlias:success'), this.nconf.get('statusAlias:error')]
        },
        finished: { $lt: new Date().valueOf() / 1000 - this.nconf.get('history:maxAge') / 1000 }
      })
      .toArray((err, docs) => {
        if (typeof docs !== 'undefined' && docs && docs.length > 0) {
          this.logger.info('moving ' + docs.length + ' old jobs from immediate queue to history')
          docs.forEach(doc => {
            var job = new Job(this)
            job.initByDocument(doc)
            job.moveToHistory()
            this.logger.debug('moving job ' + job.document._id)
          })
        } else {
          this.logger.verbose(
            'nothing to move, sleep for ' + this.nconf.get('history:interval') / 1000 + ' secs'
          )
        }

        // delete history items older than cleanHours
        this.clean(this.nconf.get('history:cleanHours'))

        // run again after specified interval
        this.timeout = setTimeout(() => {
          this.run()
        }, this.nconf.get('history:interval'))
      })
    return this
  }

  clean(hoursCount) {
    var lowerThanTime = Math.floor(new Date().getTime() / 1000) - hoursCount * 60 * 60
    this.db
      .collection('history')
      .deleteMany({ finished: { $lt: lowerThanTime } }, (err, result) => {
        if (err) {
          this.logger.error('clean finished<' + lowerThanTime + ' failed', err)
        } else {
          this.logger.info(
            'clean finished<' +
              lowerThanTime +
              ' (' +
              this.nconf.get('history:cleanHours') +
              ' hours) success - ' +
              result.deletedCount +
              ' deleted'
          )
          this.emit('historyCountDecreased', result.deletedCount)
        }
      })
  }

  stop() {
    this.logger.info('stopped')
    clearTimeout(this.timeout)
  }
}

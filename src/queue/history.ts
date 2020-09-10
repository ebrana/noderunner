import { ObjectID } from 'mongodb'
import Job from '../job'
import Queue from '../queue'

export default class History extends Queue {
  private timeout: NodeJS.Timeout

  constructor(db, nconf, logger) {
    super(db, nconf, logger)
    this.timeout = null
  }

  public getJobs(callback, filter) {
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

  public rerunJob(id, queue) {
    this.db.collection(queue).findOne({ _id: new ObjectID(id) }, (err, doc) => {
      if (doc != null) {
        const job = new Job(this)
        job.initByDocument(doc)
        job.rerun()
      }
    })
  }

  public getJobsCount(callback) {
    this.db.collection('history').count((err, count) => {
      callback(count)
    })
  }

  public run() {
    // load done immediate jobs and move them to history one by one
    this.db
      .collection('immediate')
      .find({
        finished: { $lt: new Date().valueOf() / 1000 - this.nconf.get('history:maxAge') / 1000 },
        status: {
          $in: [this.nconf.get('statusAlias:success'), this.nconf.get('statusAlias:error')]
        }
      })
      .toArray((err, docs) => {
        if (typeof docs !== 'undefined' && docs && docs.length > 0) {
          this.logger.info('moving ' + docs.length + ' old jobs from immediate queue to history')
          docs.forEach(doc => {
            const job = new Job(this)
            job.initByDocument(doc)
            job.moveToHistory()
            this.logger.debug('moving job ' + job.document._id)
          })
        } else {
          this.logger.verbose(
            'nothing to move, sleep for ' + this.nconf.get('history:interval') / 1000 + ' secs'
          )
        }

        // delete history items
        this.clean()

        // run again after specified interval
        this.timeout = setTimeout(() => {
          this.run()
        }, this.nconf.get('history:interval'))
      })
    return this
  }

  public clean() {
    this.cleanFlush(this.nconf.get('history:cleanHours'), {$ne: 'error'}); // clean all without errors
    this.cleanFlush(this.nconf.get('history:cleanErrorsHours'), {$eq: 'error'}); // clean errors
  }

  public stop() {
    this.logger.info('stopped')
    clearTimeout(this.timeout)
  }

  protected cleanFlush(hoursCount: number, statusFilter: any) {
    const lowerThanTime = Math.floor(new Date().getTime() / 1000) - hoursCount * 60 * 60
    this.db
      .collection('history')
      .deleteMany({ finished: { $lt: lowerThanTime }, status: statusFilter }, (err, result) => {
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
}

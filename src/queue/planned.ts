import * as parser from 'cron-parser'
import { ObjectID } from 'mongodb'
import Job from '../job'
import Queue from '../queue'

export default class Planned extends Queue {
  private timeout: NodeJS.Timeout
  private lastCheckTime: number

  constructor(db, nconf, logger) {
    super(db, nconf, logger)
    this.timeout = null
  }

  public insertJob(document, callback, fallback) {
    try {
      parser.parseExpression(document.schedule)
      this.db
        .collection('planned')
        .insertOne(document)
        .then(() => {
          callback()
        })
        .catch(error => {
          fallback(error.message, error)
        })
    } catch (error) {
      fallback(error.message, error)
    }
  }

  public updateJob(id, document, callback, fallback) {
    try {
      parser.parseExpression(document.schedule)
      this.db
        .collection('planned')
        .updateOne({ "_id": new ObjectID(id) }, document)
        .then(() => {
          callback()
        })
        .catch(error => {
          fallback(error.message, error)
        })
    } catch (error) {
      fallback(error.message, error)
    }
  }

  public deleteJob(id: string, callback, fallback) {
    this.db
      .collection('planned')
      .deleteOne({ "_id": new ObjectID(id) })
      .then(() => {
        callback()
      })
      .catch(error => {
        fallback(error.message, error)
      })
  }

  public getJobs(callback, filter) {
    this.db
      .collection('planned')
      .find(filter)
      .limit(100)
      .toArray((err, docs) => {
        if (err) {
          this.logger.error(err)
        } else {
          return callback(docs)
        }
      })
  }

  public getJobsCount(callback) {
    this.db
      .collection('planned')
      .count({})
      .then(count => {
        callback(count)
      })
      .catch(error => {
        this.logger.error(error.message, error)
      })
  }

  public checkRunningJobBySource(id, callback) {
    try {
      this.db
        .collection('immediate')
        .find({
          $or: [{ status: 'running' }, { status: 'fetched' }, { status: 'planed' }],
          sourceId: id
        })
        .toArray((err, docs) => {
          callback(docs.length > 0)
        })
    } catch (error) {
      this.logger.error(error.message, error)
    }
  }

  public run() {
    try {
      // load planned jobs and move them one by one to immediate
      this.db
        .collection('planned')
        .find()
        .toArray((err, docs) => {
          if (typeof docs !== 'undefined' && docs && docs.length > 0) {
            let dueJobsCount = 0
            const checkIntervalLength = this.nconf.get('planned:interval')
            const checkIntervalStart = this.lastCheckTime
              ? this.lastCheckTime
              : Date.now() - checkIntervalLength
            const checkIntervalEnd = (this.lastCheckTime = Date.now())

            docs.forEach(doc => {
              const job = new Job(this)
              job.initByDocument(doc)

              if (
                job.isDue(
                  Math.floor(checkIntervalStart / 1000),
                  Math.floor(checkIntervalEnd / 1000)
                )
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
              'no planned job, sleep for ' + this.nconf.get('planned:interval') / 1000 + 's'
            )
          }

          // timeout must be exactly 1min - otherwise some jobs wont run or run twice a time
          this.timeout = setTimeout(() => {
            this.run()
          }, this.nconf.get('planned:interval'))
        })
    } catch (error) {
      this.logger.error(error.message, error)
    }
    return this
  }

  public stop() {
    this.logger.info('stopped')
    clearTimeout(this.timeout)
  }
}

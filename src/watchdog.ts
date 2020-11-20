import { EventEmitter } from 'events'
import { Db } from 'mongodb'
import { Provider as Nconf } from 'nconf'
import * as os from 'os'
import { Logger } from './logger'
import Immediate from './queue/immediate'

interface IThreadStat {
  total: number
  byThread: number[]
  intervalFrom?: number
  intervalTo?: number
}

export default class Watchdog extends EventEmitter {
  private db: Db
  private nconf: Nconf
  private logger: Logger
  private interval: NodeJS.Timeout
  private intervalThreadeStats: NodeJS.Timeout
  private immediateQueue: Immediate
  private badSamplesLimit: number
  private badSamplesCount: number
  private lastSample: number
  private lastLoadCalculation: number
  private emailSent: boolean
  private emailResetInterval: NodeJS.Timeout
  private email2Sent: boolean
  private running: boolean

  constructor(db, nconf, logger) {
    super()

    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.interval = null
    this.immediateQueue = null

    this.badSamplesLimit = nconf.get('watchdog:badSamplesLimit')
    this.badSamplesCount = 0
    this.lastSample = null

    this.lastLoadCalculation = Date.now() / 1000

    this.emailSent = false
    this.emailResetInterval = null
    this.email2Sent = false
  }

  public run(immediateQueue) {
    this.immediateQueue = immediateQueue

    // check repeatedly congestion and last immediate check time
    this.interval = setInterval(() => {
      this.runCongestionCheck()
    }, this.nconf.get('watchdog:interval'))

    // calculate load
    this.intervalThreadeStats = setInterval(() => {
      this.runThreadsStatsCheck()
    }, this.nconf.get('watchdog:loadCheckInterval'))

    // send info email max once per hour
    this.emailResetInterval = setInterval(() => {
      this.emailSent = false
      this.email2Sent = false
    }, 60 * 60 * 1000)

    return this
  }

  public loadThreadsStats(secondsBack, callback) {
    this.db
      .collection('load')
      .find({ intervalTo: { $gt: Date.now() / 1000 - secondsBack } })
      .toArray((err, data) => {
        if (!err) {
          callback(data)
        }
      })
  }

  public stop() {
    this.logger.info('stopped')
    this.running = false
    clearInterval(this.interval)
    clearInterval(this.intervalThreadeStats)
    clearInterval(this.emailResetInterval)
  }

  private runCongestionCheck() {
    // check immediate jobs count
    this.db.collection('immediate').count(
      {
        $or: [
          { status: this.nconf.get('statusAlias:planned') },
          { status: this.nconf.get('statusAlias:running') }
        ]
      },
      (err, count) => {
        // actual count bigger than the last one - increment counter
        if (count > this.lastSample && this.lastSample !== null) {
          this.badSamplesCount++
        } else if (count < this.lastSample) {
          this.badSamplesCount = 0
        }

        const percents = Math.round((this.badSamplesCount / this.badSamplesLimit) * 100)
        if (percents < 100) {
          this.logger.verbose('danger of congestion is on ' + percents + '%')
        }
        this.logger.debug(
          'sample=' +
            count +
            ' badSamplesLimit=' +
            this.badSamplesLimit +
            ' badSamplesCount=' +
            this.badSamplesCount +
            ' lastSample=' +
            this.lastSample
        )

        // if counter bigger than limit - send email
        if (this.badSamplesCount >= this.badSamplesLimit) {
          if (!this.emailSent) {
            this.sendEmail(
              'Noderunner immediate queue planned/running jobs count is growing rapidly. Danger of congestion! Please repair problem and restart noderuner service.',
              () => {
                this.emailSent = true
              }
            )
          }
          this.logger.warn(
            'Immediate planned/running jobs count is growing rapidly! Danger of congestion!'
          )
          return this
        }

        this.lastSample = count
      }
    )

    if (this.immediateQueue.getLastCheckTime() !== null) { // check immediate is running
      // check last immediate check time
      const sinceLastCheck = Date.now() - this.immediateQueue.getLastCheckTime()
      this.logger.debug('last immediate queue check time ' + sinceLastCheck + 'ms ago')
      if (sinceLastCheck > this.nconf.get('immediate:interval') * 3) {
        this.logger.warn(
          'Time since last immediate queue check is more than 3 times greater than set check interval!'
        )
        if (!this.email2Sent) {
          this.sendEmail(
            'Time since last immediate queue check is more than 3 times greater than set check interval (' +
            sinceLastCheck +
            '>' +
            this.nconf.get('immediate:interval') * 3 +
            ')! Immediate queue is probably not working.',
            () => {
              this.email2Sent = true
            }
          )
        }
      }
    }
  }

  private runThreadsStatsCheck() {
    const threadStat = this.calculateThreadsStat()

    const interval = this.nconf.get('watchdog:loadCheckInterval') / 1000
    threadStat.intervalTo = Date.now() / 1000
    threadStat.intervalFrom = threadStat.intervalTo - interval
    this.db.collection('load').insertOne(threadStat).catch(error => {
      this.logger.error(error.message, error)
    })
    this.emit('newThreadsStat', threadStat)

    this.logger.verbose(
      'average load for last ' +
        interval +
        's: ' +
        threadStat.total +
        ' [' +
        threadStat.byThread.join(',') +
        ']'
    )
  }

  private sendEmail(text, cb) {
    const nodemailer = require('nodemailer')
    const smtpTransport = require('nodemailer-smtp-transport')

    if (this.nconf.get('watchdog:email') !== null) {
      nodemailer.createTransport(smtpTransport({ host: 'mail.ebrana.cz', port: 25 })).sendMail(
        {
          from: this.nconf.get('watchdog:email:from'),
          subject: 'NodeRunner watchdog - ' + os.hostname(),
          text,
          to: this.nconf.get('watchdog:email:to')
        },
        (error, info) => {
          if (error) {
            this.logger.error('cannot send warning email', error)
          } else {
            cb(info)
            this.logger.verbose('warning email sent ', info.response)
          }
        }
      )
    }
  }

  private calculateThreadsStat(): IThreadStat {
    const intervalDuration = Date.now() / 1000 - this.lastLoadCalculation
    const intervalFrom = this.lastLoadCalculation
    const intervalTo = Date.now() / 1000

    this.lastLoadCalculation = Date.now() / 1000

    // get all jobs done or started in this interval and truncate them with interval boundaries before duration calculation
    let total = 0
    let byThread = this.immediateQueue.getThreads().map(() => {
      return 0
    })

    for (const id in this.immediateQueue.getJobStats()) {
      // TODO nahradit Object.assign az nebudeme pouzivat node v0.x.x
      const stat = JSON.parse(JSON.stringify(this.immediateQueue.getJobStats()[id]))
      // finished not set, use intervalTo
      if (!stat.hasOwnProperty('finished') || stat.finished === null) {
        stat.finished = intervalTo
      }

      // started not set, use intervalFrom
      if (!stat.hasOwnProperty('started') || stat.started === null) {
        stat.started = intervalFrom
      }

      stat.duration = stat.finished - stat.started

      total += stat.duration
      if (!byThread[stat.thread]) {
        byThread[stat.thread] = 0
      }
      byThread[stat.thread] += stat.duration

      // self.logger.debug('truncated job stats '+id, stat);
    }

    total = Math.round((total / intervalDuration) * 1000) / 1000
    byThread = byThread.map(t => {
      return Math.round((t / intervalDuration) * 1000) / 1000
    })

    this.immediateQueue.resetFinishedJobStats()
    return {
      byThread,
      total
    }
  }

  // z vykonnostnich duvodu jiz nepouzivane
  private _calculateLoadMongo(forSeconds, callback) {
    const intervalTo = Date.now() / 1000
    const intervalFrom = intervalTo - forSeconds
    const intervalDuration = intervalTo - intervalFrom

    // load done jobs contained in measured interval
    this.db
      .collection('history')
      .find({
        $or: [
          { $and: [{ finished: { $gt: intervalFrom } }, { finished: { $lt: intervalTo } }] },
          { $and: [{ started: { $gt: intervalFrom } }, { started: { $lt: intervalTo } }] }
        ]
      })
      .toArray((err, jobs) => {
        let totalUsedSeconds = 0
        for (const i in jobs) {
          // get duration of job in measured interval (truncate by interval boundaries)
          const jobFrom = Math.max(jobs[i].started, intervalFrom)
          const jobTo = Math.min(jobs[i].finished, intervalTo)
          totalUsedSeconds += jobTo - jobFrom
        }

        callback(
          Math.round((totalUsedSeconds / intervalDuration) * 100) / 100 +
            '/' +
            this.immediateQueue.getThreads().length +
            ' (' +
            Math.round(
              (totalUsedSeconds / intervalDuration / this.immediateQueue.getThreads().length) * 100
            ) +
            ' %)'
        )
      })
  }
}

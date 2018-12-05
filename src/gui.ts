import { debounce } from 'lodash'
import * as Nconf from 'nconf'
import { Logger } from './logger'
import History from './queue/history'
import Immediate from './queue/immediate'
import Planned from './queue/planned'
import Watchdog from './watchdog'

interface IQueues {
  immediate: Immediate
  planned: Planned
  history: History
}

export default class Gui {
  public db: string
  public nconf: Nconf.Provider
  public logger: Logger
  public queues: IQueues
  public watchdog: Watchdog
  public timeouts
  public timeoutsOnEndTime
  public io

  public updateWaitingCount = debounce(() => {
    if (this.io.sockets.sockets.length > 0) {
      this.logger.info('THROTTLED updateWaitingCount')
      this.queues.immediate.getWaitingJobsCount(cnt => {
        this.emitToAll('waitingCount', cnt)
      })
    }
  }, 3000)

  constructor(db, nconf, logger, queues, watchdog) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.queues = queues
    this.watchdog = watchdog

    this.timeouts = {}
    this.timeoutsOnEndTime = {}
  }

  public run() {
    this.io = this._initSocket()

    this.logger.info('socket.io listens on ' + 8001)

    // INCOMING EVENTS
    // Immediate -- runningJobsList, runningCountChanged, jobFetched, jobCompleted, jobStarted, historyCountIncreased, waitingCountDecreased
    // History --  historyCountDecreased
    // Planned -- waitingCountIncreased

    // on user connected
    this.io.on('connection', socket => {
      this.logger.info('user ' + socket.id + ' connected')

      socket.on('error', e => {
        this.logger.error(e)
      })

      this.updateRunningList(socket)

      this.watchdog.loadThreadsStats(this.nconf.get('gui:threadsStatsLength') / 1000, data => {
        this.emit(socket, 'threadsStats', data)
      })

      this.emit(socket, 'threadsCount', this.queues.immediate.getThreads().length)

      this.queues.history.getJobsCount(cnt => {
        this.emit(socket, 'historyCount', cnt)
      })

      this.queues.immediate.getWaitingJobsCount(cnt => {
        this.emit(socket, 'waitingCount', cnt)
      })

      this.queues.planned.getJobsCount(cnt => {
        this.emit(socket, 'plannedCount', cnt)
      })

      socket.on('requestQueueData', params => {
        this.logger.verbose('request queue data', params)
        try {
          this.updateQueue(params.queue, params.filter, socket)
        } catch (e) {
          this.logger.error(e)
        }
      })

      socket.on('rerun', params => {
        this.logger.verbose('rerun event detected', params)
        this.emitToAll('waitingCountIncreased', 1)
        this.queues.history.rerunJob(params.id, params.queue)
      })
    })

    this.queues.immediate.on('jobFetched', job => {
      this.emitToAll('jobFetched', job)
    })

    this.queues.immediate.on('jobCompleted', job => {
      this.emitToAll('jobCompleted', job)
    })

    this.queues.immediate.on('jobStarted', job => {
      this.emitToAll('jobStarted', job)
    })

    this.queues.planned.on('waitingCountIncreased', diff => {
      this.emitToAll('waitingCountIncreased', diff)
      this.updateWaitingCount()
    })

    this.queues.immediate.on('waitingCountDecreased', diff => {
      this.emitToAll('waitingCountDecreased', diff)
      this.updateWaitingCount()
    })

    this.queues.immediate.on('historyCountIncreased', diff => {
      this.emitToAll('historyCountIncreased', diff)
    })

    this.queues.history.on('historyCountDecreased', diff => {
      this.emitToAll('historyCountDecreased', diff)
    })

    this.watchdog.on('newThreadsStat', data => {
      this.emitToAll('newThreadsStat', data)
    })

    this.queues.history.on('rerunDone', () => {
      this.updateWaitingCount()
    })

    return this
  }

  public updateRunningList(socket) {
    this.queues.immediate.getJobs(
      data => {
        this.emit(socket, 'runningJobsList', data)
      },
      {
        $or: [
          { status: this.nconf.get('statusAlias:fetched') },
          { status: this.nconf.get('statusAlias:running') }
        ]
      }
    )
  }

  public updateQueue(queueName, filter, socket) {
    if (typeof filter.host !== 'undefined') {
      filter.host = new RegExp(filter.host)
    }

    if (typeof filter.job !== 'undefined') {
      filter.job = new RegExp(filter.job)
    }

    if (typeof filter.output !== 'undefined') {
      filter.output = new RegExp(filter.output)
    }

    if (typeof filter.schedule !== 'undefined') {
      filter.schedule = new RegExp(filter.schedule)
    }

    this.queues[queueName].getJobs(function(data) {
      data = data.map(job => {
        job.queue = queueName
        return job
      })

      switch (queueName) {
        case 'immediate':
          // show only running jobs
          data = data.filter(job => {
            return job.status === 'planed'
          })
          this.emit(socket, queueName + 'QueueData', data)
          break

        case 'planned':
          this.emit(socket, queueName + 'QueueData', data)
          break

        case 'history':
          // prepend done jobs from immediate
          this.queues.immediate.getJobs(function(immediateJobs) {
            immediateJobs = immediateJobs.filter(job => {
              return job.status === 'success' || job.status === 'error'
            })

            immediateJobs = immediateJobs.map(job => {
              job.queue = 'immediate'
              return job
            })

            const jobs = immediateJobs.concat(data)
            this.emit(socket, queueName + 'QueueData', jobs)
          }, filter)
          break
      }
    }, filter)
  }

  public emitToAll(action, params) {
    this.logger.debug('emitToAll event ' + action)
    this.io.emit(action, params)
  }

  public emit(socket, action, params, logDetails?) {
    this.logger.debug('emit event ' + action, logDetails ? logDetails : '')
    socket.emit(action, params)
  }

  public stop() {
    this.io.close()
    this.logger.info('stopped')
  }

  private _initSocket() {
    const express = require('express')
    const app = express()
    const listener = app.listen(8001)
    app.use('/', express.static('public'))
    return require('socket.io')(listener)
  }
}

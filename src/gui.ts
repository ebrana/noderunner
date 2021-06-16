import { Validator } from 'jsonschema'
import { debounce } from 'lodash'
import { Db } from 'mongodb'
import { Provider as Nconf } from 'nconf'
import threadsSettingSchema = require("../threadsSettingSchema.json")
import Identity from './identity'
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

type MyCallbackType = () => void

export default class Gui {
  public db: Db
  public nconf: Nconf
  public logger: Logger
  public queues: IQueues
  public watchdog: Watchdog
  public schemaValidator: Validator
  public io

  public updateWaitingCount = debounce(() => {
    if (this.io.sockets.sockets.length > 0) {
      this.logger.info('THROTTLED updateWaitingCount')
      this.queues.immediate.getWaitingJobsCount(cnt => {
        this.emitToAll('waitingCount', cnt)
      })
    }
  }, 3000)

  private readonly restartCalback: CallableFunction
  private readonly authorizator: Identity | null

  constructor(db: Db, nconfig: Nconf, logger: Logger, queues, watchdog, schemaValidator, restartCalback) {
    this.db = db
    this.nconf = nconfig
    this.logger = logger
    this.queues = queues
    this.watchdog = watchdog
    this.restartCalback = restartCalback;
    this.schemaValidator = schemaValidator;
    this.authorizator = nconfig.get('jwt:enable') ? new Identity(nconfig) : null
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
      this.emit(socket, 'threadsSettings', this.nconf.get('immediate:threads'))

      this.queues.history.getJobsCount(cnt => {
        this.emit(socket, 'historyCount', cnt)
      })

      this.queues.immediate.getWaitingJobsCount(cnt => {
        this.emit(socket, 'waitingCount', cnt)
      })

      this.queues.planned.getJobsCount(cnt => {
        this.emit(socket, 'plannedCount', cnt)
      })

      if (this.nconf.get('jwt:enable')) {

        socket.on('login', (record) => {
          if (this.authorizator) {
            this.authorizator.login(record.email, record.password, (token, errorCode, errorMessage) => {
              if (token) {
                this.emit(socket, 'loginSuccess', { 'token': token, 'username': record.email })
              } else {
                this.emit(socket, 'loginError', { 'code': errorCode, 'message': errorMessage })
              }
            })
          }
        })

        socket.on('delCommand', (record) => {
          if (this.isAllowed(record.token)) {
            this.queues.planned.deleteJob(record.id, () => {
              this.updateQueue('planned', record.filter, socket)
              this.queues.planned.getJobsCount(cnt => {
                this.emit(socket, 'plannedCount', cnt)
              })
            }, (message, error) => { this.logger.error(error) })
          } else {
            this.permissionDenied(record, socket)
          }
        })

        socket.on('updateCommand', (record) => {
          if (this.isAllowed(record.token)) {
            if (record.command && record.command.command && record.command.host) {
              record.command.job = record.command.command
              record.command.status = 'planed'
              if (record.command.tags.length === 0) {
                delete record.command.tags
              }
              this.queues.planned.updateJob(record.id, record.command, () => {
                try {
                  this.updateQueue('planned', record.filter, socket)
                } catch (e) {
                  this.logger.error(e)
                }
              }, (message) => {
                this.logger.error(message)
                this.emit(socket, 'commandError', message)
              })
            } else {
              this.emit(socket, 'commandError', 'Please set command and host.')
            }
          } else {
            this.permissionDenied(record, socket)
          }
        })

        socket.on('addCommand', (record) => {
          if (this.isAllowed(record.token)) {
            if (record.item.id === undefined) {
              if (record.command && record.command.command && record.command.host) {
                record.command.job = record.command.command
                record.command.status = 'planed'
                if (record.command.tags.length === 0) {
                  delete record.command.tags
                }
                if (record.item.type === 'planned') {
                  this.queues.planned.insertJob(record.command, () => {
                    try {
                      this.updateQueue(record.item.type, record.filter, socket)
                      this.queues.planned.getJobsCount(cnt => {
                        this.emit(socket, 'plannedCount', cnt)
                      })
                    } catch (e) {
                      this.logger.error(e)
                    }
                  }, (message) => {
                    this.logger.error(message)
                    this.emit(socket, 'commandError', message )
                  })
                } else if (record.item.type === 'immediate') {
                  record.command.added = new Date().getTime() / 1000
                  if (record.command.schedule !== undefined) {
                    delete record.command.schedule
                  }
                  this.queues.immediate.insertJob(record.command, () => {
                    try {
                      this.updateQueue(record.item.type, record.filter, socket)
                      this.queues.immediate.getWaitingJobsCount(cnt => {
                        this.emit(socket, 'waitingCount', cnt)
                      })
                    } catch (e) {
                      this.logger.error(e)
                    }
                  }, (message) => {
                    this.logger.error(message)
                    this.emit(socket, 'commandError', message )
                  })
                }
              } else {
                this.emit(socket, 'commandError', 'Please set command and host.')
              }
            }
          } else {
            this.permissionDenied(record, socket)
          }
        })

        socket.on('addThread', (record) => {
          if (this.isAllowed(record.token)) {
            const threads = this.nconf.get('immediate:threads')
            if (this.nconf.get('immediate:maxThreadsCount') === threads.length) {
              this.logger.error('threads limit reached')
              this.emit(socket, 'settingSavedFalse', 'Threads limit reached.')
            } else {
              record.setting.uid = this.queues.immediate.computeThreadeUid()
              threads.push(record.setting)
              const res = this.schemaValidator.validate(threads, threadsSettingSchema);

              if (res.valid === false) {
                this.logger.error('schema is not valid')
                this.emit(socket, 'settingSavedFalse', null)
              } else {
                this.emitToAll('settingSaved', { 'threads': threads, 'invalidateChart': false })
                this.nconf.save(() => {
                  this.logger.info('save config')
                  this.queues.immediate.addThread(record.setting.uid)
                  this.emitToAll('settingSaved', { 'threads': threads, 'invalidateChart': true })
                })
              }
            }
          } else {
            this.permissionDenied(record, socket)
          }
        })

        socket.on('delThread', (record) => {
          if (this.isAllowed(record.token)) {
            const threads = this.nconf.get('immediate:threads')
            threads[record.index].delete = true;
            this.nconf.save(() => {
              this.emitToAll('settingSaved', { 'threads': threads, 'invalidateChart': false })
              this.queues.immediate.delThread(record.index)
            })
          } else {
            this.permissionDenied(record, socket)
          }
        })

        socket.on('refreshToken', (record) => {
          if (this.authorizator) {
            this.authorizator.refresh(record.token, (token, errorCode, errorMessage) => {
              if (token) {
                this.emit(socket, 'refreshTokenSuccess', { 'token': token })
              } else {
                this.emit(socket, 'refreshTokenError', { 'code': errorCode, 'message': errorMessage })
              }
            })
          }
        })

        socket.on('updateThreadSetting', (record) => {
          if (this.isAllowed(record.token)) {
            const threads = this.nconf.get('immediate:threads')
            if (threads[record.id].delete === undefined) { // ukladame nastaveni jen pro vlakna, ktera nejsou oznacena pro mazani
              const uid = threads[record.id].uid
              threads[record.id] = record.setting
              threads[record.id].uid = uid
              const res = this.schemaValidator.validate(threads, threadsSettingSchema);

              if (res.valid === false) {
                this.logger.error('schema is not valid')
                this.emit(socket, 'settingSavedFalse', null)
              } else {
                this.nconf.set('immediate:threads', threads)
                this.nconf.save(() => {
                  this.logger.info('update setting on thread #' + record.id + ' success')
                  this.emitToAll('settingSaved', { 'threads': threads, 'invalidateChart': false })
                })
              }
            }
          } else {
            this.permissionDenied(record, socket)
          }
        })

      }

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
        this.queues.history.rerunJob(params.id, params.queue, (result) => {
          if (result === true) {
            this.emit(socket, 'commandSuccess', 'Success rerun.')
          } else {
            this.emit(socket, 'commandError', 'Please set command and host.')
          }
        })
      })
    })

    this.queues.immediate.on('jobFetched', job => {
      this.emitToAll('jobFetched', job)
    })

    this.queues.immediate.on('jobCompleted', job => {
      this.emitToAll('jobCompleted', job)
    })

    this.queues.immediate.on('settingSavedByDelete', index => {
      const threads = this.nconf.get('immediate:threads')
      threads.splice(index, 1)
      this.nconf.set('immediate:threads', threads)
      this.nconf.save(() => {
        this.logger.info('save config ' + index)
        this.logger.error('thread ' + index + ' removed')
        this.emitToAll('settingSaved', {'threads': threads, 'invalidateChart': true})
        this.updateAllRunningList()
      })
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

  public updateAllRunningList() {
    this.queues.immediate.getJobs(
      data => {
        this.emitToAll('runningJobsList', data)
      },
      {
        $or: [
          { status: this.nconf.get('statusAlias:fetched') },
          { status: this.nconf.get('statusAlias:running') }
        ]
      }
    )
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
    if (typeof filter.host !== 'undefined' && filter.host !== null && filter.host !== '') {
      filter.host = new RegExp(filter.host.trim())
    } else if (typeof filter.host !== 'undefined') {
      delete filter.host
    }


    if (typeof filter.job !== 'undefined' && filter.job !== null && filter.job !== '') {
      filter.job = new RegExp(filter.job.trim())
    } else if (typeof filter.job !== 'undefined') {
      delete filter.job
    }

    if (typeof filter.output !== 'undefined' && filter.output !== null && filter.output !== '') {
      filter.output = new RegExp(filter.output.trim())
    } else if (typeof filter.output !== 'undefined') {
      delete filter.output
    }

    if (typeof filter.schedule !== 'undefined' && filter.schedule !== null && filter.schedule !== '') {
      filter.schedule = new RegExp(filter.schedule.trim())
    } else if (typeof filter.schedule !== 'undefined') {
      delete filter.schedule
    }

    if (typeof filter.tags !== 'undefined' && filter.tags !== null && filter.tags !== '') {
      filter.tags = new RegExp(filter.tags.trim())
    } else if (typeof filter.tags !== 'undefined') {
      delete filter.tags
    }

    if (typeof filter.duration !== 'undefined' && filter.duration !== null && filter.duration !== '') {
      filter.duration = new RegExp(filter.duration.trim())
    } else if (typeof filter.duration !== 'undefined') {
      delete filter.duration
    }

    if (typeof filter.status !== 'undefined' && filter.status !== null && filter.status !== '' && filter.status !== '-') {
      filter.status = new RegExp(filter.status)
    } else if (typeof filter.status !== 'undefined') {
      delete filter.status
    }

    this.queues[queueName].getJobs(data => {
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
          this.queues.immediate.getJobs(immediateJobs => {
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

  public stop(callback: MyCallbackType | null = null) {
    this.io.close(() => {
      this.logger.info('stopped')
      if (callback) {
        callback()
      }
    })
  }

  private isAllowed(token: string): boolean {
    return this.authorizator !== null && this.authorizator.isValidate(token)
  }

  private _initSocket() {
    const express = require('express')
    const bodyParser = require('body-parser')
    const app = express()
    const listener = app.listen(8001)
    app.use('/', express.static('public'))
    app.post('/queue/:queue', bodyParser.json(), (req, res) => {
      if (['::1', '127.0.0.1'].includes(req.ip)) {
        this.db
          .collection(req.params.queue)
          .insertOne(req.body)
          .then(() => {
            res.end()
          })
          .catch(() => {
            res.statusCode = 500
            res.end()
          })
      } else {
        res.statusCode = 401
        res.end()
      }
    })

    return require('socket.io')(listener)
  }

  private permissionDenied(record, socket) {
    this.logger.error('permission denied')
    try {
      if (this.authorizator) {
        this.authorizator.validate(record.token)
      }
      this.emit(socket, 'permissionDenied', 'permission denied')
    } catch (e) {
      this.emit(socket, 'permissionDenied', e.message)
    }
  }
}

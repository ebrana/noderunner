import isRunning = require('is-running')
import Job from '../job'
import Queue from '../queue'

export default class Immediate extends Queue {
  private timeout: NodeJS.Timeout
  private running: boolean
  private lastFinishedCallback: () => void
  private lastCheckTime: number
  private isStuckJobsCheckPlanned: boolean
  private readonly threads: string[]
  private readonly jobStats: { [id: string]: { finished?: number; started: number; thread: number } }

  constructor(db, nconf, logger) {
    super(db, nconf, logger)

    this.timeout = null
    this.running = false
    this.lastFinishedCallback = null
    this.lastCheckTime = null
    this.isStuckJobsCheckPlanned = false

    // entry for every thread with null value when free and non-null ('booked' or job _id when currently used)
    this.threads = []
    for (let i = 0; i < nconf.get('immediate:threads').length; i++) {
      this.threads[i] = null
    }

    // store job timing stats (stared, finished, duration) for analysis in watchdog queue
    this.jobStats = {}
  }

  public addThread() {
    this.threads.push(null);
  }

  public delThread(index: number, callback) {
    if (this.threads[index] === null) {
      this.threads.splice(index, 1);
      callback();
    } else {
      setTimeout(()=>{
        this.delThread(index, callback)
      }, 2000, index, callback)
    }
  }

  public run() {
    this.running = true
    this._removeStuckRunningJobs(true)
    this._check()

    return this
  }

  public createJobStat(job: Job, threadIndex) {
    const id = job.document._id.toHexString()
    if (!this.jobStats[id]) {
      this.jobStats[id] = {
        started: job.document.started,
        thread: threadIndex
      }
    }
  }

  public updateJobStat(job: Job, threadIndex) {
    const id = job.document._id.toHexString()
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
  public bookThread() {
    for (let i = 0; i < this.threads.length; i++) {
      if (this.threads[i] === null) {
        this.logger.silly('booked thread ' + i)
        this.threads[i] = 'booked'
        return i
      }
    }
    return null
  }

  public bookThreadByIndexes(indexes: number[]) {
    for (const item of indexes) {
      if (this.threads[item] === null) {
        this.logger.silly('booked thread ' + item)
        this.threads[item] = 'booked'
        return item;
      }
    }
    return null
  }

  public getThreadsByCriteriaTags(threadIndex, configuration, tags: string[], host) {
    let include = false
    let exclude = false
    // testujeme stitky pokud jsou nastaveny
    if (tags && tags.length > 0) {
      for (const item in tags) {
        if (configuration[threadIndex].include.includes(tags[item])) {
          include = true
        }
        if (configuration[threadIndex].exclude.includes(tags[item])) {
          exclude = true
          break
        }
      }
    }

    if ((include === true && exclude === false) ||
      ((tags === undefined || tags.length === 0) && configuration[threadIndex].include.length === 0) ||
      (configuration[threadIndex].include.length === 0 && exclude === false &&
        (configuration[threadIndex].implementation === null || configuration[threadIndex].implementation === host))
    ) {
      // vlozeno pres shodu v include a zaroven neni vylouceno pres exclude
      // pokud proces nema stitek a vlakno nema nastaveno co do nej muze pres include
      // pokud vlakno nedefinuje include a proces nevypadne pres exclude a shoduje se host nebo neni definovan
      return threadIndex
    }

    return null
  }

  public getThreadsByCriteria(host, tags: string[]) {
    const configuration = this.nconf.get('immediate:threads')
    return configuration.map((value, i) => {
      return this.getThreadsByCriteriaTags(i, configuration, tags, host)
    }).filter((index) => {
      return index !== null
    });
  }

  public bookThreadWithTags(callback, fallback) {
    try {
      this.db
        .collection('immediate')
        .findOne(
          { status: this.nconf.get('statusAlias:planned') },
          { sort: [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']]},
          (err, doc) => {
            if (err) {
              this.logger.error('cannot load job from queue', err)
              fallback(err)
            } else if (doc === null) {
              // no next job found in immediate queue
              fallback(false, null)
            } else {
              // najit vhodne vlakno podle tagu
              const threadeIndexes = this.getThreadsByCriteria(doc.host, doc.tags)
              if (threadeIndexes.length === 0) { // job can never be started
                this.logger.error('The job can never be started: ' + doc._id.toString())
                // konfigurace threadu je takova, ze by se tento job nikdy nespustil
                fallback(false, null)
              } else {
                const threadeIndex = this.bookThreadByIndexes(threadeIndexes);
                if (threadeIndex !== null) {
                  this.fetchNextJobByDocument(threadeIndex, doc, callback, fallback)
                } else {
                  this.logger.warn('Job cant find free thread: ' + doc._id.toString())
                  fallback(false, null)
                }
              }
            }
          }
        )
    } catch (e) {
      fallback(e, null)
    }
  }

  public fetchNextJobByDocument(threadIndex, document, callback, fallback) {
    const changes = {
      started: new Date().getTime() / 1000,
      status: this.nconf.get('statusAlias:fetched'),
      thread: threadIndex
    }

    try {
      this.db
        .collection('immediate')
        // @ts-ignore this method is missing in mongodb type, need to update mongodb to v3
        .findAndModify(
          { _id: document._id },
          [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']],
          { $set: changes },
          { new: true },
          (err, doc) => {
            if (err) {
              this.logger.error('cannot load job from queue', err)
              fallback(err, threadIndex)
            } else if (!doc.value) {
              // no next job found in immediate queue
              fallback(false, threadIndex)
            } else {
              // next job found in immediate queue
              const job = new Job(this)
              job.initByDocument(doc.value)
              callback(job, threadIndex)
            }
          }
        )
    } catch (e) {
      fallback(e, threadIndex)
    }
  }

  public fetchNextJob(threadIndex, callback, fallback) {
    const changes = {
      started: new Date().getTime() / 1000,
      status: this.nconf.get('statusAlias:fetched'),
      thread: threadIndex
    }

    try {
      this.db
        .collection('immediate')
        // @ts-ignore this method is missing in mongodb type, need to update mongodb to v3
        .findAndModify(
          { status: this.nconf.get('statusAlias:planned') },
          [['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']],
          { $set: changes },
          { new: true },
          (err, doc) => {
            if (err) {
              this.logger.error('cannot load job from queue', err)
              fallback(err)
            } else if (!doc.value) {
              // no next job found in immediate queue
              fallback(false)
            } else {
              // next job found in immediate queue
              const job = new Job(this)
              job.initByDocument(doc.value)
              callback(job)
            }
          }
        )
    } catch (e) {
      fallback(e)
    }
  }

  public stop(callback, withBookedWaiting: boolean = true) {
    if (!this.isAnyBookedThread() && typeof callback === 'function' && withBookedWaiting) {
      callback()
      return
    }

    this.lastFinishedCallback = callback
    this.logger.info('stopped')
    this.running = false
    this.lastCheckTime = null
    clearTimeout(this.timeout)
  }

  public resetFinishedJobStats() {
    for (const id in this.jobStats) {
      if (this.jobStats[id].finished) {
        delete this.jobStats[id]
      } else {
        this.jobStats[id].started = Date.now() / 1000
      }
    }
  }

  public rebookThread(threadIndex, jobId) {
    this.threads[threadIndex] = jobId
  }

  public releaseThread(index) {
    this.logger.silly('released thread ' + index)
    this.threads[index] = null
  }

  public getThreads() {
    return this.threads
  }

  public getRunningThreads() {
    return this.threads.filter(t => {
      return t !== null && t !== 'booked'
    })
  }

  public getBookedThreads() {
    return this.threads.filter(t => {
      return t !== null
    })
  }

  public isAnyBookedThread() {
    return this.getBookedThreads().length > 0
  }

  public getThreadsInfo(highlightIndex) {
    return (
      '[' +
      this.threads
        .map((t, i) => {
          return typeof highlightIndex !== 'undefined' && highlightIndex === i
            ? 'o'
            : t === null
            ? '-'
            : 'x'
        })
        .join('') +
      ']'
    )
  }

  public getWaitingJobsCount(callback) {
    this.db
      .collection('immediate')
      .count({ status: this.nconf.get('statusAlias:planned') }, (err, count) => {
        callback(count)
      })
  }

  public getJobs(callback, filter: any) {
    try {
      this.db
        .collection('immediate')
        .find(filter)
        .limit(100)
        .sort([['nextRun', 'asc'], ['priority', 'desc'], ['added', 'desc'], ['started', 'desc']])
        .toArray((err, docs) => {
          if (err) {
            this.logger.error(err)
          } else {
            docs.forEach((value, index) => {
              docs[index].runningTime = (new Date().getTime() / 1000) - docs[index].started;
            })
            return callback(docs)
          }
        })
    } catch (error) {
      this.logger.error(error.message, error)
    }
  }

  public getJobStats() {
    return this.jobStats
  }

  public getLastCheckTime(): number {
    return this.lastCheckTime
  }

  private _removeStuckRunningJobs(evenWithoutPid) {
    this.logger.warn('try to move stuck running/fetched jobs - evenWithoutPid=', evenWithoutPid)
    try {
      this.db
        .collection('immediate')
        .find({ $or: [{ status: 'running' }, { status: 'fetched' }] })
        // @ts-ignore this method is missing in mongodb type, need to update mongodb to v3
        .each((err, doc) => {
          if (doc != null) {
            if ((evenWithoutPid && !doc.pid) || (doc.pid && !isRunning(doc.pid))) {
              this.db.collection('immediate').deleteOne(doc).catch(error => {
                this.logger.error(error.message, error)
              })
              this.logger.warn(
                'moving stuck running/fetched job with PID and _id: ',
                doc.pid,
                doc._id.toString()
              )
              delete doc._id
              doc.status = 'stucked'
              doc.finished = Math.floor(new Date().getTime() / 1000)
              this.db.collection('history').insertOne(doc).catch(error => {
                this.logger.error(error.message, error)
              })
            }
          }
        })
    } catch (error) {
      this.logger.error(error.message, error)
    }
  }

  private _check() {
    this.lastCheckTime = Date.now()

    clearTimeout(this.timeout)

    // if queue is already stopped, do nothing
    if (this.running === false) {
      if (!this.isAnyBookedThread() && this.lastFinishedCallback) {
        this.lastFinishedCallback()
      }
      return
    }

    this.bookThreadWithTags((job: Job, threadIndex) => {
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

            if (this.running === true) { // job completed but queue is stopped, not plann next check
              this._check()
            }
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
            if (this.running === true) {
              this.timeout = setTimeout(() => {
                this._check()
              }, this.nconf.get('immediate:interval'))
            }
          },
          document => {
            this.emit('jobStarted', document)
          }
        )

        // job done - try fetch and run another immediately without wait
        this._check()
      },
      (e, threadIndex) => {
        if (threadIndex !== null) {
          // no job to fetch or error
          this.releaseThread(threadIndex)
        }

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
      })
  }
}

import * as split from 'argv-split'
import * as chance from 'chance'
import * as parser from 'cron-parser'
import * as _ from 'lodash'
import { Db, ObjectID } from 'mongodb'
import { Provider as Nconf } from 'nconf'
import { Logger } from './logger'
import Queue from './queue'
import Immediate from './queue/immediate'

export interface IDocument {
  _id: ObjectID | string
  status: string
  command: string
  nice?: number
  schedule?: string
  thread: string
  sourceId?: ObjectID
  added?: number
  output?: string
  errors?: string
  started?: number
}

interface INextRuntime {
  offset: number,
  nextWithOffset: number,
  nextWithoutOffset: number
}

export default class Job {
  private document: IDocument
  private db: Db
  private nconf: Nconf
  private logger: Logger
  private queue: Queue
  private readonly threadName: string
  private readonly threadIndex: string

  constructor(queue: Queue, doc: IDocument) {
    this.db = queue.db
    this.nconf = queue.nconf
    this.logger = queue.logger
    this.queue = queue
    this.document = doc
    this.threadName = this._buildThreadName(this.document.thread)
    this.threadIndex = this.document.thread
  }

  public getDocument(): IDocument {
    return this.document
  }

  public run(callback, fallback, onStatusSaved) {
    const command = this._buildCommandArray()

    this.logger.info(
      'THREAD ' +
        this.threadName +
        ' ' +
        (this.queue as Immediate).getThreadsInfo([this.threadIndex]) +
        ' running ' +
        this.document._id
    )

    this._save(
      {
        executedCommand: command[0] + ' ' + command[1].join(' '),
        status: this.nconf.get('statusAlias:running')
      },
      document => {
        if (typeof onStatusSaved !== 'undefined') {
          onStatusSaved(document)
        }

        const spawn = require('child_process').spawn
        try {
          const child = spawn(command[0], command[1])

          this._save({
            pid: child.pid
          })

          child.stdout.on('data', data => {
            // TODO dodelat buffer, aby se nevolalo mongo pri kazdem radku
            // self.logger.verbose('THREAD ' + self.threadName + ': data ', data.toString().replace('\n', ' '));
            this._appendToProperty('output', data.toString())
          })
          child.stderr.on('data', data => {
            this.logger.warn(
              'THREAD ' + this.threadName + ': error ',
              data.toString().replace('\n', ' ')
            )
            this._appendToProperty('errors', data.toString())
          })
          child.on('exit', code => {
            this._finish(code, callback, fallback)
          })
          child.on('error', data => {
            this.logger.error(data.toString())
            this._appendToProperty('errors', data.toString())
            this._finish(500, callback, fallback)
          })
        } catch (e) {
          this.logger.error(e.message)
          this._appendToProperty('errors', e.message)
          this._finish(500, callback, fallback)
        }
      },
      () => {
        if (typeof fallback !== 'undefined') {
          fallback()
        }
      }
    )
  }

  // parameters and all calculations are in seconds
  public isDue(checkIntervalStart, checkIntervalEnd): boolean {
    const schedule = this.document.schedule;
    if (schedule) {
      const { nextWithOffset, nextWithoutOffset, offset } = this.getNextRunTime()

      if (checkIntervalStart < nextWithOffset) {
        if (nextWithOffset <= checkIntervalEnd) {
          // inside of interval
          this.logger.debug(
            '✓ job ' +
            this.document._id +
            ' with next due time ' +
            time(nextWithoutOffset) +
            '-' +
            offset +
            's=' +
            time(nextWithOffset) +
            ' is inside of check interval: (' +
            time(checkIntervalStart) +
            '..[' +
            time(nextWithOffset) +
            ']..' +
            time(checkIntervalEnd) +
            '>'
          )
        } else {
          // after interval
          this.logger.debug(
            '✗ job ' +
            this.document._id +
            ' with next due time ' +
            time(nextWithoutOffset) +
            '-' +
            offset +
            's=' +
            time(nextWithOffset) +
            ' is after check interval: (' +
            time(checkIntervalStart) +
            '..' +
            time(checkIntervalEnd) +
            '>  ' +
            (nextWithOffset - checkIntervalStart) +
            's  [' +
            time(nextWithOffset) +
            ']'
          )
        }
      } else {
        // before interval
        this.logger.debug(
          '✗ job ' +
          this.document._id +
          ' with next due time ' +
          time(nextWithoutOffset) +
          '-' +
          offset +
          's=' +
          time(nextWithOffset) +
          ' is before check interval: [' +
          time(nextWithOffset) +
          ']  ' +
          (checkIntervalStart - nextWithOffset) +
          's  (' +
          time(checkIntervalStart) +
          '..' +
          time(checkIntervalEnd) +
          '>'
        )
      }

      return checkIntervalStart < nextWithOffset && nextWithOffset <= checkIntervalEnd
    }

    return false
  }

  public getNextRunTime(): INextRuntime {
    // load distribution algorithm - for example when using */10 * * * * schedule,
    // every job should run in any minute in interval 0..9 (but every job every time with the same offset - derieved from its ID)
    const schedule = this.document.schedule
    if (schedule) {
      let offset: number = 0
      const parsedSchedule = /\*\/(\d*)( \*){4}/.exec(schedule)
      if (parsedSchedule && parsedSchedule[1]) {
        const minutesInterval = parseInt(parsedSchedule[1], 10)

        // find random number derived from job id in interval (0..minutesInterval)
        const randomGenerator = new chance(this.document._id.toString())
        offset = Math.round(
          randomGenerator.integer({ min: 0, max: (minutesInterval - 1) * 100 }) * 0.6
        )
      }

      // next() returns next due time, so we need to move time back by one check interval to get current due time
      const now = new Date(Date.now())
      const next = parser
        .parseExpression(schedule, {
          currentDate: now.valueOf() - this.nconf.get('planned:interval')
        })
        .next()
      const nextWithoutOffset = Math.floor(next.getTime() / 1000)
      const nextWithOffset = nextWithoutOffset - offset

      return { nextWithOffset, nextWithoutOffset, offset }
    }

    return { offset: 0, nextWithOffset: 0, nextWithoutOffset: 0 }
  }

  public copyToImmediate(callback) {
    const newDocument = _.cloneDeep(this.document)
    newDocument.sourceId = newDocument._id
    delete newDocument._id
    newDocument.status = this.nconf.get('statusAlias:planned')
    newDocument.added = new Date().getTime() / 1000
    this.logger.silly('copyToImmediate')
    this.db.collection('immediate').insert(newDocument, () => {
      this.logger.silly('copyToImmediate DONE')
      // self.queue.emit('copiedToImmediate', {oldDocument: self.document, newDocument: newDocument});
      callback()
    })
  }

  public moveToHistory() {
    const newDocument = this.document
    this.db
      .collection('immediate')
      .deleteOne({ _id: newDocument._id })
      .catch(error => {
        this.logger.error(error.message, error)
      })
    delete newDocument._id
    this.logger.silly('moveToHistory')
    this.db
      .collection('history')
      .insertOne(newDocument)
      .then(() => {
        this.logger.silly('moveToHistory DONE')
      })
      .catch(error => {
        this.logger.error(error.message, error)
      })
  }

  public rerun(callback) {
    const newDocument = this.document

    delete newDocument._id
    newDocument.status = this.nconf.get('statusAlias:planned')
    newDocument.added = new Date().getTime() / 1000
    newDocument.output = ''
    newDocument.errors = ''
    this.logger.debug('rerun')
    this.db
      .collection('immediate')
      .insertOne(newDocument)
      .then(() => {
        this.logger.debug('rerun DONE')
        this.queue.emit('rerunDone', { oldDocument: this.document, newDocument })
        callback(true)
      })
      .catch(error => {
        this.logger.error(error.message, error)
        callback(false)
      })
  }

  public toString() {
    return this.document._id + ' ' + this._buildCommand()
  }

  private _finish(code: number, callback, fallback) {
    const finished = new Date().getTime() / 1000

    if (code === 0) {
      this._save({ status: this.nconf.get('statusAlias:success'), finished }, callback, fallback)
      this.logger.info(
        'THREAD ' +
          this.threadName +
          ' ' +
          (this.queue as Immediate).getThreadsInfo(this.threadIndex) +
          '  -> ' +
          this.document._id +
          ' done with SUCCESS'
      )
    } else {
      this._save({ status: this.nconf.get('statusAlias:error'), finished }, callback, fallback)
      this.logger.warn(
        'THREAD ' +
          this.threadName +
          ' ' +
          (this.queue as Immediate).getThreadsInfo(this.threadIndex) +
          '  -> ' +
          this.document._id +
          ' done with ERROR, status ' +
          code
      )
    }
  }

  private _appendToProperty(property, value) {
    if (this.document[property] === null || typeof this.document[property] === 'undefined') {
      this.document[property] = value
    } else {
      this.document[property] += value
    }

    const data = {}
    data[property] = this.document[property]
    this._save(data)
  }

  private _save(data, callback: (doc: any) => void = ()=> { return; }, fallback: (err: Error) => void = ()=> { return; }) {
    this.db
      .collection('immediate')
      // @ts-ignore
      .findAndModify({ _id: this.document._id }, [], { $set: data }, { new: true }, (err, doc) => {
        if (err || doc === null) {
          this.logger.error(
            'THREAD ' + this.threadName + ':',
            'cannot save document',
            err,
            doc !== null ? doc.value : ''
          )
          fallback(err)
        } else {
          callback(doc.value)
        }
      })
  }

  private _buildCommandArray() {
    return this._buildCommand(true)
  }

  private _buildCommand(returnAsArray: boolean = false) {
    let args =
      this.nconf.get('sudo:user') && this.nconf.get('sudo:user').length > 0
        ? ['sudo', '-u', this.nconf.get('sudo:user'), '-g', this.nconf.get('sudo:group')]
        : []

    args = args.concat(this._hasProperty('nice') ? ['nice', '-n', this.document.nice] : [])
    args = args.concat(split(this.document.command))

    const exe = args.shift()

    if (!returnAsArray) {
      return exe + ' ' + args.join(' ')
    } else {
      return [exe, args]
    }
  }

  private _buildThreadName(threadIndex: string) {
    let name = '#' + threadIndex

    const threadNames = this.nconf.get('debug:threadNames')
    if (threadNames) {
      name = threadNames[threadIndex]
    }

    return name
  }

  private _hasProperty(prop) {
    return typeof this.document[prop] !== 'undefined' && this.document[prop] !== null
  }
}

function time(timestamp) {
  const date = new Date(timestamp * 1000)
  return date.getHours() + ':' + date.getMinutes() + ':' + date.getSeconds()
}

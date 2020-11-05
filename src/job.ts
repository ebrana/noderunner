import * as chance from 'chance'
import * as parser from 'cron-parser'
import * as _ from 'lodash'
import { Db, ObjectID } from 'mongodb'
import { Provider as Nconf } from 'nconf'
import { Logger } from './logger'
import Queue from './queue'
import Immediate from './queue/immediate'

export interface IDocument {
  _id: ObjectID
  status: string
  command: string
  nice?: number
  schedule?: string
  thread?: number
  sourceId?: ObjectID
  added?: number
  output?: string
  errors?: string
  started?: number
}

export default class Job {
  public document: IDocument

  private db: Db
  private nconf: Nconf
  private logger: Logger
  private queue: Queue
  private threadName: string
  private threadIndex: number

  constructor(queue: Queue) {
    this.db = queue.db
    this.nconf = queue.nconf
    this.logger = queue.logger
    this.queue = queue
  }

  public run(callback, fallback, onStatusSaved) {
    const command = this._buildCommandArray()
    this.threadName = this._buildThreadName(this.document.thread)
    this.threadIndex = this.document.thread

    this.logger.info(
      'THREAD ' +
        this.threadName +
        ' ' +
        (this.queue as Immediate).getThreadsInfo(this.threadIndex) +
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
      },
      () => {
        if (typeof fallback !== 'undefined') {
          fallback()
        }
      }
    )
  }

  // parameters and all calculations are in seconds
  public isDue(checkIntervalStart, checkIntervalEnd) {
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

  public getNextRunTime() {
    // load distribution algorithm - for example when using */10 * * * * schedule, every job should run in any minute in interval 0..9 (but every job every time with the same offset - derieved from its ID)
    let offset
    const parsedSchedule = /\*\/(\d*)( \*){4}/.exec(this.document.schedule)
    if (parsedSchedule && parsedSchedule[1]) {
      const minutesInterval = parseInt(parsedSchedule[1], 10)

      // find random number derived from job id in interval (0..minutesInterval)
      const randomGenerator = new chance(this.document._id.toString())
      offset = Math.round(
        randomGenerator.integer({ min: 0, max: (minutesInterval - 1) * 100 }) * 0.6
      )
    } else {
      offset = 0
    }

    // next() returns next due time, so we need to move time back by one check interval to get current due time
    const now = new Date(Date.now())
    const next = parser
      .parseExpression(this.document.schedule, {
        currentDate: now.valueOf() - this.nconf.get('planned:interval')
      })
      .next()
    const nextWithoutOffset = Math.floor(next.getTime() / 1000)
    const nextWithOffset = nextWithoutOffset - offset

    return { nextWithOffset, nextWithoutOffset, offset }
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

  public rerun() {
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
      })
      .catch(error => {
        this.logger.error(error.message, error)
      })
  }

  public initByDocument(doc) {
    this.document = doc
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

  private _save(data, callback?: (doc: any) => void, fallback?: (err: Error) => void) {
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
          if (typeof fallback !== 'undefined') {
            fallback(err)
          }
        } else {
          if (typeof callback !== 'undefined') {
            callback(doc.value)
          }
        }
      })
  }

  private _buildCommandArray() {
    return this._buildCommand(true)
  }

  private _buildCommand(returnAsArray = false) {
    let args =
      this.nconf.get('sudo:user') && this.nconf.get('sudo:user').length > 0
        ? ['sudo', '-u', this.nconf.get('sudo:user'), '-g', this.nconf.get('sudo:group')]
        : []

    args = args.concat(this._hasProperty('nice') ? ['nice', '-n', this.document.nice] : [])

    // if we had command property, use it instead of deprecated interpreter, basepath, executable, args
    args = args.concat(this.document.command.split(' '))

    const exe = args.shift()

    if (typeof returnAsArray === 'undefined' || !returnAsArray) {
      return exe + ' ' + args.join(' ')
    } else {
      return [exe, args]
    }
  }

  private _buildThreadName(threadIndex: number) {
    let name = '#' + (threadIndex + 1)

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

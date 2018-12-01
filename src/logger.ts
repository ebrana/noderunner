import { createLogger as winstonCreateLogger, format, transports, Logger } from 'winston'
const { combine, timestamp, label, printf, colorize } = format

import * as Transport from 'winston-transport'

export type Logger = Logger

// we want to catch specific mongo error which should be followed by reconnect (mongo client cannot reconnect by itself)
class MongoErrorCatcher extends Transport {
  onMongoError: Function

  constructor(opts) {
    super(opts)
    this.onMongoError = opts.onMongoError
  }

  log({ message, level }, callback) {
    if (level == 'error' && message == 'topology was destroyed') {
      this.onMongoError()
    }
    callback()
  }
}

const myFormat = printf(info => {
  return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`
})

export function createLogger(minLevel: string, namespace: string, onMongoError?: Function): Logger {
  const transport = new transports.Console({
    level: minLevel,
    format: combine(label({ label: namespace.toUpperCase() }), colorize(), timestamp(), myFormat)
  })

  return winstonCreateLogger({
    transports: [transport, new MongoErrorCatcher({ onMongoError })],
    exceptionHandlers: [new transports.Console()],
    exitOnError: false
  })
}

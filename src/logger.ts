import * as rightpad from 'right-pad'
import { createLogger as winstonCreateLogger, format, Logger, transports, verbose } from 'winston'
const { combine, timestamp, label, printf, colorize } = format

import * as Transport from 'winston-transport'

export type Logger = Logger

// we want to catch specific mongo error which should be followed by reconnect (mongo client cannot reconnect by itself)
class MongoErrorCatcher extends Transport {
  public onMongoError: () => void

  constructor(opts) {
    super(opts)
    this.onMongoError = opts.onMongoError
  }

  public log({ message, level }, callback) {
    if (level === 'error' && message === 'topology was destroyed') {
      this.onMongoError()
    }
    callback()
  }
}

const myFormat = printf(info => {
  const paddedLabel = rightpad(`[${info.label}]`, 12, ' ')
  const space = rightpad(' ', 18 - info.level.length, ' ')
  return `${info.timestamp} ${info.level}${space} ${paddedLabel} ${info.message}`
})

export const createLogger = (
  minLevel: string,
  namespace: string,
  onMongoError?: () => void
): Logger => {
  const transport = new transports.Console({
    format: combine(label({ label: namespace.toUpperCase() }), timestamp(), colorize(), myFormat),
    level: minLevel
  })

  return winstonCreateLogger({
    exceptionHandlers: [new transports.Console()],
    exitOnError: false,
    transports: [transport, new MongoErrorCatcher({ onMongoError })]
  })
}

import { createLogger as winstonCreateLogger, format, transports, Logger } from 'winston'

export type Logger = Logger

export function createLogger(minLevel): Logger {
  return winstonCreateLogger({
    transports: [new transports.Console({ level: minLevel, format: format.cli() })],
    exceptionHandlers: [new transports.Console()],
    exitOnError: false
  })
}

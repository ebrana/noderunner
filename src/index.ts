import { MongoClient, MongoClientOptions } from 'mongodb'
import * as nconf from 'nconf'

import Gui from './gui'
import { createLogger } from './logger'
import HistoryQueue from './queue/history'
import ImmediateQueue from './queue/immediate'
import PlannedQueue from './queue/planned'
import Watchdog from './watchdog'

// Config from ENV, CLI, default file and local file
nconf
  .argv()
  .env()
  .file('custom', { file: 'custom/config.json' })
  .file({ file: 'defaults.json' })
  .defaults({ logLevel: 'error' })

let immediate, planned, history, watchdog, gui, mongoTimeout

// Prepare logger instance
const MIN_LOG_LEVEL = nconf.get('logLevel')
const createLoggerForNamespace = namespace =>
  createLogger(MIN_LOG_LEVEL, namespace, () => onMongoFailure())
const logger = createLoggerForNamespace('index')

// Try first connection to the Mongo
tryMongoConnection()

// Graceful restart handler - give some time to all queues to stop, then force exit
process.on('SIGABRT', () => {
  const timeout = nconf.get('gracefulShutdownTimeout')
  logger.warn(
    'SHUTDOWN: Graceful shutdown request detected. Stop queues and wait for ' +
      timeout / 1000 +
      ' seconds.'
  )

  if (nconf.get('gui:enable')) {
    gui.stop()
  }

  planned.stop()
  history.stop()
  watchdog.stop()
  immediate.stop(() => {
    logger.warn('SHUTDOWN: Last thread finished. Exitting in 3 secs...')

    // if some db query running, give it some time to finish
    setTimeout(() => {
      process.exit()
    }, 3000)
  })

  setTimeout(() => {
    logger.warn('SHUTDOWN: Graceful shutdown timeout exceeded. Exitting now...')
    process.exit()
  }, timeout)
})

// This is being called when "topology was destroyed" Mongo error is catched by logger (see src/logger.ts)
function onMongoFailure() {
  logger.warn('MONGO TOPOLOGY DESTRUCTION DETECTED - stopping queues and reconnecting mongo')

  if (nconf.get('gui:enable')) {
    gui.stop()
  }

  planned.stop()
  history.stop()
  watchdog.stop()
  immediate.stop(null, false)
  logger.warn('instance with broken mongo just stopped')
  tryMongoConnection()
}

function tryMongoConnection() {
  const options: MongoClientOptions = {
    reconnectInterval: 1000,
    reconnectTries: 100,
    socketOptions: { keepAlive: true, connectTimeoutMS: 30000 }
  }

  MongoClient.connect(
    nconf.get('mongoDSN'),
    options,
    (err, db) => {
      if (err) {
        logger.error('Mongo connection error, try in 10 secs. ' + JSON.stringify(err))
        clearTimeout(mongoTimeout)
        mongoTimeout = setTimeout(tryMongoConnection, 3000)
      } else {
        logger.info('connected to Mongo')

        immediate = new ImmediateQueue(db, nconf, createLoggerForNamespace('immediate')).run()
        planned = new PlannedQueue(db, nconf, createLoggerForNamespace('planned')).run()
        history = new HistoryQueue(db, nconf, createLoggerForNamespace('history')).run()
        watchdog = new Watchdog(db, nconf, createLoggerForNamespace('watchdog')).run(immediate)
        if (nconf.get('gui:enable')) {
          gui = new Gui(
            db,
            nconf,
            createLoggerForNamespace('gui'),
            { immediate, planned, history },
            watchdog
          ).run()
        }
      }
    }
  )
}

import { Validator } from 'jsonschema'
import { MongoClient, MongoClientOptions } from 'mongodb'
import * as nconf from 'nconf'
import threadsSettingSchema = require("../threadsSettingSchema.json");
import Gui from './gui'
import { createLogger } from './logger'
import HistoryQueue from './queue/history'
import ImmediateQueue from './queue/immediate'
import PlannedQueue from './queue/planned'
import Watchdog from './watchdog'

const schemaValidator = new Validator();
// Config from ENV, CLI, default file and local file
nconf
  .argv()
  .env()
  .file('custom', { file: 'custom/config.json' })
  .file({ file: 'defaults.json' })
  .defaults({ logLevel: 'error' })

if (nconf.get('jwt:self-signed')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

let immediate, planned, history, watchdog, gui, mongoTimeout

// Prepare logger instance
const MIN_LOG_LEVEL = nconf.get('logLevel')
const createLoggerForNamespace = namespace =>
  createLogger(MIN_LOG_LEVEL, namespace, () => onMongoFailure())
const logger = createLoggerForNamespace('index')

const immediateLogger = createLoggerForNamespace('immediate')
const plannedLogger = createLoggerForNamespace('planned')
const historyLogger = createLoggerForNamespace('history')
const watchdogLogger = createLoggerForNamespace('watchdog')
const guiLogger = createLoggerForNamespace('gui')

const res = schemaValidator.validate(nconf.get('immediate:threads'), threadsSettingSchema);

if (res.valid === false) {
  logger.error(res.toString());
  process.exit(257);
}

// Try first connection to the Mongo
tryMongoConnection()

// Graceful restart handler - give some time to all queues to restart, then force exit
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
process.on('warning', e => logger.warn(e.stack));

// This is being called when "topology was destroyed" Mongo error is catched by logger (see src/logger.ts)
function onMongoFailure() {
  logger.warn('MONGO TOPOLOGY DESTRUCTION DETECTED - stopping queues and reconnecting mongo')

  if (nconf.get('gui:enable')) {
    gui.stop(() => {
      restart()
    })
  } else {
    restart()
  }
}

function restart(db = null) {
  planned.stop()
  history.stop()
  watchdog.stop()
  immediate.stop(null, false)
  if (db === null) {
    tryMongoConnection()
  } else {
    db.close(() => {
      tryMongoConnection()
    })
  }
}

function reload(db) {
  nconf.save(() => {
    logger.info('restart in progress')
    restart(db)
  })
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

        immediate = new ImmediateQueue(db, nconf, immediateLogger).run()
        planned = new PlannedQueue(db, nconf, plannedLogger).run()
        history = new HistoryQueue(db, nconf, historyLogger).run()
        watchdog = new Watchdog(db, nconf, watchdogLogger).run(immediate)
        if (nconf.get('gui:enable')) {
          gui = new Gui(
            db,
            nconf,
            guiLogger,
            { immediate, planned, history },
            watchdog,
            schemaValidator,
            reload
          ).run()
        }
      }
    }
  )
}

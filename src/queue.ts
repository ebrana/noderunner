import { EventEmitter } from 'events'
import { Db } from 'mongodb'
import { Provider as Nconf } from 'nconf'
import { Logger } from './logger'

export default abstract class Queue extends EventEmitter {
  protected db: Db
  protected nconf: Nconf
  protected logger: Logger

  constructor(db, nconf, logger) {
    super()
    this.db = db
    this.nconf = nconf
    this.logger = logger
  }

  public abstract run()

  public abstract stop(callback?: () => void)
}

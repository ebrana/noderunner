import { EventEmitter } from 'events'
import { Db } from 'mongodb'
import { Provider as Nconf } from 'nconf'
import { Logger } from './logger'

export default abstract class Queue extends EventEmitter {
  public db: Db
  public nconf: Nconf
  public logger: Logger

  protected constructor(db: Db, nconf: Nconf, logger: Logger) {
    super()
    this.db = db
    this.nconf = nconf
    this.logger = logger
  }

  public abstract run(): void

  public abstract stop(callback?: () => void): void
}

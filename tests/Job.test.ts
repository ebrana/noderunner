import { ObjectID } from 'mongodb'
import * as nconf from 'nconf'

import Job, { IDocument } from '../src/job'
import { createLogger } from '../src/logger'
import Planned from '../src/queue/planned'

nconf
  .argv()
  .env()
  .file('custom', { file: 'custom/config.json' })
  .file({ file: 'defaults.json' })
  .defaults({ logLevel: 'error' })

const logger = createLogger('debug', 'TEST')

const queue = new Planned(null, nconf, logger)
const job = new Job(queue)
const document: IDocument = {
  _id: new ObjectID(),
  command: 'sleep 5',
  schedule: '*/30 * * * *',
  status: 'planed'
}
job.initByDocument(document)

describe('job', () => {
  it('init', () => {
    // TODO
    job.isDue(Date.now() - 20 * 1000, Date.now())
  })
})

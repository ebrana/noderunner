import { ObjectID } from 'mongodb'
import * as nconf from 'nconf'

import Job, { IDocument } from '../src/job'
import { createLogger } from '../src/logger'

nconf.file({ file: '../defaults.json' })

const logger = createLogger('debug', 'TEST')

const job = new Job({ db: null, nconf, logger })
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

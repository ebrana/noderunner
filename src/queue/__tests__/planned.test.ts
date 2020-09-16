import * as nconf from 'nconf'
import Planned from '../planned'
import { createLogger } from '../../logger'

jest.mock('mongodb')

Date.now = jest
  .spyOn(Date, 'now')
  .mockImplementation(() => new Date('2000-01-01T00:30:00').getTime())

const logger = createLogger('error', 'TEST')

const job = { _id: '5f61d86725e34d7a8ba9ca9b', schedule: '30 * * * *' }

const find = jest.fn().mockReturnValue({
  toArray: jest.fn().mockImplementation(callback => callback(null, [job]))
})

const insert = jest.fn()

const db = {
  collection: jest.fn().mockReturnValue({
    find,
    insert
  })
}

beforeAll(() => {
  nconf.file({ file: 'defaults.json' })
})

describe('planned queue', () => {
  it('should plan one due job, run again and stop', done => {
    nconf.set('planned:interval', 500)
    const planned = new Planned(db, nconf, logger)
    planned.run()

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: job.schedule,
        sourceId: job._id,
        status: 'planed'
      }),
      expect.any(Function)
    )

    setTimeout(() => {
      expect(find).toHaveBeenCalledTimes(2)

      planned.stop()
      done()
    }, 750)
  })
})

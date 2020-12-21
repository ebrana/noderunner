import * as nconf from 'nconf'
import { createLogger } from '../../logger'
import Immediate from '../immediate'

jest.mock('mongodb')

// jest.fn().mockImplementation(callback => callback(null, [job]))
const findAndModify = jest.fn().mockImplementation((a, b, c, d, callback) => {
  callback(null, {
    value: {
      _id: '5f61d86725e34d7a8ba9ca9a',
      schedule: '*/30 * * * *'
    }
  })
})

const db = {
  collection: jest.fn().mockReturnValue({
    findAndModify
  })
}

const logger = createLogger('error', 'TEST')

beforeAll(() => {
  nconf.file({ file: 'defaults.json' })
})

describe('planned queue', () => {
  it('add threade', () => {
    const immediateQueue = new Immediate(db, nconf, logger)
    immediateQueue.addThread(null)

    expect(immediateQueue.getThreads().length).toEqual(4)
  })
  it('delete threade', () => {
    const immediateQueue = new Immediate(db, nconf, logger)
    immediateQueue.delThread(0)
    expect(immediateQueue.getThreads().length).toEqual(2)
  })
  // it('book threade', () => {
  //   const immediateQueue = new Immediate(db, nconf, logger)
  //   expect(immediateQueue.isAnyBookedThread()).toBeFalsy()
  //   const bookThread1 = immediateQueue.bookThread()
  //   const bookThread2 = immediateQueue.bookThread()
  //
  //   expect(immediateQueue.getBookedThreadsCount()).toEqual(2)
  //   expect(bookThread1).toEqual(0)
  //   expect(bookThread2).toEqual(1)
  //   expect(immediateQueue.getThreadsInfo(bookThread1)).toEqual('[ox-]')
  //   expect(immediateQueue.getThreadsInfo(bookThread2)).toEqual('[xo-]')
  //
  //   immediateQueue.releaseThread(bookThread1)
  //   immediateQueue.releaseThread(bookThread2)
  //   expect(immediateQueue.getBookedThreadsCount()).toEqual(0)
  // })
  // it('fetch next job', () => {
  //   const immediateQueue = new Immediate(db, nconf, logger)
  //   const bookThread1 = immediateQueue.bookThread()
  //   immediateQueue.fetchNextJob(bookThread1, (job) => {
  //     expect(job.document._id).toEqual('5f61d86725e34d7a8ba9ca9a')
  //   }, null)
  // })
})
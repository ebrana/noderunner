import * as nconf from 'nconf'
import Job from '../../job'
import { createLogger } from '../../logger'
import Immediate from '../immediate'

jest.mock('mongodb')

const logger = createLogger('error', 'TEST')

const findAndModify = jest.fn().mockImplementation((a, b, c, d, callback) => {
  callback(null, {
    value: {
      _id: '5f61d86725e34d7a8ba9ca9a',
      host:'moje-implementace.mybrana.com',
      schedule: '*/30 * * * *',
      tags: ['tag1'],
      thread: c.$set.thread
    }
  })
})
const findOne = jest.fn().mockImplementation((a, b, callback) => {
  callback(null, {
      _id: '5f61d86725e34d7a8ba9ca9a',
      host:'moje-implementace.mybrana.com',
      schedule: '*/30 * * * *',
      tags: ['tag1']
  })
})

const db = {
  collection: jest.fn().mockReturnValue({
    findAndModify,
    findOne
  })
}

beforeAll(() => {
  nconf.file({ file: 'defaults.json' })
})

describe('tags configuration testing', () => {
  it('get thread by criteria', () => {
    nconf.set('immediate:threads', [
      {
        "exclude": [],
        "implementation": null,
        "include": []
      },
      {
        "exclude": [],
        "implementation": "test.com",
        "include": []
      },
      {
        "exclude": [],
        "implementation": null,
        "include": []
      }
    ]);
    const immediateQueue = new Immediate(db, nconf, logger)
    const threads = immediateQueue.getThreadsByCriteria('test.com', [])
    expect(threads.length).toEqual(3)
  });

  it('schema 1', () => {
    nconf.set('immediate:threads', [
      {
        "exclude": ["tag4"],
        "implementation": null,
        "include": ["tag1", "tag2", "tag3"]
      },
      {
        "exclude": ["tag4"],
        "implementation": null,
        "include": ["tag1"]
      },
      {
        "exclude": ["tag3", "tag4"],
        "implementation": null,
        "include": ["tag2"]
      },
      {
        "exclude": [],
        "implementation": "moje-implementace.mybrana.com",
        "include": []
      }
    ]);
    const immediateQueue = new Immediate(db, nconf, logger)
    immediateQueue.bookThreadWithTags((quedJob: Job) => {
      expect(quedJob.document.thread).toEqual(0);
    }, null)
    immediateQueue.bookThreadWithTags((quedJob: Job) => {
      expect(quedJob.document.thread).toEqual(1);
    }, null)
    immediateQueue.bookThreadWithTags((quedJob: Job) => {
      expect(quedJob.document.thread).toEqual(3);
    }, null)
  })

  it('schema 2', () => {
    nconf.set('immediate:threads', [
      {
        "exclude": ["tag4"],
        "implementation": null,
        "include": ["tag1", "tag2", "tag3"]
      },
      {
        "exclude": ["tag4"],
        "implementation": null,
        "include": ["tag1"]
      },
      {
        "exclude": ["tag3", "tag4"],
        "implementation": null,
        "include": ["tag2"]
      },
      {
        "exclude": [],
        "implementation": null,
        "include": []
      }
    ]);
    const immediateQueue = new Immediate(db, nconf, logger)
    const indexes1 = immediateQueue.getThreadsByCriteria('moje-implementace2.mybrana.com', ["tag4"])
    const indexes2 = immediateQueue.getThreadsByCriteria('moje-implementace3.mybrana.com', ["tag3"])

    expect(indexes1.length).toEqual(1)
    expect(indexes2.length).toEqual(2)
    expect(indexes1[0]).toEqual(3)
    expect(indexes2[0]).toEqual(0)
    expect(indexes2[1]).toEqual(3)
  })

  it('schema 3', () => {
    nconf.set('immediate:threads', [
      {
        "exclude": ["tag4"],
        "implementation": null,
        "include": ["tag1", "tag2", "tag3"]
      },
      {
        "exclude": ["tag4"],
        "implementation": null,
        "include": ["tag1"]
      },
      {
        "exclude": ["tag3", "tag4"],
        "implementation": null,
        "include": ["tag2"]
      },
      {
        "exclude": ["tag2"],
        "implementation": null,
        "include": []
      }
    ]);
    const immediateQueue = new Immediate(db, nconf, logger)
    const indexes1 = immediateQueue.getThreadsByCriteria('moje-implementace1.mybrana.com', ["tag1"])
    const indexes2 = immediateQueue.getThreadsByCriteria('moje-implementace2.mybrana.com', ["tag4"])
    const indexes3 = immediateQueue.getThreadsByCriteria('moje-implementace3.mybrana.com', ["tag1", "tag2"])
    const indexes4 = immediateQueue.getThreadsByCriteria('moje-implementace4.mybrana.com', ["tag3"])
    const indexes5 = immediateQueue.getThreadsByCriteria('moje-implementace5.mybrana.com', [])

    expect(indexes1.length).toEqual(3)
    expect(indexes1[0]).toEqual(0)
    expect(indexes1[1]).toEqual(1)
    expect(indexes1[2]).toEqual(3)

    expect(indexes2.length).toEqual(1)
    expect(indexes2[0]).toEqual(3)

    expect(indexes3.length).toEqual(3)
    expect(indexes3[0]).toEqual(0)
    expect(indexes3[1]).toEqual(1)
    expect(indexes3[2]).toEqual(2)

    expect(indexes4.length).toEqual(2)
    expect(indexes4[0]).toEqual(0)
    expect(indexes4[1]).toEqual(3)

    expect(indexes5.length).toEqual(1)
    expect(indexes5[0]).toEqual(3)
  })

})
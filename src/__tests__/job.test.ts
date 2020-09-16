import * as nconf from 'nconf'

import Job from '../job'
import { createLogger } from '../logger'
import Planned from '../queue/planned'
import { mockDateNow } from '../test'

nconf.file({ file: 'defaults.json' })

const logger = createLogger('error', 'TEST')
const queue = new Planned(null, nconf, logger)

const jobWithStarSchedule = new Job(queue)
jobWithStarSchedule.initByDocument({
  _id: '5f61d86725e34d7a8ba9ca9a',
  schedule: '*/30 * * * *'
})

const jobWithRegularSchedule = new Job(queue)
jobWithRegularSchedule.initByDocument({
  _id: '5f61d86725e34d7a8ba9ca9b',
  schedule: '30 * * * *'
})

describe('Job.nextRunTime', () => {
  it('for */30 job returns proper result for various base times', () => {
    mockDateNow('2000-01-01T00:00:00')
    const firstNextRunTime = jobWithStarSchedule.getNextRunTime()

    mockDateNow('2000-01-01T10:10:10')
    const secondNextRunTime = jobWithStarSchedule.getNextRunTime()

    expect(firstNextRunTime).toEqual({
      nextWithOffset: new Date('1999-12-31T23:45:50').getTime() / 1000,
      nextWithoutOffset: new Date('2000-01-01T00:00:00').getTime() / 1000,
      offset: 850
    })

    expect(secondNextRunTime).toEqual({
      nextWithOffset: new Date('2000-01-01T10:15:50').getTime() / 1000,
      nextWithoutOffset: new Date('2000-01-01T10:30:00').getTime() / 1000,
      offset: 850
    })
  })

  it('for regular job returns proper result with no offset', () => {
    mockDateNow('2000-01-01T00:00:00')
    const nextRunTime = jobWithRegularSchedule.getNextRunTime()

    expect(nextRunTime).toEqual({
      nextWithOffset: new Date('2000-01-01T00:30:00').getTime() / 1000,
      nextWithoutOffset: new Date('2000-01-01T00:30:00').getTime() / 1000,
      offset: 0
    })
  })
})

describe('Job.isDue', () => {
  it('should return true when base inside of check interval', () => {
    const checkIntervalStart = new Date('2000-01-01T00:29:50')
    const checkIntervalEnd = new Date('2000-01-01T00:30:10')
    mockDateNow('2000-01-01T00:30:10')

    const isDue = jobWithRegularSchedule.isDue(
      checkIntervalStart.getTime() / 1000,
      checkIntervalEnd.getTime() / 1000
    )

    expect(isDue).toEqual(true)
  })

  it('should return false when base after of check interval', () => {
    const checkIntervalStart = new Date('2000-01-01T00:29:49')
    const checkIntervalEnd = new Date('2000-01-01T00:29:59')
    mockDateNow('2000-01-01T00:29:59')

    const isDue = jobWithRegularSchedule.isDue(
      checkIntervalStart.getTime() / 1000,
      checkIntervalEnd.getTime() / 1000
    )

    expect(isDue).toEqual(false)
  })

  it('should return false when base before of check interval', () => {
    const checkIntervalStart = new Date('2000-01-01T00:30:10')
    const checkIntervalEnd = new Date('2000-01-01T00:30:30')
    mockDateNow('2000-01-01T00:30:00')

    const isDue = jobWithRegularSchedule.isDue(
      checkIntervalStart.getTime() / 1000,
      checkIntervalEnd.getTime() / 1000
    )
    expect(isDue).toEqual(false)
  })
})

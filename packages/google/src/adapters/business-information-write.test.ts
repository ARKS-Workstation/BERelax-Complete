import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  AL_ZAHIYAH_LOCATION,
  type BusinessProfileProvider,
  createFakeBusinessProfile,
  GBP_RAMADAN_SPECIAL_HOURS,
  GBP_REGULAR_PERIODS,
  type GbpBusinessPeriod,
  type GbpLocation,
  type LocationsPatchRequest,
} from '@berelax/providers/google'

import { beforeEach, describe, expect, it } from 'vitest'
import { hoursLimitFor, simulatedClockFor } from './business-information-write.fixture.ts'
import {
  applyApprovedHours,
  assertUpdateMask,
  UPDATABLE_FIELDS,
} from './business-information-write.ts'

/**
 * The one write path to a Google profile: the three refusals, and the Ramadan hours surviving.
 *
 * Every refusal is asserted with a transport spy at zero calls, because "the check is before the network
 * call" is the kind of claim a refactor reverses silently.
 */

/** The weekly hours a human approved: the same week, closing an hour later. */
const APPROVED: readonly GbpBusinessPeriod[] = GBP_REGULAR_PERIODS.map((period) => ({
  ...period,
  closeTime: { hours: 3, minutes: 0 },
}))

function fakeProfile(): { readonly provider: BusinessProfileProvider } {
  const log = createCallLog(() => new Date(0).toISOString())
  return {
    provider: createFakeBusinessProfile({
      log,
      failures: new FailureScript(),
      now: () => new Date(0).toISOString(),
    }),
  }
}

/** A spy that fails the test if it is reached. The control for every refusal below. */
function refusingTransport(): {
  readonly transport: Pick<BusinessProfileProvider, 'getLocation' | 'updateLocation'>
  readonly patches: LocationsPatchRequest[]
  readonly reads: string[]
} {
  const patches: LocationsPatchRequest[] = []
  const reads: string[] = []
  return {
    patches,
    reads,
    transport: {
      async getLocation({ name }) {
        reads.push(name)
        return AL_ZAHIYAH_LOCATION
      },
      async updateLocation(request) {
        patches.push(request)
        return AL_ZAHIYAH_LOCATION
      },
    },
  }
}

describe('the Business Information write adapter', () => {
  let clock: ReturnType<typeof simulatedClockFor>

  beforeEach(() => {
    clock = simulatedClockFor()
  })

  it('leaves the Ramadan specialHours untouched by a weekly-hours write', async () => {
    const { provider } = fakeProfile()
    const result = await applyApprovedHours(
      { transport: provider, limit: hoursLimitFor(clock) },
      { locationName: AL_ZAHIYAH_LOCATION.name, periods: APPROVED },
    )

    // The hours did change, so the test is about a write that happened.
    expect(result.periods.map((period) => period.closeTime.hours)).toEqual(Array(7).fill(3))
    // And the dated variations are exactly what they were. Asserted as the before-and-after pair from
    // the adapter's own result, and separately against the fixture, so an empty-to-empty comparison
    // cannot pass this.
    expect(result.specialHourPeriodsBefore).toEqual(GBP_RAMADAN_SPECIAL_HOURS)
    expect(result.specialHourPeriodsAfter).toEqual(GBP_RAMADAN_SPECIAL_HOURS)
    expect(result.specialHourPeriodsAfter).toHaveLength(1)

    // And from the server's side: a fresh read of the profile still carries them.
    const reread = await provider.getLocation({
      name: AL_ZAHIYAH_LOCATION.name,
      readMask: ['name', 'title', 'metadata'],
    })
    expect(reread.specialHours?.specialHourPeriods).toEqual(GBP_RAMADAN_SPECIAL_HOURS)
  })

  it('shows the fake would really wipe them, so the assertion above is not about a lenient fake', async () => {
    // The control that makes the test above mean something. A whole-object PATCH through the transport
    // directly — the call the adapter refuses — destroys the special hours. Without this, "they survive"
    // is satisfied by a fake that merges.
    const { provider } = fakeProfile()
    const naive = await provider.updateLocation({
      name: AL_ZAHIYAH_LOCATION.name,
      location: { regularHours: { periods: APPROVED } } as Partial<GbpLocation>,
      updateMask: ['*'],
    })
    expect(naive.specialHours).toBeUndefined()
  })

  it('refuses a patch with no updateMask, before the transport', async () => {
    const spy = refusingTransport()
    expect(() => assertUpdateMask(undefined, { regularHours: { periods: APPROVED } })).toThrow(
      'no updateMask',
    )
    expect(() => assertUpdateMask([], { regularHours: { periods: APPROVED } })).toThrow(
      'no updateMask',
    )
    expect(spy.patches).toHaveLength(0)
  })

  it('refuses a mask this build has not approved, including the whole-object star', () => {
    expect(() => assertUpdateMask(['*'], {})).toThrow('may patch regularHours and nothing else')
    expect(() =>
      assertUpdateMask(['storefrontAddress'], {
        storefrontAddress: AL_ZAHIYAH_LOCATION.storefrontAddress,
      }),
    ).toThrow('may patch regularHours and nothing else')
    expect(UPDATABLE_FIELDS).toEqual(['regularHours'])
  })

  it('refuses a payload wider than its mask: the naive whole-location request', () => {
    // The shape that destroys data: a request assembled from a `getLocation` answer. The mask is narrow,
    // so this would be accepted by Google today — and is one mask edit from wiping every stale field.
    expect(() =>
      assertUpdateMask(['regularHours'], {
        ...AL_ZAHIYAH_LOCATION,
        regularHours: { periods: APPROVED },
      }),
    ).toThrow('which its updateMask does not name')
  })

  it('refuses an approved update with no periods rather than clearing the hours', async () => {
    const spy = refusingTransport()
    await expect(
      applyApprovedHours(
        { transport: spy.transport, limit: hoursLimitFor(clock) },
        { locationName: AL_ZAHIYAH_LOCATION.name, periods: [] },
      ),
    ).rejects.toThrow('carries no periods')
    expect(spy.patches).toHaveLength(0)
    // And not even a read: the refusal is about the argument, so nothing is spent on it.
    expect(spy.reads).toHaveLength(0)
  })

  it('sends only regularHours, and names only regularHours', async () => {
    const spy = refusingTransport()
    await applyApprovedHours(
      { transport: spy.transport, limit: hoursLimitFor(clock) },
      { locationName: AL_ZAHIYAH_LOCATION.name, periods: APPROVED },
    )
    expect(spy.patches).toHaveLength(1)
    expect(spy.patches[0]?.updateMask).toEqual(['regularHours'])
    // The payload's own key set, which is what makes "read-modify-write" visible rather than intended.
    expect(Object.keys(spy.patches[0]?.location ?? {})).toEqual(['regularHours'])
    // It DID read first, which is the modify half.
    expect(spy.reads).toEqual([AL_ZAHIYAH_LOCATION.name])
  })

  it('queues the eleventh edit of a minute and delivers it, never early and never dropped', async () => {
    const spy = refusingTransport()
    const limit = hoursLimitFor(clock)
    const update = { locationName: AL_ZAHIYAH_LOCATION.name, periods: APPROVED }

    await Promise.all(
      Array.from({ length: 11 }, () =>
        applyApprovedHours({ transport: spy.transport, limit }, update),
      ),
    )

    // Every edit delivered: the cap queues, it does not drop.
    expect(spy.patches).toHaveLength(11)
    // Ten in the first minute, and the eleventh after it. docs/10 §7: ten per minute per profile, and
    // Google states it cannot be raised.
    expect(limit.admittedWithin(0, 59_999)).toBe(10)
    expect(limit.admitted[10]?.atMs).toBe(60_000)
  })
})

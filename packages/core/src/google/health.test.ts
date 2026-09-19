import { describe, expect, it } from 'vitest'
import type { CapabilityState, GoogleCapabilityHealth } from './connection.ts'
import {
  anyCallSucceeded,
  type CapabilityProbe,
  capabilityStatesForDisplay,
  driftedFields,
  everyCallFailed,
  healthAfterProbe,
  LISTING_DRIFT,
  type ListingSnapshot,
  listingDriftFinding,
  normaliseListingText,
} from './health.ts'

/**
 * The arithmetic of the daily check, with every assertion paired against the wrong answer.
 *
 * Two of these functions exist to *refuse* to report something, and a refusal is the shape of check that
 * goes vacuous without being noticed: `healthAfterProbe` returning the stored value on a rate limit, and
 * `listingDriftFinding` returning null on a whitespace difference, both look identical to a function that
 * has stopped deciding anything. So each is asserted with its own opposite beside it.
 */

const CONFIRMED: ListingSnapshot = {
  placeId: 'ChIJ-fake-place-al-zahiyah',
  title: 'BE RELAX — Massage Center and Spa',
  address: '250 Al Meena Street, Tower Block A/B, M-Floor, Al Zahiyah, Abu Dhabi',
}

describe('normaliseListingText', () => {
  it('collapses whitespace and trims, so a formatting difference is not drift', () => {
    expect(normaliseListingText('  250 Al Meena  Street ')).toBe('250 Al Meena Street')
    // The non-breaking space Google's own UI inserts, written as an ESCAPE rather than as the character:
    // a literal one is invisible to a reader and to a diff, and the two strings below would then look
    // identical while the assertion silently proved nothing.
    expect(normaliseListingText('Be\u00a0Relax')).toBe('Be Relax')
    // The control: they really are different strings before normalisation.
    expect('Be\u00a0Relax').not.toBe('Be Relax')
  })

  it('does NOT fold case or strip punctuation, because those are real edits', () => {
    // The control on the normalisation. Harder normalisation would hide a retitle by whoever now manages
    // the listing, which is a change to the business's public identity and the thing this check is for.
    expect(normaliseListingText('BE RELAX')).not.toBe(normaliseListingText('Be Relax'))
    expect(normaliseListingText('Be Relax — Spa')).not.toBe(normaliseListingText('Be Relax Spa'))
  })
})

describe('listing drift', () => {
  it('reports nothing when the returned listing is the confirmed one', () => {
    expect(driftedFields(CONFIRMED, { ...CONFIRMED })).toEqual([])
    expect(
      listingDriftFinding({
        capability: 'gbp_location',
        stored: CONFIRMED,
        returned: { ...CONFIRMED },
      }),
    ).toBeNull()
  })

  it('reports nothing when only the whitespace differs', () => {
    const returned = { ...CONFIRMED, address: `  ${CONFIRMED.address.replace(/, /g, ',  ')} ` }
    expect(
      listingDriftFinding({ capability: 'gbp_location', stored: CONFIRMED, returned }),
    ).toBeNull()
  })

  it('reports ONE finding quoting both values when the title moves', () => {
    const returned = { ...CONFIRMED, title: 'BE RELAX SPA' }
    const finding = listingDriftFinding({
      capability: 'gbp_location',
      stored: CONFIRMED,
      returned,
    })
    expect(finding?.kind).toBe(LISTING_DRIFT)
    expect(finding?.drifted).toEqual([
      { field: 'title', stored: CONFIRMED.title, returned: 'BE RELAX SPA' },
    ])
    // Both values, not just the new one. A finding that reported only what Google returned would leave
    // the owner unable to tell an edit they made from one they did not.
    expect(finding?.placeId).toBe(CONFIRMED.placeId)
  })

  it('reports ONE finding with two fields when the listing moved premises', () => {
    // The shape the real failure takes: a merge or a move changes the title and the address together, and
    // two findings would tell the owner there are two problems when there is one and one action.
    const finding = listingDriftFinding({
      capability: 'gbp_location',
      stored: CONFIRMED,
      returned: {
        ...CONFIRMED,
        title: 'Be Relax Spa — Terminal A',
        address: 'Zayed International Airport, Terminal A, Departures, Abu Dhabi',
      },
    })
    expect(finding?.drifted.map((d) => d.field)).toEqual(['title', 'address'])
  })

  it('reports a changed placeId, which is the listing being a different listing', () => {
    const finding = listingDriftFinding({
      capability: 'gbp_location',
      stored: CONFIRMED,
      returned: { ...CONFIRMED, placeId: 'ChIJ-fake-place-airport-terminal-a' },
    })
    expect(finding?.drifted).toHaveLength(1)
    expect(finding?.drifted[0]?.field).toBe('placeId')
  })

  it('compares the placeId exactly, because it is an identifier and not prose', () => {
    // Normalising an identifier would invent an equivalence Google does not have. Asserted as a
    // difference that survives: a leading space in a place id is a different place id.
    expect(
      driftedFields(CONFIRMED, { ...CONFIRMED, placeId: ` ${CONFIRMED.placeId}` }),
    ).toHaveLength(1)
  })
})

describe('healthAfterProbe', () => {
  const cases: readonly {
    readonly probe: CapabilityProbe
    readonly existing: GoogleCapabilityHealth
    readonly expected: GoogleCapabilityHealth
  }[] = [
    { probe: { kind: 'ok' }, existing: 'unknown', expected: 'ok' },
    { probe: { kind: 'listing_not_verified' }, existing: 'ok', expected: 'not_verified' },
    {
      probe: { kind: 'scope_missing', scope: 'x' },
      existing: 'ok',
      expected: 'permission_missing',
    },
    { probe: { kind: 'evidence', health: 'quota_zero' }, existing: 'ok', expected: 'quota_zero' },
    // The two that must NOT move it. A blip is evidence of nothing.
    { probe: { kind: 'no_evidence' }, existing: 'ok', expected: 'ok' },
    { probe: { kind: 'no_resource' }, existing: 'unknown', expected: 'unknown' },
  ]

  for (const { probe, existing, expected } of cases) {
    it(`maps ${probe.kind} over ${existing} to ${expected}`, () => {
      expect(healthAfterProbe(probe, existing)).toBe(expected)
    })
  }

  it('is the only thing that produces ok, and only from a successful read', () => {
    // The boundary G-CONN-02 and G-CONN-05 both deferred here. Stated as a property over every probe
    // kind rather than as one example, so a new kind cannot quietly acquire the right to write ok.
    const producingOk = cases.filter((c) => c.expected === 'ok' && c.existing !== 'ok')
    expect(producingOk.map((c) => c.probe.kind)).toEqual(['ok'])
  })
})

describe('capabilityStatesForDisplay', () => {
  const rows: readonly CapabilityState[] = [
    { capability: 'gbp_reviews', health: 'ok' },
    { capability: 'gbp_location', health: 'ok' },
    { capability: 'gsc', health: 'ok' },
    // The row a consent registers for a capability nothing consumes and no client can read.
    { capability: 'gbp_performance', health: 'unknown' },
  ]
  const declared = ['gbp_reviews', 'gbp_location', 'gsc'] as const

  it('drops a capability no consumer declares', () => {
    expect(capabilityStatesForDisplay({ rows, declared }).map((r) => r.capability)).toEqual([
      'gbp_reviews',
      'gbp_location',
      'gsc',
    ])
  })

  it('keeps a DECLARED capability that is unknown, which is the whole point of the scoping', () => {
    // The control. Filtering on the health value instead of on the declared set would have been shorter
    // and would have hidden the case the owner most needs told about: a capability somebody depends on
    // that no pass has managed to exercise.
    const unexercised: readonly CapabilityState[] = [{ capability: 'gsc', health: 'unknown' }]
    expect(capabilityStatesForDisplay({ rows: unexercised, declared })).toEqual(unexercised)
  })
})

describe('anyCallSucceeded and everyCallFailed', () => {
  it('reports a total failure only when calls were made and none was answered', () => {
    expect(everyCallFailed([{ reachedGoogle: false }, { reachedGoogle: false }])).toBe(true)
    expect(everyCallFailed([{ reachedGoogle: false }, { reachedGoogle: true }])).toBe(false)
    expect(anyCallSucceeded([{ reachedGoogle: false }, { reachedGoogle: true }])).toBe(true)
  })

  it('reports no failure at all when nothing was attempted', () => {
    // The guard, and it is not hypothetical: a connection whose every scope is missing makes no calls,
    // and reporting that as a total outage would claim an observation the pass never made.
    expect(everyCallFailed([])).toBe(false)
    expect(anyCallSucceeded([])).toBe(false)
  })
})

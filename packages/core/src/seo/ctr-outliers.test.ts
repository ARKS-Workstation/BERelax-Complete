import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  type CtrOutlier,
  type CtrOutlierConfig,
  compareCtrOutlier,
  ctrOutliers,
  positionBandOf,
} from './ctr-outliers.ts'
import type { SeoQueryRow } from './query-rows.ts'

const SITE = 'https://gseo03-fixture.invalid'

const CONFIG: CtrOutlierConfig = {
  minPositionCenti: 500,
  maxPositionCenti: 2000,
  minImpressions: 200,
  minShortfallBp: 100,
  minPeerGroups: 2,
}

const pair = (
  id: string,
  clicks: number,
  impressions: number,
  avgPositionCenti: number,
): SeoQueryRow => ({
  page: `${SITE}/${id}`,
  query: `gseo03 fixture ${id}`,
  clicks,
  impressions,
  avgPositionCenti,
})

describe('positionBandOf', () => {
  it('is the whole position, so 5.00 and 5.99 share a band', () => {
    expect(positionBandOf(500)).toBe(5)
    expect(positionBandOf(599)).toBe(5)
    expect(positionBandOf(600)).toBe(6)
    expect(positionBandOf(2000)).toBe(20)
  })
})

describe('the baseline', () => {
  it('excludes the pair being judged, so a pair holding the band cannot hide behind itself', () => {
    // THE self-inclusion defect. This pair holds 100,000 of the band's 102,000 impressions, so a baseline
    // that included it would sit within 20 bp of its own CTR and the biggest opportunity on the site could
    // never be reported however badly it performed.
    const rows = [
      pair('dominant', 100, 100_000, 800),
      pair('peer-a', 100, 1000, 810),
      pair('peer-b', 100, 1000, 820),
    ]
    const findings = ctrOutliers(rows, CONFIG)
    expect(findings.map((finding) => finding.query)).toEqual(['gseo03 fixture dominant'])
    // 200 clicks in 2,000 peer impressions is 1,000 bp; the pair itself is 100 clicks in 100,000, which is
    // 10 bp, so the shortfall is 990. Included in its own baseline it would be judged against
    // 300/102,000 = 29.41 -> 29 bp and the shortfall would be 19 — below the 100 floor, so no finding at
    // all, which is the whole reason the baseline is leave-one-out.
    expect(findings[0]?.peerCtrBp).toBe(1000)
    expect(findings[0]?.ctrBp).toBe(10)
    expect(findings[0]?.shortfallBp).toBe(990)
  })

  it('needs minPeerGroups peers before a band says anything', () => {
    // Two pairs in a band means each is compared against the other, and the lower one is always "an
    // outlier" — a coin toss dressed as a finding.
    const rows = [pair('one', 0, 1000, 900), pair('two', 100, 1000, 910)]
    expect(ctrOutliers(rows, CONFIG)).toEqual([])
    // The control: the same two pairs plus a third, so the band has two peers for each member.
    const withPeer = ctrOutliers([...rows, pair('three', 100, 1000, 920)], CONFIG)
    expect(withPeer.map((finding) => finding.query)).toEqual(['gseo03 fixture one'])
    expect(withPeer[0]?.peerGroups).toBe(2)
  })

  it('does not compare across bands, because position 5 and position 19 are not peers', () => {
    // Three pairs at position 5 clicking well and three at position 19 clicking normally for position 19.
    // One baseline across the window would condemn all three deep pairs; per-band, none is an outlier.
    const rows = [
      pair('top-a', 60, 1000, 500),
      pair('top-b', 55, 1000, 510),
      pair('top-c', 50, 1000, 520),
      pair('deep-a', 5, 1000, 1900),
      pair('deep-b', 4, 1000, 1910),
      pair('deep-c', 6, 1000, 1920),
    ]
    expect(ctrOutliers(rows, CONFIG)).toEqual([])
  })

  it('excludes a thin pair from the band it would otherwise distort', () => {
    const band = [
      pair('a', 20, 1000, 700),
      pair('b', 20, 1000, 710),
      pair('c', 20, 1000, 720),
      pair('d', 0, 1000, 730),
    ]
    // 60 clicks in 3,000 peer impressions is 200 bp against `d`'s zero: a finding of 200.
    expect(ctrOutliers(band, CONFIG)[0]?.shortfallBp).toBe(200)
    // Adding one 5,000 bp pair with 50 impressions changes nothing, because it is below the floor. If it
    // were admitted, the band would total 85 clicks in 4,050 impressions and `d`'s baseline would be
    // 85/3,050 = 278.69 -> 279 rather than 200.
    const withThin = ctrOutliers([...band, pair('thin', 25, 50, 740)], CONFIG)
    expect(withThin[0]?.shortfallBp).toBe(200)
    expect(withThin.map((finding) => finding.query)).toEqual(['gseo03 fixture d'])
  })

  it('reports nothing when the peers of a band have no impressions to weigh', () => {
    // Reachable only with a zero impression floor, and then it is an ordinary state rather than an error:
    // three impressionless pairs have no rate to compare anything against.
    const rows = [pair('a', 0, 0, 900), pair('b', 0, 0, 910), pair('c', 0, 0, 920)]
    expect(ctrOutliers(rows, { ...CONFIG, minImpressions: 0 })).toEqual([])
  })
})

describe('compareCtrOutlier', () => {
  it('ranks by shortfall, then impressions, then the pair itself', () => {
    const finding = (over: Partial<CtrOutlier>): CtrOutlier => ({
      query: 'q',
      page: 'p',
      clicks: 0,
      impressions: 100,
      avgPositionCenti: 600,
      positionBand: 6,
      ctrBp: 0,
      peerCtrBp: 200,
      shortfallBp: 200,
      peerGroups: 2,
      ...over,
    })
    expect(compareCtrOutlier(finding({ shortfallBp: 300 }), finding({}))).toBeLessThan(0)
    expect(
      compareCtrOutlier(finding({ impressions: 900 }), finding({ impressions: 100 })),
    ).toBeLessThan(0)
    expect(compareCtrOutlier(finding({ query: 'a' }), finding({ query: 'b' }))).toBeLessThan(0)
    expect(compareCtrOutlier(finding({}), finding({}))).toBe(0)
  })
})

describe('the configuration', () => {
  const refused: readonly [string, Partial<CtrOutlierConfig>, string][] = [
    ['a fractional threshold', { minShortfallBp: 1.5 }, 'minShortfallBp must be a whole number'],
    [
      'a window opening above the first result',
      { minPositionCenti: 0 },
      'minPositionCenti is below position 1.00',
    ],
    [
      'a window that ends before it starts',
      { maxPositionCenti: 400 },
      'maxPositionCenti is below minPositionCenti',
    ],
    ['a negative impression floor', { minImpressions: -1 }, 'minImpressions cannot be negative'],
    [
      'a zero shortfall, which would report half the site',
      { minShortfallBp: 0 },
      'minShortfallBp must be at least 1 basis point',
    ],
    ['no peers at all', { minPeerGroups: 0 }, 'minPeerGroups must be at least 1'],
  ]
  for (const [name, over, message] of refused) {
    it(`refuses ${name}`, () => {
      let thrown: unknown
      try {
        ctrOutliers([], { ...CONFIG, ...over })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AppError)
      expect((thrown as AppError).message).toContain(message)
      expect((thrown as AppError).details).toMatchObject({
        reason: 'seo_ctr_outlier_config_invalid',
      })
    })
  }

  it('accepts the shape every test in this file uses, so the refusals above mean something', () => {
    expect(ctrOutliers([], CONFIG)).toEqual([])
  })
})

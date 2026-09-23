import { isAppError } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ASIA_DUBAI, type Instant, instantFromIso, localDate, type TimeZone } from '../time.ts'
import {
  CANDIDATE_MANDATORY_CREDENTIALS,
  CREDENTIAL_STATUSES,
  type CredentialPolicy,
  type CredentialStatus,
  credentialStatusFor,
  evaluateCredentials,
  type HeldCredential,
  isWorseThan,
  PROVISIONAL_EXPIRING_SOON_DAYS,
  statusSatisfies,
  worstStatus,
} from './credentials.ts'

/**
 * P-HR-02 — the pure credential evaluator.
 *
 * Four claims, and each is paired with the control that must fail (brief rule 3):
 *
 *   1. a table over every mandatory type produces all four statuses, and the table is asserted to be
 *      COMPLETE — every type times every status — so a status nobody exercised is a failure here rather
 *      than a gap discovered on the screen;
 *   2. the expiry boundary is Asia/Dubai. The control is the instant a UTC implementation gets wrong,
 *      and it is asserted directly against a UTC-zone evaluation of the same document so the test says
 *      what the wrong answer is instead of merely asserting the right one;
 *   3. eligibility is an **if and only if**, over random document sets, with a deliberately wrong
 *      predicate run over the same generated cases and asserted to disagree — a property whose negation
 *      nothing could produce is a property that has not been tested;
 *   4. a type declared non-expiring never returns EXPIRED, with the same document under a policy that
 *      does not declare it as the control.
 *
 * Every instant in this file is written with its offset (`+04:00`) rather than as a `Z` time, because
 * the subject is a zone boundary and a reader has to be able to see which side of it each case is on.
 */

const at = (iso: string): Instant => instantFromIso(iso)
const expiry = (value: string) => localDate(value)

/** The six of docs/01 decision 20's stricter reading, which is what the migration's DEFAULT holds. */
const MANDATORY = [...CANDIDATE_MANDATORY_CREDENTIALS.healthcare]

const policy = (overrides: Partial<CredentialPolicy> = {}): CredentialPolicy => ({
  mandatoryTypes: MANDATORY,
  nonExpiringTypes: [],
  expiringSoonDays: PROVISIONAL_EXPIRING_SOON_DAYS,
  ...overrides,
})

/** Midday Dubai on 2026-03-01, far from any boundary, so a case about something else is not about time. */
const NOON = at('2026-03-01T12:00:00+04:00')

describe('the status vocabulary', () => {
  it('orders the four statuses from best to worst and satisfies exactly two of them', () => {
    expect([...CREDENTIAL_STATUSES]).toEqual(['VALID', 'EXPIRING_SOON', 'EXPIRED', 'MISSING'])
    expect(CREDENTIAL_STATUSES.filter(statusSatisfies)).toEqual(['VALID', 'EXPIRING_SOON'])
    // EXPIRING_SOON is a warning and not a refusal. The control: if it ever stops satisfying, an
    // employee 59 days from a renewal becomes unbookable overnight, which is a different product.
    expect(statusSatisfies('EXPIRING_SOON')).toBe(true)
    expect(statusSatisfies('EXPIRED')).toBe(false)
    expect(statusSatisfies('MISSING')).toBe(false)
  })

  it('ranks a worse status as worse, and ranks nothing as worse than itself', () => {
    expect(isWorseThan('MISSING', 'EXPIRED')).toBe(true)
    expect(isWorseThan('EXPIRED', 'EXPIRING_SOON')).toBe(true)
    expect(isWorseThan('EXPIRING_SOON', 'VALID')).toBe(true)
    // Both controls: the relation is strict and it is not symmetric.
    expect(isWorseThan('VALID', 'VALID')).toBe(false)
    expect(isWorseThan('VALID', 'MISSING')).toBe(false)
  })

  it('summarises a list by its worst member, and an empty list as VALID', () => {
    expect(worstStatus(['VALID', 'EXPIRING_SOON', 'EXPIRED'])).toBe('EXPIRED')
    expect(worstStatus(['VALID', 'MISSING', 'EXPIRED'])).toBe('MISSING')
    expect(worstStatus(['VALID'])).toBe('VALID')
    expect(worstStatus([])).toBe('VALID')
  })
})

describe('acceptance — every mandatory type produces MISSING, VALID, EXPIRING_SOON and EXPIRED', () => {
  /**
   * The table. One row per (type, status), built from a document the row describes.
   *
   * Written as data rather than as four `it` blocks per type because the completeness assertion below
   * is the point: 6 types times 4 statuses is 24 cases, and the one nobody wrote is the one that fails
   * in production. `null` means "file nothing", which is how MISSING is produced.
   */
  const CASES: readonly {
    readonly status: CredentialStatus
    readonly expiresOn: string | null
    readonly why: string
  }[] = [
    { status: 'MISSING', expiresOn: null, why: 'no row of this type at all' },
    { status: 'VALID', expiresOn: '2026-12-31', why: '305 days out, beyond the 60-day window' },
    { status: 'EXPIRING_SOON', expiresOn: '2026-03-31', why: '30 days out, inside the window' },
    { status: 'EXPIRED', expiresOn: '2026-02-28', why: 'yesterday' },
  ]

  const seen = new Set<string>()

  for (const documentType of MANDATORY) {
    for (const testCase of CASES) {
      it(`${documentType} is ${testCase.status} when ${testCase.why}`, () => {
        // Every OTHER mandatory type is filed and far in the future, so the case isolates one type: a
        // document set that failed two checks would still report the status under test and would hide a
        // rule that answered for the wrong type.
        const credentials: HeldCredential[] = MANDATORY.filter((t) => t !== documentType).map(
          (t) => ({ documentType: t, expiresOn: expiry('2030-01-01') }),
        )
        if (testCase.expiresOn !== null) {
          credentials.push({ documentType, expiresOn: expiry(testCase.expiresOn) })
        }
        const result = evaluateCredentials({ credentials, policy: policy(), at: NOON })
        const assessment = result.mandatory.find((a) => a.documentType === documentType)
        expect(assessment?.status, documentType).toBe(testCase.status)
        expect(assessment?.isMandatory).toBe(true)
        // The rest of the file is untouched, which is what says the answer is per type.
        for (const other of result.mandatory.filter((a) => a.documentType !== documentType)) {
          expect(other.status, other.documentType).toBe('VALID')
        }
        // And the eligibility answer follows the one status under test, in both directions.
        expect(result.eligible).toBe(statusSatisfies(testCase.status))
        expect(result.blocking.map((a) => a.documentType)).toEqual(
          statusSatisfies(testCase.status) ? [] : [documentType],
        )
        seen.add(`${documentType}:${testCase.status}`)
      })
    }
  }

  it('covered every mandatory type against every status, which is what makes the table a table', () => {
    // The control on the loop above. `CASES` and `MANDATORY` are both arrays a future edit can shorten,
    // and a table that quietly stopped covering EXPIRED would still be 18 passing tests.
    expect(MANDATORY).toHaveLength(6)
    expect(seen.size).toBe(MANDATORY.length * CREDENTIAL_STATUSES.length)
    for (const documentType of MANDATORY) {
      for (const status of CREDENTIAL_STATUSES) {
        expect(seen.has(`${documentType}:${status}`), `${documentType}:${status}`).toBe(true)
      }
    }
  })
})

describe('acceptance — the expiry boundary is Asia/Dubai and not UTC', () => {
  /** The document the criterion names: expires 2026-03-31. */
  const labourCard: HeldCredential[] = [
    { documentType: 'labour_card', expiresOn: expiry('2026-03-31') },
  ]
  const oneType = policy({ mandatoryTypes: ['labour_card'] })

  const statusAt = (iso: string, zone?: TimeZone): CredentialStatus => {
    const zoned = zone === undefined ? oneType : { ...oneType, zone }
    const result = evaluateCredentials({ credentials: labourCard, policy: zoned, at: at(iso) })
    return result.mandatory[0]?.status as CredentialStatus
  }

  it('is VALID at 2026-03-31T23:59:59+04:00, the last second of the day it expires at the end of', () => {
    // EXPIRING_SOON rather than VALID because zero days out is inside any window; the criterion's word
    // "VALID" is about the document being current, which `statusSatisfies` is the predicate for.
    expect(statusAt('2026-03-31T23:59:59+04:00')).toBe('EXPIRING_SOON')
    expect(statusSatisfies(statusAt('2026-03-31T23:59:59+04:00'))).toBe(true)
    const result = evaluateCredentials({
      credentials: labourCard,
      policy: oneType,
      at: at('2026-03-31T23:59:59+04:00'),
    })
    expect(result.asOfDate).toBe('2026-03-31')
    expect(result.mandatory[0]?.daysUntilExpiry).toBe(0)
    expect(result.eligible).toBe(true)
  })

  it('is EXPIRED at 2026-04-01T00:00:00+04:00, one second later', () => {
    expect(statusAt('2026-04-01T00:00:00+04:00')).toBe('EXPIRED')
    const result = evaluateCredentials({
      credentials: labourCard,
      policy: oneType,
      at: at('2026-04-01T00:00:00+04:00'),
    })
    expect(result.asOfDate).toBe('2026-04-01')
    expect(result.mandatory[0]?.daysUntilExpiry).toBe(-1)
    expect(result.eligible).toBe(false)
  })

  it('says what the UTC answer would have been, which is the control on the two cases above', () => {
    /*
      The single most likely defect in this unit, asserted as a difference rather than as a hope.

      `2026-04-01T00:00:00+04:00` is `2026-03-31T20:00:00Z`. A UTC comparison reads the date as the 31st
      and reports the document still current, so the therapist keeps taking bookings for four hours after
      the credential lapsed — every night, and invisibly, because the answer is right for twenty hours out
      of twenty-four. Evaluating the same document in the UTC zone reproduces exactly that wrong answer,
      which is what makes the Dubai assertion above a test of the zone and not of the arithmetic.
    */
    const utc = 'UTC' as TimeZone
    expect(statusAt('2026-04-01T00:00:00+04:00', utc)).toBe('EXPIRING_SOON')
    expect(statusAt('2026-04-01T00:00:00+04:00')).toBe('EXPIRED')
    // And the four-hour window closes: by 04:00 Dubai the UTC date has caught up and both agree, which
    // is why a test at any other hour of the day cannot tell the two implementations apart.
    expect(statusAt('2026-04-01T04:00:00+04:00', utc)).toBe('EXPIRED')
    expect(statusAt('2026-03-31T23:59:59+04:00', utc)).toBe('EXPIRING_SOON')
  })

  it('defaults to Asia/Dubai rather than to the host, so an unset zone is not a UTC comparison', () => {
    const withZone = evaluateCredentials({
      credentials: labourCard,
      policy: { ...oneType, zone: ASIA_DUBAI },
      at: at('2026-04-01T00:00:00+04:00'),
    })
    const withoutZone = evaluateCredentials({
      credentials: labourCard,
      policy: oneType,
      at: at('2026-04-01T00:00:00+04:00'),
    })
    expect(withoutZone.asOfDate).toBe(withZone.asOfDate)
    expect(withoutZone.mandatory[0]?.status).toBe('EXPIRED')
  })

  it('puts the window boundary on the same footing: 60 days is soon and 61 is not', () => {
    const on = (expiresOn: string) =>
      evaluateCredentials({
        credentials: [{ documentType: 'labour_card', expiresOn: expiry(expiresOn) }],
        policy: oneType,
        at: at('2026-03-01T00:00:00+04:00'),
      }).mandatory[0]
    // 2026-03-01 + 60 days = 2026-04-30; + 61 = 2026-05-01.
    expect(on('2026-04-30')?.status).toBe('EXPIRING_SOON')
    expect(on('2026-04-30')?.daysUntilExpiry).toBe(60)
    expect(on('2026-05-01')?.status).toBe('VALID')
    expect(on('2026-05-01')?.daysUntilExpiry).toBe(61)
  })

  it('takes the LATEST expiry per type, because a renewal is a new row and not an edit', () => {
    const renewed: HeldCredential[] = [
      { documentType: 'labour_card', expiresOn: expiry('2026-02-28') },
      { documentType: 'labour_card', expiresOn: expiry('2027-06-30') },
    ]
    const result = evaluateCredentials({ credentials: renewed, policy: oneType, at: NOON })
    expect(result.mandatory[0]?.status).toBe('VALID')
    expect(result.mandatory[0]?.expiresOn).toBe('2027-06-30')
    // The control: the same two rows in the other order must give the same answer. A rule that took the
    // first row the driver returned would report a therapist expired on a licence already replaced, and
    // row order out of PostgreSQL is not a promise.
    expect(
      evaluateCredentials({ credentials: [...renewed].reverse(), policy: oneType, at: NOON })
        .mandatory[0]?.status,
    ).toBe('VALID')
  })
})

describe('acceptance — a type configured as non-expiring never returns EXPIRED', () => {
  const emiratisation: HeldCredential[] = [
    { documentType: 'emiratisation_record', expiresOn: null },
  ]
  const mandatoryTypes = ['emiratisation_record']

  it('is VALID with a null expiry date when the profile declares the type non-expiring', () => {
    const result = evaluateCredentials({
      credentials: emiratisation,
      policy: policy({ mandatoryTypes, nonExpiringTypes: ['emiratisation_record'] }),
      at: NOON,
    })
    expect(result.mandatory[0]?.status).toBe('VALID')
    expect(result.mandatory[0]?.expiresOn).toBeNull()
    // Null and not a number: there is nothing to count down to, and `Infinity` would sort as the least
    // urgent row in a list where the question does not apply at all.
    expect(result.mandatory[0]?.daysUntilExpiry).toBeNull()
    expect(result.eligible).toBe(true)
  })

  it('is VALID even with an expiry date long past, because the declaration is the authority', () => {
    const result = evaluateCredentials({
      credentials: [{ documentType: 'emiratisation_record', expiresOn: expiry('2001-01-01') }],
      policy: policy({ mandatoryTypes, nonExpiringTypes: ['emiratisation_record'] }),
      at: NOON,
    })
    expect(result.mandatory[0]?.status).toBe('VALID')
    // The acceptance criterion is that such a type NEVER returns EXPIRED. A rule written as "VALID if
    // the date is null" would report this row expired for a document that cannot expire.
    expect(result.mandatory[0]?.status).not.toBe('EXPIRED')
  })

  it('never returns EXPIRED for a declared type at any instant, which is the whole claim', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        // Dates as strings rather than through `fc.date`: that arbitrary can produce an Invalid Date,
        // which `localDate` rightly refuses, and the property under test is about the status and not
        // about the brand's validation.
        fc.option(fc.constantFrom('2001-01-01', '2026-03-01', '2099-12-31'), { nil: null }),
        (millis, date) => {
          const result = evaluateCredentials({
            credentials: [
              {
                documentType: 'emiratisation_record',
                expiresOn: date === null ? null : expiry(date),
              },
            ],
            policy: policy({ mandatoryTypes, nonExpiringTypes: ['emiratisation_record'] }),
            at: millis as Instant,
          })
          return result.mandatory[0]?.status === 'VALID'
        },
      ),
      { numRuns: 500 },
    )
  })

  it('the control: the same row under a policy that does NOT declare it is refused', () => {
    // Without this the case above is satisfied by a rule that returns VALID for everything. A null
    // expiry on a type that expires is MISSING — fail-closed, because a document whose expiry nobody
    // recorded says nothing about whether the credential is current.
    const undeclared = evaluateCredentials({
      credentials: emiratisation,
      policy: policy({ mandatoryTypes, nonExpiringTypes: [] }),
      at: NOON,
    })
    expect(undeclared.mandatory[0]?.status).toBe('MISSING')
    expect(undeclared.eligible).toBe(false)
    // And a dated row on an undeclared type is judged on its date, which is the ordinary path.
    expect(
      evaluateCredentials({
        credentials: [{ documentType: 'emiratisation_record', expiresOn: expiry('2001-01-01') }],
        policy: policy({ mandatoryTypes, nonExpiringTypes: [] }),
        at: NOON,
      }).mandatory[0]?.status,
    ).toBe('EXPIRED')
  })
})

describe('acceptance — eligible if and only if every mandatory type has an unexpired document', () => {
  const TYPES = [...MANDATORY, 'passport', 'training_certificate']
  const DATES = ['2020-01-01', '2026-02-28', '2026-03-01', '2026-03-31', '2027-01-01']

  /** Random documents over eight types, five dates and the null expiry the schema now permits. */
  const credentialsArb = fc.array(
    fc.record({
      documentType: fc.constantFrom(...TYPES),
      expiresOn: fc.option(fc.constantFrom(...DATES), { nil: null }),
    }),
    { maxLength: 12 },
  )

  const policyArb = fc.record({
    mandatoryTypes: fc.uniqueArray(fc.constantFrom(...TYPES), { maxLength: 6 }),
    nonExpiringTypes: fc.uniqueArray(fc.constantFrom(...TYPES), { maxLength: 3 }),
    expiringSoonDays: fc.integer({ min: 0, max: 400 }),
  })

  const materialise = (raw: readonly { documentType: string; expiresOn: string | null }[]) =>
    raw.map((row) => ({
      documentType: row.documentType,
      expiresOn: row.expiresOn === null ? null : expiry(row.expiresOn),
    }))

  /**
   * The specification, written independently of the implementation.
   *
   * Deliberately NOT a call into `credentialStatusFor`: a predicate expressed in the terms of the thing
   * under test agrees with it by construction. This is the acceptance criterion's own sentence — every
   * mandatory type has an unexpired document — as the shortest expression of it that does not reuse the
   * code being checked.
   */
  const specificationSaysEligible = (
    credentials: readonly HeldCredential[],
    p: { mandatoryTypes: readonly string[]; nonExpiringTypes: readonly string[] },
    asOfDate: string,
  ): boolean =>
    p.mandatoryTypes.every((documentType) => {
      const held = credentials.filter((c) => c.documentType === documentType)
      if (held.length === 0) return false
      if (p.nonExpiringTypes.includes(documentType)) return true
      return held.some((c) => c.expiresOn !== null && c.expiresOn >= asOfDate)
    })

  it('agrees with the specification in both directions over random inputs', () => {
    fc.assert(
      fc.property(credentialsArb, policyArb, fc.constantFrom(...DATES), (raw, p, day) => {
        const credentials = materialise(raw)
        const instant = at(`${day}T09:00:00+04:00`)
        const result = evaluateCredentials({ credentials, policy: { ...p }, at: instant })
        return result.eligible === specificationSaysEligible(credentials, p, day)
      }),
      { numRuns: 3000 },
    )
  })

  it('returns eligible for no other input combination, stated as the contrapositive', () => {
    // The "no other input combination returns eligible" half, asserted directly: whenever the evaluator
    // says eligible, every mandatory type is satisfiable from the rows, and whenever it says not, at
    // least one named type is in `blocking`.
    fc.assert(
      fc.property(credentialsArb, policyArb, fc.constantFrom(...DATES), (raw, p, day) => {
        const credentials = materialise(raw)
        const result = evaluateCredentials({
          ...{ credentials, policy: { ...p } },
          at: at(`${day}T09:00:00+04:00`),
        })
        if (result.eligible) {
          return (
            result.blocking.length === 0 &&
            result.mandatory.every((a) => statusSatisfies(a.status)) &&
            specificationSaysEligible(credentials, p, day)
          )
        }
        return (
          result.blocking.length > 0 &&
          result.blocking.every((a) => a.isMandatory && !statusSatisfies(a.status)) &&
          !specificationSaysEligible(credentials, p, day)
        )
      }),
      { numRuns: 3000 },
    )
  })

  it('the control: a deliberately wrong predicate disagrees with the evaluator on these inputs', () => {
    /*
      Brief rule 3. `fc.assert` over a property that nothing can falsify passes, and a generator whose
      cases are all eligible — or all ineligible — is exactly that: the two properties above would hold
      against an implementation that returned a constant.

      So the same generator is run against `some` in place of `every`, and the run is required to find a
      disagreement. That proves the generated space straddles the boundary in both directions, which is
      the only thing that makes the two properties above evidence.
    */
    const wrong = (
      credentials: readonly HeldCredential[],
      p: { mandatoryTypes: readonly string[]; nonExpiringTypes: readonly string[] },
      asOfDate: string,
    ): boolean =>
      p.mandatoryTypes.some((documentType) => {
        const held = credentials.filter((c) => c.documentType === documentType)
        if (held.length === 0) return false
        if (p.nonExpiringTypes.includes(documentType)) return true
        return held.some((c) => c.expiresOn !== null && c.expiresOn >= asOfDate)
      })

    let agreements = 0
    let disagreements = 0
    fc.assert(
      fc.property(credentialsArb, policyArb, fc.constantFrom(...DATES), (raw, p, day) => {
        const credentials = materialise(raw)
        const result = evaluateCredentials({
          credentials,
          policy: { ...p },
          at: at(`${day}T09:00:00+04:00`),
        })
        if (result.eligible === wrong(credentials, p, day)) agreements += 1
        else disagreements += 1
        return true
      }),
      { numRuns: 3000 },
    )
    // Both, not just the disagreement: a generator that produced only falsifying cases would be as
    // uninformative in the other direction.
    expect(disagreements).toBeGreaterThan(0)
    expect(agreements).toBeGreaterThan(0)
  })

  it('an empty mandatory set is eligible, because no credential gate is a legitimate configuration', () => {
    const result = evaluateCredentials({
      credentials: [],
      policy: policy({ mandatoryTypes: [] }),
      at: NOON,
    })
    expect(result.eligible).toBe(true)
    expect(result.mandatory).toEqual([])
    expect(result.blocking).toEqual([])
    // The control: a non-empty set over the same empty file is not eligible, so the case above is about
    // the empty list and not about the evaluator having stopped checking.
    expect(evaluateCredentials({ credentials: [], policy: policy(), at: NOON }).eligible).toBe(
      false,
    )
  })
})

describe('the shape of the answer', () => {
  it('reports non-mandatory documents separately, sorted, and never in blocking', () => {
    const result = evaluateCredentials({
      credentials: [
        { documentType: 'training_certificate', expiresOn: expiry('2020-01-01') },
        { documentType: 'passport', expiresOn: expiry('2030-01-01') },
        ...MANDATORY.map((documentType) => ({ documentType, expiresOn: expiry('2030-01-01') })),
      ],
      policy: policy(),
      at: NOON,
    })
    expect(result.other.map((a) => a.documentType)).toEqual(['passport', 'training_certificate'])
    expect(result.other.every((a) => a.isMandatory === false)).toBe(true)
    // An expired passport is reported and does not block: the mandatory set decides eligibility, and a
    // non-mandatory expiry is information for the screen. The day a lawyer makes it mandatory, the
    // profile changes and this row moves into `mandatory` with no code change.
    expect(result.other.find((a) => a.documentType === 'training_certificate')?.status).toBe(
      'EXPIRED',
    )
    expect(result.eligible).toBe(true)
    expect(result.blocking).toEqual([])
  })

  it('orders blocking worst first, so a screen shows the missing document above the expiring one', () => {
    const result = evaluateCredentials({
      credentials: [
        { documentType: 'labour_card', expiresOn: expiry('2020-01-01') },
        { documentType: 'emirates_id', expiresOn: expiry('2030-01-01') },
        { documentType: 'residence_visa', expiresOn: expiry('2030-01-01') },
      ],
      policy: policy(),
      at: NOON,
    })
    expect(result.blocking.map((a) => a.status)).toEqual([
      'MISSING',
      'MISSING',
      'MISSING',
      'EXPIRED',
    ])
    // Ties broken by name, so the list is deterministic and a screenshot repeats.
    expect(
      result.blocking.filter((a) => a.status === 'MISSING').map((a) => a.documentType),
    ).toEqual([
      'good_conduct_certificate',
      'medical_fitness_certificate',
      'occupational_health_card',
    ])
  })

  it('keeps the profile’s order for the mandatory list and de-duplicates a repeated label', () => {
    const result = evaluateCredentials({
      credentials: [],
      policy: policy({ mandatoryTypes: ['residence_visa', 'labour_card', 'residence_visa'] }),
      at: NOON,
    })
    // The profile's order, not sorted: the panel lists what the admin edited.
    expect(result.mandatory.map((a) => a.documentType)).toEqual(['residence_visa', 'labour_card'])
    // And the duplicate is reported once, not twice, in blocking as well.
    expect(result.blocking).toHaveLength(2)
  })

  it('echoes the instant it was given and the local date it compared against', () => {
    const instant = at('2026-03-01T01:30:00+04:00')
    const result = evaluateCredentials({ credentials: [], policy: policy(), at: instant })
    expect(result.evaluatedAt).toBe(instant)
    // 01:30 Dubai is still 2026-02-28 in UTC. The credential comparison is a calendar-date comparison in
    // the emirate, so this is the local date — business_day is a different question and is
    // `resolveTradingDate`'s (docs/01 decision 22).
    expect(result.asOfDate).toBe('2026-03-01')
  })

  it('refuses a window that is negative or fractional rather than drawing a badge nobody can date', () => {
    for (const expiringSoonDays of [-1, 0.5, Number.NaN]) {
      let caught: unknown
      try {
        evaluateCredentials({ credentials: [], policy: policy({ expiringSoonDays }), at: NOON })
      } catch (error) {
        caught = error
      }
      expect(isAppError(caught), String(expiringSoonDays)).toBe(true)
    }
    // Zero is legitimate — "warn me on the day" — and is the control that says the guard is about the
    // shape of the number and not about the number being small.
    expect(() =>
      evaluateCredentials({ credentials: [], policy: policy({ expiringSoonDays: 0 }), at: NOON }),
    ).not.toThrow()
  })
})

describe('credentialStatusFor, on its own', () => {
  it('answers for one type without a whole file, which is what the screen’s row badge needs', () => {
    const args = {
      documentType: 'labour_card',
      credentials: [{ documentType: 'labour_card', expiresOn: expiry('2026-03-31') }],
      asOfDate: expiry('2026-03-01'),
      expiringSoonDays: 60,
      nonExpiring: false,
    }
    expect(credentialStatusFor(args)).toEqual({ status: 'EXPIRING_SOON', expiresOn: '2026-03-31' })
    expect(credentialStatusFor({ ...args, expiringSoonDays: 10 })).toEqual({
      status: 'VALID',
      expiresOn: '2026-03-31',
    })
    expect(credentialStatusFor({ ...args, documentType: 'emirates_id' })).toEqual({
      status: 'MISSING',
      expiresOn: null,
    })
  })
})

describe('the candidate readings of Y1-licence', () => {
  it('records both readings, with wellness a strict subset of the stricter one', () => {
    const { healthcare, wellness } = CANDIDATE_MANDATORY_CREDENTIALS
    expect(healthcare).toHaveLength(6)
    expect(wellness).toHaveLength(3)
    for (const documentType of wellness) expect(healthcare).toContain(documentType)
    // The difference is the three screening documents docs/04 §7 marks [UNVERIFIED] — which is the part
    // that actually follows the licence classification.
    expect(healthcare.filter((t) => !(wellness as readonly string[]).includes(t))).toEqual([
      'occupational_health_card',
      'medical_fitness_certificate',
      'good_conduct_certificate',
    ])
  })

  it('is consulted by nothing: a profile carrying neither reading is honoured as written', () => {
    /*
      The control the caller of this constant most needs. If the evaluator derived the mandatory set from
      a licence class instead of reading the row, a set that is neither candidate would be ignored — and
      every other assertion in this file would still pass, because every other assertion uses one of the
      two candidates.
    */
    const invented = ['passport', 'training_certificate']
    const result = evaluateCredentials({
      credentials: [{ documentType: 'passport', expiresOn: expiry('2030-01-01') }],
      policy: policy({ mandatoryTypes: invented }),
      at: NOON,
    })
    expect(result.mandatory.map((a) => a.documentType)).toEqual(invented)
    expect(result.blocking.map((a) => a.documentType)).toEqual(['training_certificate'])
    // And nothing from the healthcare reading leaked in.
    expect(result.mandatory.some((a) => a.documentType === 'labour_card')).toBe(false)
  })

  it('states the provisional window once, so the registry default and this constant cannot drift', () => {
    expect(PROVISIONAL_EXPIRING_SOON_DAYS).toBe(60)
  })
})

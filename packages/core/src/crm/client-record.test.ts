import { describe, expect, it } from 'vitest'
import {
  CLIENT_RECORD_AUDIENCES,
  CLIENT_RECORD_AUDIENCES_ORDER,
  CLIENT_RECORD_ERRORS,
  CLIENT_RECORD_KEYS,
  type ClientRecordAudience,
  type ClientRecordFacts,
  clientRecordFieldAudience,
  clientRecordKeysFor,
  serialiseClientRecord,
} from './client-record.ts'

/**
 * C-CRM-01's acceptance line: "a serialiser test enumerating the public and customer-facing DTO key sets
 * asserts the flag appears in neither".
 *
 * The key sets are written out as literals below and compared for equality, which is the difference
 * between this test and the one the acceptance line warns against. `expect(dto.doNotPair).toBeUndefined()`
 * passes for a record that has stopped carrying the field for an unrelated reason, passes when the field
 * is renamed, and says nothing at all about the next internal field somebody adds. An enumerated key set
 * fails on all three.
 */
const FACTS: ClientRecordFacts = {
  // `Customer 0042` — a record label, not a name. Nothing in this repository invents a name (ADR 0020).
  label: 'Customer 0042',
  displayName: null,
  locale: 'en',
  phoneE164: '+971590000042',
  preferences: {
    preferredLanguage: 'ar',
    preferredTherapistGender: 'female',
    preferredRoomType: 'standard',
    pressureNote: 'Lighter on the shoulders.',
    oilNote: null,
    musicNote: null,
  },
  customerId: '00000000-0000-7000-8000-000000000042',
  lifecycleState: 'active',
  lifecycleChangedAtIso: '2026-09-18T18:00:00.000Z',
  acquisitionSource: 'walk_in',
  isVip: true,
  vipSinceIso: '2026-08-01T10:00:00.000Z',
  tags: ['deep-tissue', 'evenings'],
  doNotPairTherapistIds: ['00000000-0000-7000-8000-0000000000aa'],
  blocklistedKeyKinds: [],
  staffNotes: 'Asked not to be paired again after 2026-08-20.',
}

/** The three sets, written out. Sorted, because `clientRecordKeysFor` sorts. */
const PUBLIC_KEYS = ['label'] as const
const CUSTOMER_KEYS = ['displayName', 'label', 'locale', 'phoneE164', 'preferences'] as const
const STAFF_KEYS = [
  'acquisitionSource',
  'blocklistedKeyKinds',
  'customerId',
  'displayName',
  'doNotPairTherapistIds',
  'isVip',
  'label',
  'lifecycleChangedAtIso',
  'lifecycleState',
  'locale',
  'phoneE164',
  'preferences',
  'staffNotes',
  'tags',
  'vipSinceIso',
] as const

describe('the key sets, enumerated', () => {
  it('is exactly these keys for the public audience', () => {
    expect(CLIENT_RECORD_KEYS.public).toEqual([...PUBLIC_KEYS])
    expect(Object.keys(serialiseClientRecord('public', FACTS)).sort()).toEqual([...PUBLIC_KEYS])
  })

  it('is exactly these keys for the customer-facing audience', () => {
    expect(CLIENT_RECORD_KEYS.customer).toEqual([...CUSTOMER_KEYS])
    expect(Object.keys(serialiseClientRecord('customer', FACTS)).sort()).toEqual([...CUSTOMER_KEYS])
  })

  it('is exactly these keys for staff, which is the whole record', () => {
    expect(CLIENT_RECORD_KEYS.staff).toEqual([...STAFF_KEYS])
    expect(Object.keys(serialiseClientRecord('staff', FACTS)).sort()).toEqual([...STAFF_KEYS])
    // The control on the two assertions above: the staff set must be the record itself, or "absent from
    // the public set" could be satisfied by a field that is absent everywhere.
    expect([...STAFF_KEYS]).toEqual(Object.keys(FACTS).sort())
  })

  it('does not carry the do-not-pair flag, or the blocklist, in either outward set', () => {
    for (const audience of ['public', 'customer'] as const) {
      expect(CLIENT_RECORD_KEYS[audience], audience).not.toContain('doNotPairTherapistIds')
      expect(CLIENT_RECORD_KEYS[audience], audience).not.toContain('blocklistedKeyKinds')
      expect(CLIENT_RECORD_KEYS[audience], audience).not.toContain('lifecycleState')
    }
    // And the field really is in the record, so the three assertions above are about something.
    expect(CLIENT_RECORD_KEYS.staff).toContain('doNotPairTherapistIds')
    expect(CLIENT_RECORD_KEYS.staff).toContain('blocklistedKeyKinds')
    expect(FACTS.doNotPairTherapistIds.length).toBeGreaterThan(0)
  })

  it('nests: public inside customer-facing inside staff', () => {
    const contains = (wide: readonly string[], narrow: readonly string[]) =>
      narrow.every((key) => wide.includes(key))
    expect(contains(CLIENT_RECORD_KEYS.customer, CLIENT_RECORD_KEYS.public)).toBe(true)
    expect(contains(CLIENT_RECORD_KEYS.staff, CLIENT_RECORD_KEYS.customer)).toBe(true)
    // Strictly nested, not equal: three audiences that hand out the same keys are one audience.
    expect(CLIENT_RECORD_KEYS.public.length).toBeLessThan(CLIENT_RECORD_KEYS.customer.length)
    expect(CLIENT_RECORD_KEYS.customer.length).toBeLessThan(CLIENT_RECORD_KEYS.staff.length)
  })
})

describe('the record is closed', () => {
  it('classifies every field of the facts, and nothing else', () => {
    expect(Object.keys(CLIENT_RECORD_AUDIENCES).sort()).toEqual(Object.keys(FACTS).sort())
    for (const field of Object.keys(FACTS)) {
      expect(CLIENT_RECORD_AUDIENCES_ORDER, field).toContain(clientRecordFieldAudience(field))
    }
  })

  it('reports no audience for a field it does not classify', () => {
    expect(clientRecordFieldAudience('creditCardNumber')).toBeUndefined()
    expect(clientRecordFieldAudience('__proto__')).toBeUndefined()
  })

  it('picks the classified fields rather than deleting the unclassified ones', () => {
    // The direction a closed record must fail in. A `delete`-based projection keeps anything the
    // deleting code has never heard of, so an unclassified field added to a query would leak.
    const contaminated = {
      ...FACTS,
      emiratesIdNumber: '784-1234-1234567-1',
    } as unknown as ClientRecordFacts
    const dto = serialiseClientRecord('customer', contaminated)
    expect(Object.keys(dto).sort()).toEqual([...CUSTOMER_KEYS])
    expect(JSON.stringify(dto)).not.toContain('784-')
  })

  it('refuses an audience nobody declared rather than defaulting to the widest', () => {
    expect(() => clientRecordKeysFor('internal' as ClientRecordAudience)).toThrow(
      CLIENT_RECORD_ERRORS.unknownAudience,
    )
    expect(() => serialiseClientRecord('__proto__' as ClientRecordAudience, FACTS)).toThrow(
      CLIENT_RECORD_ERRORS.unknownAudience,
    )
  })

  it('names the error so a test can assert the rule rather than an exit code', () => {
    expect(CLIENT_RECORD_ERRORS.unknownAudience).toBe('UnknownClientRecordAudience')
  })
})

describe('the therapist-gender preference cannot widen the gender rule', () => {
  it('is carried to the customer and to staff, and is a preference rather than a permission', () => {
    // B-AVAIL-05 is a hard constraint (ADR 0020). This field is deliberately not read by the
    // availability query at all: a preference that could relax a compliance constraint by being set is
    // the one shape it must not have. The assertion that keeps that true is in
    // packages/db/src/queries/availability.ts's own suites — what is provable here is that the field
    // lives on the PREFERENCES object and nowhere near the eligibility inputs.
    const dto = serialiseClientRecord('customer', FACTS)
    expect(dto.preferences?.preferredTherapistGender).toBe('female')
    expect(Object.keys(dto)).not.toContain('preferredTherapistGender')
  })
})

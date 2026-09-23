import { describe, expect, it } from 'vitest'
import {
  CONSENT_ACTOR_KINDS,
  CONSENT_CAPTURE_SOURCES,
  CONSENT_CHANNELS,
  CONSENT_KINDS,
  CONSENT_LOCALES,
  CONSENT_PURPOSES,
  consentCaptureContextSchema,
  consentRecordSchema,
  consentWordingSchema,
  isSendGatingPurpose,
  MAX_CONSENT_WORDING_LENGTH,
  PLACEHOLDER_MARKERS,
  SEND_GATING_CONSENT_PURPOSES,
} from './consent.ts'

/**
 * C-CRM-03's acceptance line "capture context is mandatory: an insert missing source, actor or locale is
 * rejected by NOT NULL constraints and by the zod schema test".
 *
 * This is the zod half. The database half is `packages/fixtures/src/consent.itest.ts`, which drives the
 * same omissions past this schema straight at PostgreSQL — because a rule that exists only here is
 * bypassed by a psql session, and a rule that exists only there reaches a customer as a 500.
 *
 * Every rejection below is paired with the acceptance that proves it is not blanket. A schema that
 * refused everything would satisfy "an insert missing the actor is rejected" perfectly.
 */
const WORDING_ID = '01998ab0-0000-7000-8000-000000000001'
const CONTACT_ID = '01998ab0-0000-7000-8000-0000000000aa'
const HASH = 'a'.repeat(64)

const VALID_CAPTURE = {
  source: 'booking_form',
  actorKind: 'customer',
  actorLabel: 'Customer 9101',
  locale: 'en',
} as const

const VALID_RECORD = {
  contactCustomerId: CONTACT_ID,
  channel: 'sms',
  purpose: 'marketing',
  kind: 'granted',
  recordedAtIso: '2026-09-18T10:00:00.000Z',
  wordingId: WORDING_ID,
  wordingHashHex: HASH,
  capture: VALID_CAPTURE,
} as const

const VALID_WORDING = {
  purpose: 'marketing',
  textEn: 'I agree that BE RELAX may send me offers by SMS.',
  textAr: 'أوافق على أن ترسل لي بي ريلاكس عروضًا عبر الرسائل القصيرة.',
  publishedAtIso: '2026-09-18T10:00:00.000Z',
  isProvisional: true,
  openQuestionId: 'Y9-consent-wording',
  provisionalNote: 'Drafted by this build.',
} as const

describe('the vocabularies are closed and say what they are', () => {
  it('declares the four purposes and the two a send may be gated on', () => {
    expect([...CONSENT_PURPOSES]).toEqual([
      'marketing',
      'review_request',
      'clinical_processing',
      'photography',
    ])
    expect([...SEND_GATING_CONSENT_PURPOSES]).toEqual(['marketing', 'review_request'])
    // Both directions, so the predicate is not "true for everything" or "true for nothing".
    for (const purpose of SEND_GATING_CONSENT_PURPOSES)
      expect(isSendGatingPurpose(purpose)).toBe(true)
    for (const purpose of ['clinical_processing', 'photography', 'service_updates', '']) {
      expect(isSendGatingPurpose(purpose), purpose).toBe(false)
    }
  })

  it('has no purpose for transactional service updates', () => {
    // Absent, not disabled. A purpose here is a value somebody could gate a booking confirmation on,
    // and the first time that gate failed closed the salon would stop confirming bookings.
    expect(CONSENT_PURPOSES as readonly string[]).not.toContain('service_updates')
    expect(CONSENT_PURPOSES as readonly string[]).not.toContain('transactional')
  })

  it('declares two record kinds and no third for "never asked"', () => {
    expect([...CONSENT_KINDS]).toEqual(['granted', 'withdrawn'])
    expect(CONSENT_KINDS as readonly string[]).not.toContain('never_asked')
    expect(CONSENT_KINDS as readonly string[]).not.toContain('unknown')
  })

  it('declares the capture sources, actor kinds, locales and channels', () => {
    expect([...CONSENT_CAPTURE_SOURCES]).toEqual([
      'booking_form',
      'front_desk',
      'whatsapp_reply',
      'preference_centre',
      'import',
    ])
    expect([...CONSENT_ACTOR_KINDS]).toEqual(['customer', 'staff', 'system'])
    expect([...CONSENT_LOCALES]).toEqual(['en', 'ar'])
    expect([...CONSENT_CHANNELS]).toEqual(['sms', 'email', 'whatsapp'])
  })
})

describe('the capture context is mandatory, field by field', () => {
  it('accepts a whole capture', () => {
    expect(consentCaptureContextSchema.safeParse(VALID_CAPTURE).success).toBe(true)
  })

  it('rejects a capture missing the source, the actor or the locale', () => {
    for (const key of ['source', 'actorKind', 'actorLabel', 'locale'] as const) {
      const { [key]: _omitted, ...rest } = VALID_CAPTURE
      const result = consentCaptureContextSchema.safeParse(rest)
      expect(result.success, `${key} must be mandatory`).toBe(false)
    }
  })

  it('rejects a blank or placeholder actor label', () => {
    for (const actorLabel of ['', '   ', 'TBC', 'pending', 'to be confirmed', '[CONFIRM]']) {
      const result = consentCaptureContextSchema.safeParse({ ...VALID_CAPTURE, actorLabel })
      expect(result.success, `"${actorLabel}" must be refused`).toBe(false)
    }
    // The control: a real label passes, so the rule above is not "every label is a placeholder".
    expect(
      consentCaptureContextSchema.safeParse({
        ...VALID_CAPTURE,
        actorLabel: 'Receptionist (desk 1)',
      }).success,
    ).toBe(true)
  })

  it('rejects a source or actor kind outside the closed sets', () => {
    expect(
      consentCaptureContextSchema.safeParse({ ...VALID_CAPTURE, source: 'email_blast' }).success,
    ).toBe(false)
    expect(
      consentCaptureContextSchema.safeParse({ ...VALID_CAPTURE, actorKind: 'agent' }).success,
    ).toBe(false)
    expect(consentCaptureContextSchema.safeParse({ ...VALID_CAPTURE, locale: 'fr' }).success).toBe(
      false,
    )
  })

  it('rejects an unexpected key rather than dropping it', () => {
    // `.strict()`. A field silently discarded on the way to a column that does not exist is how a
    // capture arrives with less context than the caller believes it sent.
    expect(
      consentCaptureContextSchema.safeParse({ ...VALID_CAPTURE, ipAddress: '10.0.0.1' }).success,
    ).toBe(false)
  })

  it('agrees with the database function on every placeholder marker', () => {
    // `is_placeholder_text` (migration 0026) is the authority. These are its markers; the itest asserts
    // the two agree against the real function rather than against this list.
    for (const marker of [
      '[confirm]',
      'to be confirmed',
      'tbc',
      'tbd',
      'pending',
      'placeholder',
      'not configured',
      'unknown',
      'todo',
      'xxx',
    ]) {
      expect(PLACEHOLDER_MARKERS.test(marker), marker).toBe(true)
      expect(PLACEHOLDER_MARKERS.test(marker.toUpperCase()), marker).toBe(true)
    }
    // The control: an ordinary label is not a marker.
    expect(PLACEHOLDER_MARKERS.test('Customer 9101')).toBe(false)
  })
})

describe('a grant must carry its wording and a withdrawal need not', () => {
  it('accepts a whole grant', () => {
    expect(consentRecordSchema.safeParse(VALID_RECORD).success).toBe(true)
  })

  it('rejects a grant with no wording version', () => {
    const result = consentRecordSchema.safeParse({
      ...VALID_RECORD,
      wordingId: null,
      wordingHashHex: null,
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('opt-in proof')
  })

  it('accepts a withdrawal with no wording version', () => {
    expect(
      consentRecordSchema.safeParse({
        ...VALID_RECORD,
        kind: 'withdrawn',
        wordingId: null,
        wordingHashHex: null,
      }).success,
    ).toBe(true)
  })

  it('rejects a half-stated wording reference in either direction', () => {
    expect(
      consentRecordSchema.safeParse({ ...VALID_RECORD, kind: 'withdrawn', wordingHashHex: null })
        .success,
    ).toBe(false)
    expect(
      consentRecordSchema.safeParse({ ...VALID_RECORD, kind: 'withdrawn', wordingId: null })
        .success,
    ).toBe(false)
  })

  it('rejects a hash that is not 64 lower-case hex characters', () => {
    for (const wordingHashHex of [HASH.toUpperCase(), 'a'.repeat(63), `${HASH}a`, 'not-a-hash']) {
      expect(consentRecordSchema.safeParse({ ...VALID_RECORD, wordingHashHex }).success).toBe(false)
    }
  })

  it('rejects a timestamp that is not an offset-bearing instant', () => {
    for (const recordedAtIso of ['2026-09-18', '2026-09-18 10:00:00', 'yesterday', '']) {
      expect(consentRecordSchema.safeParse({ ...VALID_RECORD, recordedAtIso }).success).toBe(false)
    }
  })
})

describe('a wording version states both languages, and they differ', () => {
  it('accepts a whole version', () => {
    expect(consentWordingSchema.safeParse(VALID_WORDING).success).toBe(true)
  })

  it('rejects the English text pasted into the Arabic column', () => {
    // The silent failure: an Arabic-speaking client is shown English and the record says otherwise.
    const result = consentWordingSchema.safeParse({
      ...VALID_WORDING,
      textAr: VALID_WORDING.textEn,
    })
    expect(result.success).toBe(false)
  })

  it('rejects an Arabic column with no Arabic script in it', () => {
    expect(
      consentWordingSchema.safeParse({
        ...VALID_WORDING,
        textAr: 'Nous vous enverrons des offres.',
      }).success,
    ).toBe(false)
    // The control: the real Arabic passes, so the rule is presence and not a ban on anything.
    expect(consentWordingSchema.safeParse(VALID_WORDING).success).toBe(true)
  })

  it('rejects a blank text in either language', () => {
    expect(consentWordingSchema.safeParse({ ...VALID_WORDING, textEn: '   ' }).success).toBe(false)
    expect(consentWordingSchema.safeParse({ ...VALID_WORDING, textAr: '' }).success).toBe(false)
  })

  it('rejects a text longer than the declared maximum', () => {
    expect(
      consentWordingSchema.safeParse({
        ...VALID_WORDING,
        textEn: 'a'.repeat(MAX_CONSENT_WORDING_LENGTH + 1),
      }).success,
    ).toBe(false)
    expect(
      consentWordingSchema.safeParse({
        ...VALID_WORDING,
        textEn: 'a'.repeat(MAX_CONSENT_WORDING_LENGTH),
      }).success,
    ).toBe(true)
  })

  it('rejects a provisional version that names no open question', () => {
    expect(consentWordingSchema.safeParse({ ...VALID_WORDING, openQuestionId: null }).success).toBe(
      false,
    )
    // The control: a CONFIRMED version needs none, which is what answering the question looks like.
    expect(
      consentWordingSchema.safeParse({
        ...VALID_WORDING,
        isProvisional: false,
        openQuestionId: null,
        provisionalNote: null,
      }).success,
    ).toBe(true)
  })

  it('rejects an open-question id that is not one', () => {
    for (const openQuestionId of ['consent-wording', 'Y9', '9-consent', 'Y9_consent']) {
      expect(consentWordingSchema.safeParse({ ...VALID_WORDING, openQuestionId }).success).toBe(
        false,
      )
    }
  })
})

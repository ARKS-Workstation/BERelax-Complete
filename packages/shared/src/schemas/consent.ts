/**
 * The consent contract: the purposes, the two record kinds, the capture context, and the zod schema
 * that refuses an incomplete capture at the edge.
 *
 * It lives in `shared` for the reason `schemas/catalogue.ts` states about itself: three packages need
 * the same statement of it and no two of them may import each other. `@berelax/core` resolves a
 * record log into a state (`consent/resolve.ts`), `@berelax/db` writes the rows
 * (`repositories/consent.ts`), and an admin or preference-centre route validates what a person clicked
 * before either sees it. A vocabulary declared in `db` would pull the schema mirror into `core`, which
 * the boundary rules forbid.
 *
 * Every constraint here has a counterpart in `packages/db/migrations/0056_consent.sql`, and the
 * duplication is the point: zod refuses a bad capture at the edge with a message a person can read,
 * and the database refuses it at the last possible moment with no way round it. Either alone is a gap
 * — a route is bypassable from psql, and a CHECK violation reaches a customer as a 500.
 *
 * ## Why transactional traffic is not in `CONSENT_PURPOSES`
 *
 * A booking confirmation, a reminder and an OTP are **not consent-gated** and there is deliberately no
 * purpose to record consent for them under. `evaluateGate` in `@berelax/messaging` returns `allow` for
 * a transactional message on its first line, before any store is read (ADR 0016), precisely so that an
 * unreachable consent store cannot stop a confirmation. A `service_updates` purpose here would be a
 * value somebody could later write a gate against, and the first time that gate failed closed the
 * salon would stop confirming bookings. Absent, not disabled.
 */
import { z } from 'zod'

/**
 * What consent is asked FOR. Closed, and every label is provisional (`Y9-consent-purpose`).
 *
 * The four are drawn from docs/04 §8 (consent per channel and per purpose) and §5 (the opt-in proof
 * TDRA requires before a promotional blast); nobody has stated a purpose taxonomy for this business.
 * The vocabulary is a TABLE in migration 0056 rather than a Postgres enum — the same choice 0053 made
 * for the two CRM vocabularies and for the same reason: an enum label has nowhere to carry
 * `is_provisional`, an OPEN-QUESTIONS id or a note, and a provisional value that cannot be marked
 * provisional is indistinguishable from a configured one (brief rule 15).
 */
export const CONSENT_PURPOSES = [
  'marketing',
  'review_request',
  'clinical_processing',
  'photography',
] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]

/**
 * The purposes a **promotional send** may be gated on.
 *
 * `clinical_processing` and `photography` are not messaging permissions at all: one is the lawful
 * basis for holding an intake form, the other for using somebody's image. A send path that accepted a
 * photography grant as permission to text an offer would be reading a consent record that was never
 * about messaging, and every assertion about it would pass. Mirrored by `consent_purpose.is_send_gating`
 * in 0056 and pinned to it by `packages/fixtures/src/consent.itest.ts`.
 */
export const SEND_GATING_CONSENT_PURPOSES = ['marketing', 'review_request'] as const
export type SendGatingConsentPurpose = (typeof SEND_GATING_CONSENT_PURPOSES)[number]

export const isSendGatingPurpose = (purpose: string): purpose is SendGatingConsentPurpose =>
  (SEND_GATING_CONSENT_PURPOSES as readonly string[]).includes(purpose)

/**
 * The two kinds of record, and there are only two.
 *
 * "Never asked" is the **absence** of a row and is never stored: a row saying nothing happened is a
 * row a later reader treats as a decision. A withdrawal is a new row with `kind: 'withdrawn'` and the
 * granting row is left exactly as it was — the consent table revokes UPDATE and DELETE, so a
 * correction is also a new row (ADR 0008, brief rule 9).
 */
export const CONSENT_KINDS = ['granted', 'withdrawn'] as const
export type ConsentKind = (typeof CONSENT_KINDS)[number]

/**
 * Where a capture happened. A build fact, not a business assumption, so a closed CHECK rather than a
 * provisional vocabulary — the same shape `customer.created_via` has in 0019.
 *
 * `preference_centre` names a surface C-CRM-04 builds and this build does not have yet. It is a member
 * because that link is the **only functional opt-out** in this product (an alphanumeric SMS sender ID
 * cannot receive a reply, docs/04 §5), so the schema has to be able to spell the withdrawal it
 * produces; a unit that had to add the label first would be a migration standing between a customer
 * and their opt-out. `import` is the reconstructed-contacts path (`Y8-customers`), which imports with
 * no promotional consent at all — see `docs/11-execution-plan.md` §7.
 */
export const CONSENT_CAPTURE_SOURCES = [
  'booking_form',
  'front_desk',
  'whatsapp_reply',
  'preference_centre',
  'import',
] as const
export type ConsentCaptureSource = (typeof CONSENT_CAPTURE_SOURCES)[number]

/** Who recorded it. `system` is a migration or a sweep, and it must say so rather than borrow a name. */
export const CONSENT_ACTOR_KINDS = ['customer', 'staff', 'system'] as const
export type ConsentActorKind = (typeof CONSENT_ACTOR_KINDS)[number]

/** The locale the wording was shown in. The same two labels the templates and the site are built on. */
export const CONSENT_LOCALES = ['en', 'ar'] as const
export type ConsentLocale = (typeof CONSENT_LOCALES)[number]

/** The channels a consent record can be about — `message_channel` in the database, since 0014. */
export const CONSENT_CHANNELS = ['sms', 'email', 'whatsapp'] as const
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number]

/**
 * The longest wording this system will store.
 *
 * A bound rather than a guess at the right length: the hash is over the whole text, and an unbounded
 * column is one paste away from a consent record whose "exact wording shown" is a page of HTML nobody
 * can read back. 4000 is comfortably longer than any opt-in statement and short enough to render.
 */
export const MAX_CONSENT_WORDING_LENGTH = 4000

/** A uuid in any version, lower or upper case. `uuid_generate_v7()` produces v7; nothing here cares. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The markers `is_placeholder_text` (migration 0026) treats as an unanswered value.
 *
 * Copied deliberately and stated as one regex: the database function is the authority, this is the
 * edge's readable version of it, and `consent.itest.ts` asserts the two agree on every marker rather
 * than trusting this comment.
 */
export const PLACEHOLDER_MARKERS =
  /\[confirm\]|to be confirmed|tbc|tbd|pending|placeholder|not configured|unknown|todo|xxx/i

/**
 * At least one character of Arabic script.
 *
 * The same ranges `packages/core/src/text/bidi.ts` uses to decide a string is RTL, narrowed to the
 * Arabic blocks. Presence, not a language check: the defect it catches is the English text pasted into
 * both columns, which is a copy-paste away and which nothing else would report.
 */
const ARABIC_SCRIPT = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufefc]/

/**
 * The capture context, which is mandatory.
 *
 * `source`, `actorKind`, `actorLabel` and `locale` are all required, and `actorLabel` may not be blank
 * or a placeholder. PDPL asks who consented, to what, when, and on the strength of which words; a
 * record missing any of those is a record that cannot answer the question it exists for. The database
 * refuses the same four with NOT NULL plus `is_placeholder_text` (0026), and
 * `packages/fixtures/src/consent.itest.ts` asserts both halves for each one.
 *
 * `.strict()` so an unexpected key is an error rather than data silently dropped on the way to a
 * column that does not exist.
 */
export const consentCaptureContextSchema = z
  .object({
    source: z.enum(CONSENT_CAPTURE_SOURCES),
    actorKind: z.enum(CONSENT_ACTOR_KINDS),
    actorLabel: z
      .string()
      .trim()
      .min(1, 'A consent record must name who captured it.')
      .max(200)
      // The same markers `is_placeholder_text` refuses in the database. A capture attributed to "TBC"
      // is indistinguishable, in a review a year later, from one attributed to a person.
      .refine((value) => !PLACEHOLDER_MARKERS.test(value), {
        message:
          'The actor label may not be a placeholder: a capture attributed to "TBC" or "pending" ' +
          'cannot be reviewed, and 0026 refuses it at the database as well.',
      }),
    locale: z.enum(CONSENT_LOCALES),
  })
  .strict()

export type ConsentCaptureContext = z.infer<typeof consentCaptureContextSchema>

/**
 * A consent record as it is captured. The wording is required for a GRANT and optional for a
 * withdrawal, and that asymmetry is the one decision in this file worth arguing about.
 *
 * A grant with no wording version is not a provable opt-in — TDRA wants the proof to exist before the
 * blast, not after the complaint (docs/04 §5) — so `wordingId` and `wordingHashHex` are mandatory for
 * `granted`. A **withdrawal** is accepted without either, because the realistic withdrawal is somebody
 * telling the receptionist to stop texting them, and refusing to record that until an operator can
 * produce a wording version would be a system that is easier to opt into than out of. The database
 * fences the same asymmetry with `consent_grant_carries_its_wording`.
 */
export const consentRecordSchema = z
  .object({
    contactCustomerId: z.string().regex(UUID, 'A contact id is a uuid.'),
    channel: z.enum(CONSENT_CHANNELS),
    purpose: z.enum(CONSENT_PURPOSES),
    kind: z.enum(CONSENT_KINDS),
    /** The instant the person decided, supplied by the caller's clock — never `now()` in SQL. */
    recordedAtIso: z.string().datetime({ offset: true }),
    wordingId: z.string().regex(UUID, 'A wording id is a uuid.').nullable(),
    /** Lower-case hex of the SHA-256 over the wording's EN and AR text, as the caller rendered it. */
    wordingHashHex: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'A wording hash is 64 lower-case hex characters (SHA-256).')
      .nullable(),
    capture: consentCaptureContextSchema,
  })
  .strict()
  .refine((value) => (value.wordingId === null) === (value.wordingHashHex === null), {
    message:
      'A wording reference and its hash are one fact said twice: supply both or neither. A hash with ' +
      'no version cannot be verified, and a version with no hash records nothing about what was shown.',
    path: ['wordingHashHex'],
  })
  .refine((value) => value.kind !== 'granted' || value.wordingId !== null, {
    message:
      'A GRANT must carry the wording version it was given under. Consent with no record of the words ' +
      'shown is not an opt-in proof, and TDRA asks for the proof before the send.',
    path: ['wordingId'],
  })

export type ConsentRecordInput = z.infer<typeof consentRecordSchema>

/** A wording version as it is published. Append-only: a correction is a new version, never an edit. */
export const consentWordingSchema = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    textEn: z.string().trim().min(1).max(MAX_CONSENT_WORDING_LENGTH),
    textAr: z.string().trim().min(1).max(MAX_CONSENT_WORDING_LENGTH),
    publishedAtIso: z.string().datetime({ offset: true }),
    isProvisional: z.boolean(),
    openQuestionId: z
      .string()
      .regex(/^Y[0-9]+-[a-z][a-z0-9-]*$/i)
      .nullable(),
    provisionalNote: z.string().min(1).nullable(),
  })
  .strict()
  .refine((value) => value.textEn !== value.textAr, {
    message:
      'The English and Arabic wording must differ. One text in both columns is the failure this check ' +
      'exists for: an Arabic-speaking customer is shown English and the record claims otherwise.',
    path: ['textAr'],
  })
  .refine((value) => ARABIC_SCRIPT.test(value.textAr), {
    message: 'The Arabic wording must contain Arabic script.',
    path: ['textAr'],
  })
  .refine((value) => !value.isProvisional || value.openQuestionId !== null, {
    message:
      'A provisional wording must name the open question it is provisional against. A draft nobody ' +
      'can look up is the state this flag exists to prevent.',
    path: ['openQuestionId'],
  })

export type ConsentWordingInput = z.infer<typeof consentWordingSchema>

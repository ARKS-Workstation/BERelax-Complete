import { AppError } from '@berelax/shared'
import { daysBetween } from '../purchases/payables-aging.ts'
import { ASIA_DUBAI, type Instant, type LocalDate, type TimeZone, toLocal } from '../time.ts'

/**
 * The credential evaluator: what each document an employee holds is worth at a given instant, and
 * whether the employee is eligible. Pure.
 *
 * docs/04 §7 asks for "a credential registry with expiry dates that **gates bookable availability**".
 * This module is the judgement half of that: documents and a policy in, a per-type status and one
 * boolean out. The rows are `employee_document`'s and the policy is `regulatory_profile`'s plus one
 * settings key; `@berelax/db` reads both and P-HR-03 wires the answer into the availability solver's
 * eligibility predicate.
 *
 * ## The evaluation instant is an argument, and that is the whole design
 *
 * `pnpm purity` forbids a clock in `packages/core`, and this is the module where that rule earns its
 * keep rather than merely applying. "Is this therapist's labour card current?" has a different answer
 * every day, so a hidden `Date.now()` would make every test here true only on the day it was written,
 * and would make a therapist who vanished from availability at 02:00 impossible to reproduce at 09:00.
 * The caller supplies the instant — a request time, a sweep's business-day boundary, a frozen fixture
 * clock — and the same inputs always give the same answer.
 *
 * ## Asia/Dubai is the boundary, not UTC. This is the defect this module exists to not have
 *
 * `employee_document.expires_on` is a **date**, and a credential expires at the end of that day *in the
 * emirate the document was issued in*. Dubai is UTC+4 with no DST, so a UTC comparison is not a rounding
 * difference — it is **permissive for four hours every night**. A document expiring 2026-03-31 is
 * 2026-03-31T20:00:00Z at local midnight on the 1st of April: a UTC implementation reads the date as
 * still the 31st and reports the document VALID, so the therapist keeps taking bookings until 04:00
 * local. Both instants are asserted in `credentials.test.ts` and the second one is the one that fails a
 * UTC implementation, because the first cannot tell the two apart.
 *
 * The zone is therefore an argument with a default, never an assumption: {@link ASIA_DUBAI} is the
 * business timezone (docs/01 decision 8) and the default, and a caller may pass another.
 *
 * ## Four statuses, and why MISSING is not a kind of EXPIRED
 *
 * MISSING, VALID, EXPIRING_SOON, EXPIRED. `credentialVerdict` in `../availability/eligibility-port.ts`
 * already makes the same distinction for the availability read and gives the reason: "a mandatory type
 * with no row at all is credential_missing rather than a pass", because absence of evidence is not
 * permission. They are different remedies — MISSING is a document nobody has filed, EXPIRED is a
 * renewal — and one status for both sends whoever reads the screen to the wrong place.
 *
 * EXPIRING_SOON is a **warning and not a refusal**: an employee whose every mandatory document is
 * EXPIRING_SOON is still eligible. The window is the only provisional number here — 60 days, an
 * `app_setting` flagged provisional against Y1-licence, listed by the Unconfirmed Assumptions panel —
 * and it is a policy field rather than a constant precisely so a lawyer's answer changes it without a
 * deploy.
 */

/** The four statuses, in worsening order. The array order is the ordering; see {@link isWorseThan}. */
export const CREDENTIAL_STATUSES = ['VALID', 'EXPIRING_SOON', 'EXPIRED', 'MISSING'] as const

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number]

/** The statuses that satisfy a mandatory type. EXPIRING_SOON is a warning, so it is in this set. */
const SATISFYING: ReadonlySet<CredentialStatus> = new Set<CredentialStatus>([
  'VALID',
  'EXPIRING_SOON',
])

/**
 * One document on file.
 *
 * `documentType` is a plain string and not a union, for the reason `TherapistCredential` in
 * `../availability/eligibility-port.ts` gives: the mandatory list is **data** in `regulatory_profile`,
 * so a type this build has never heard of must flow through rather than fail to typecheck. The database
 * constrains the value to the `employee_document_type` enum; narrowing it again here would make adding
 * a label a change to `packages/core`.
 *
 * `expiresOn` is nullable for exactly one case: a type the profile declares non-expiring. Migration
 * 0054's `employee_document_expiry_is_declared` trigger is what makes that the only case.
 */
export interface HeldCredential {
  readonly documentType: string
  readonly expiresOn: LocalDate | null
}

/**
 * The credential policy in force: three facts, none of them this module's to decide.
 *
 * `mandatoryTypes` and `nonExpiringTypes` are `regulatory_profile_current`'s two arrays and
 * `expiringSoonDays` is the `hr.credential_expiring_soon_days` setting. They arrive together because
 * they are read together — two reads of the profile can land either side of a version change and
 * disagree about which profile they describe.
 */
export interface CredentialPolicy {
  /** `regulatory_profile.mandatory_therapist_document_types`. Empty means no credential gate at all. */
  readonly mandatoryTypes: readonly string[]
  /** `regulatory_profile.non_expiring_document_types`. Empty is the strict reading and the default. */
  readonly nonExpiringTypes: readonly string[]
  /** `hr.credential_expiring_soon_days`. Provisional at 60 (Y1-licence). */
  readonly expiringSoonDays: number
  /** Defaults to Asia/Dubai. An argument because the boundary is a zone and never an assumption. */
  readonly zone?: TimeZone
}

/** One type's verdict. `expiresOn` is echoed so a screen can print the date it judged. */
export interface CredentialAssessment {
  readonly documentType: string
  readonly status: CredentialStatus
  /** The LATEST expiry on file for this type, or null when the type is non-expiring or unheld. */
  readonly expiresOn: LocalDate | null
  /**
   * Whole days from the evaluation date to the expiry: 0 on the last valid day, negative once expired.
   *
   * Null when there is nothing to count to — a missing document or a non-expiring type. Null and not
   * `Infinity`: a caller sorting by urgency must not be handed a number that compares as the least
   * urgent thing in the list when the truth is that the question does not apply.
   */
  readonly daysUntilExpiry: number | null
  readonly isMandatory: boolean
}

export interface CredentialEvaluation {
  readonly evaluatedAt: Instant
  /** The wall-clock date in the policy's zone that every comparison was made against. */
  readonly asOfDate: LocalDate
  /** One assessment per mandatory type, in the policy's order, held or not. */
  readonly mandatory: readonly CredentialAssessment[]
  /** One per non-mandatory type actually held, sorted by type so the output is deterministic. */
  readonly other: readonly CredentialAssessment[]
  /** True exactly when every mandatory type has an unexpired document. See {@link evaluateCredentials}. */
  readonly eligible: boolean
  /** The mandatory assessments that are not satisfying, worst first. Empty exactly when eligible. */
  readonly blocking: readonly CredentialAssessment[]
}

/** Ranks two statuses by the order of {@link CREDENTIAL_STATUSES}. Worse sorts first in `blocking`. */
function statusRank(status: CredentialStatus): number {
  return CREDENTIAL_STATUSES.indexOf(status)
}

/** True when `candidate` is the worse of the two. Exported for a screen that summarises a row. */
export function isWorseThan(candidate: CredentialStatus, other: CredentialStatus): boolean {
  return statusRank(candidate) > statusRank(other)
}

/** The single worst status in a list, or VALID for an empty one. */
export function worstStatus(statuses: readonly CredentialStatus[]): CredentialStatus {
  return statuses.reduce<CredentialStatus>(
    (worst, status) => (isWorseThan(status, worst) ? status : worst),
    'VALID',
  )
}

/** True when the status permits work. VALID and EXPIRING_SOON; the other two do not. */
export function statusSatisfies(status: CredentialStatus): boolean {
  return SATISFYING.has(status)
}

/**
 * The status of one document type at one date.
 *
 * Exported because it is the unit of the table-driven test and of the admin screen's per-row badge, and
 * because a caller occasionally has one type and not a whole file.
 *
 * The **latest** expiry among the rows held is what counts. A renewal is a new row rather than an edit
 * (`employee_document_one_row_per_expiry`), so taking the earliest — or the first the driver returned —
 * reports a therapist as expired on the strength of a licence they have already replaced.
 */
export function credentialStatusFor(args: {
  readonly documentType: string
  readonly credentials: readonly HeldCredential[]
  readonly asOfDate: LocalDate
  readonly expiringSoonDays: number
  readonly nonExpiring: boolean
}): { readonly status: CredentialStatus; readonly expiresOn: LocalDate | null } {
  const { documentType, credentials, asOfDate, expiringSoonDays, nonExpiring } = args
  const held = credentials.filter((credential) => credential.documentType === documentType)
  if (held.length === 0) return { status: 'MISSING', expiresOn: null }

  // A type the profile declares non-expiring is VALID on the strength of the row existing, whatever
  // date the row carries. Not "VALID if the date is null": the acceptance criterion is that such a type
  // NEVER returns EXPIRED, and a row that carries both the declaration and a stale date would otherwise
  // be reported expired for a document that cannot expire. The declaration is the authority; 0054's
  // trigger is what stops the two disagreeing in the database.
  if (nonExpiring) return { status: 'VALID', expiresOn: null }

  const dated = held.filter(
    (credential): credential is HeldCredential & { expiresOn: LocalDate } =>
      credential.expiresOn !== null,
  )
  // A type that expires, held with no expiry date, is MISSING and not VALID. Fail-closed, the same
  // reading `credentialVerdict` gives an absent row: a document whose expiry nobody recorded says
  // nothing about whether the credential is current, and "no date" is the shape an unfinished data
  // entry has. Unreachable from the database — 0054's trigger refuses it — and reachable from a JSON
  // payload, which is why the branch exists rather than being asserted away.
  const [first] = dated
  if (first === undefined) return { status: 'MISSING', expiresOn: null }

  const latest = dated.reduce<LocalDate>(
    (best, credential) => (credential.expiresOn > best ? credential.expiresOn : best),
    first.expiresOn,
  )
  // String comparison, not date arithmetic: `YYYY-MM-DD` sorts lexicographically exactly as it sorts
  // chronologically, and both sides are already wall-clock dates in the same zone.
  if (latest < asOfDate) return { status: 'EXPIRED', expiresOn: latest }
  const days = daysBetween(asOfDate, latest)
  return { status: days <= expiringSoonDays ? 'EXPIRING_SOON' : 'VALID', expiresOn: latest }
}

/**
 * Every mandatory type's status, every other held type's status, and the eligibility answer.
 *
 * ## The eligibility rule, stated as the biconditional it is
 *
 * `eligible` is true **if and only if** every type in `policy.mandatoryTypes` has an unexpired document
 * on file. Both directions matter and the property test asserts both: a rule that had merely stopped
 * checking would satisfy "eligible when everything is present" and nothing else, and it is the
 * converse — no other combination of inputs returns eligible — that makes the gate a gate.
 *
 * An empty `mandatoryTypes` therefore returns eligible, and that is the right answer rather than a hole:
 * an empty array means no credential gate, which 0030's comment records as "a decision a lawyer takes,
 * not a default". The default is the six-type stricter reading, in the migration, where a lawyer's
 * answer can replace it without a deploy.
 *
 * ## What is not decided here
 *
 * Employment dates, skills, the roster and approved leave. Those are
 * `../availability/eligibility-port.ts`'s, and keeping the division is what let P-HR-03 point that
 * port's `credentialVerdict` at this rule — see {@link evaluateCredentialsOn} — rather than leave two
 * answers to "is this therapist's file current" to disagree with each other.
 */
export function evaluateCredentials(args: {
  readonly credentials: readonly HeldCredential[]
  readonly policy: CredentialPolicy
  readonly at: Instant
}): CredentialEvaluation {
  const { credentials, policy, at } = args
  const zone = policy.zone ?? ASIA_DUBAI
  // The ONE place an instant becomes a date, and the reason the zone is an argument. Everything below
  // this line is date arithmetic; everything a caller can get wrong about the boundary is above it.
  const asOfDate = toLocal(at, zone).date
  return { evaluatedAt: at, ...evaluateCredentialsOn({ credentials, policy, asOfDate }) }
}

/**
 * The same judgement, at a wall-clock DATE that the caller has already resolved.
 *
 * Exported because two callers have a date and not an instant, and both of them would otherwise have to
 * invent one:
 *
 *   - `credentialVerdict` in `../availability/eligibility-port.ts`, whose input is a **trading date**.
 *     Trading runs 11:00–02:00, so the trading date is not the calendar date of any particular instant
 *     during it, and a caller that manufactured "noon on the trading date" to call
 *     {@link evaluateCredentials} would be converting a date to an instant so that this function could
 *     convert it back — two conversions whose only possible contribution is a disagreement at 02:00.
 *   - P-HR-03's nightly sweep, which judges each future appointment against **that appointment's**
 *     trading date rather than against the moment the sweep runs. A licence lapsing next week does not
 *     make tonight's appointment unservable, and it does make the one three weeks out unservable — and
 *     the sweep must agree with availability, which compares `expires_on < trading_date`.
 *
 * `asOfDate` is therefore trusted as a wall-clock date in the policy's zone. `policy.zone` is unused
 * here and that is deliberate rather than an oversight: the zone's whole job is turning an instant into
 * this date, and re-applying it to a date that already went through that conversion is how a boundary
 * moves twice.
 */
export function evaluateCredentialsOn(args: {
  readonly credentials: readonly HeldCredential[]
  readonly policy: CredentialPolicy
  readonly asOfDate: LocalDate
}): Omit<CredentialEvaluation, 'evaluatedAt'> {
  const { credentials, policy, asOfDate } = args
  if (!Number.isInteger(policy.expiringSoonDays) || policy.expiringSoonDays < 0) {
    throw new AppError(
      'validation',
      `The EXPIRING_SOON window must be a non-negative whole number of days, received ` +
        `${policy.expiringSoonDays}. A fractional or negative window is a badge that appears on a ` +
        'date nobody can name.',
      { details: { expiringSoonDays: policy.expiringSoonDays } },
    )
  }

  const nonExpiring = new Set(policy.nonExpiringTypes)
  // De-duplicated, because a profile array with a repeated label would otherwise assess the same type
  // twice and report it twice in `blocking`. Order preserved: the profile's order is what a screen
  // lists, and sorting it here would make the panel disagree with the row an admin edited.
  const mandatoryTypes = [...new Set(policy.mandatoryTypes)]
  const mandatorySet = new Set(mandatoryTypes)

  const assess = (documentType: string, isMandatory: boolean): CredentialAssessment => {
    const { status, expiresOn } = credentialStatusFor({
      documentType,
      credentials,
      asOfDate,
      expiringSoonDays: policy.expiringSoonDays,
      nonExpiring: nonExpiring.has(documentType),
    })
    return {
      documentType,
      status,
      expiresOn,
      daysUntilExpiry: expiresOn === null ? null : daysBetween(asOfDate, expiresOn),
      isMandatory,
    }
  }

  const mandatory = mandatoryTypes.map((documentType) => assess(documentType, true))
  const other = [...new Set(credentials.map((credential) => credential.documentType))]
    .filter((documentType) => !mandatorySet.has(documentType))
    .sort()
    .map((documentType) => assess(documentType, false))

  const blocking = mandatory
    .filter((assessment) => !statusSatisfies(assessment.status))
    .sort(
      (a, b) =>
        statusRank(b.status) - statusRank(a.status) || a.documentType.localeCompare(b.documentType),
    )

  return {
    asOfDate,
    mandatory,
    other,
    // Derived from `blocking` rather than computed a second time: two expressions of one rule is how
    // "eligible" and "nothing is blocking" come to disagree on the screen that shows both.
    eligible: blocking.length === 0,
    blocking,
  }
}

/**
 * The two readings of Y1-licence that docs/01 decision 20 describes, recorded rather than applied.
 *
 * **Nothing derives the mandatory set from this.** The set in force is `regulatory_profile`'s array and
 * nothing else — {@link evaluateCredentials} never consults this constant, `@berelax/db` reads the row,
 * and `packages/fixtures/src/hr-credentials.itest.ts` asserts that a profile carrying a set that is
 * NEITHER of these two is honoured exactly as written. That control is the point: a hard-coded list with
 * a licence-class lookup wrapped round it would pass every other assertion in this unit and fail that
 * one.
 *
 * What it is for is saying what the alternative is. The Unconfirmed Assumptions panel's job is to name
 * the assumption AND the answer that would change it, and "the mandatory set is provisional" is not
 * useful without "and under a wellness licence it would be these three instead". The stricter reading is
 * also what migration 0054 writes as the column DEFAULT, and the itest asserts the two agree — a
 * default in SQL and a sentence in TypeScript drifting apart is how a panel comes to describe a policy
 * the database does not have.
 *
 * The difference between the two is the three healthcare-specific documents. The labour card, the
 * Emirates ID and the residence visa are required of any employee under Federal Decree-Law 33 of 2021
 * whatever the establishment's licence says; the occupational health card, the medical-fitness test and
 * the good-conduct certificate are the ones docs/04 §7 lists under [UNVERIFIED] as therapist screening
 * requirements, which is exactly the part that follows the licence classification.
 */
export const CANDIDATE_MANDATORY_CREDENTIALS = Object.freeze({
  /** `licence_class` unconfirmed or healthcare. The default, because unconfirmed resolves to stricter. */
  healthcare: Object.freeze([
    'labour_card',
    'emirates_id',
    'residence_visa',
    'occupational_health_card',
    'medical_fitness_certificate',
    'good_conduct_certificate',
  ] as const),
  /** `licence_class` wellness: the labour and immigration documents, without the screening three. */
  wellness: Object.freeze(['labour_card', 'emirates_id', 'residence_visa'] as const),
})

/**
 * The setting key and the provisional window, re-exported from `@berelax/shared`.
 *
 * They live there and not here because three packages that may not import one another read them — the
 * registry that declares the setting, the reader that fetches it, and this evaluator — which is the same
 * argument `gender-matching.ts` makes for the matching mode. Re-exported so a call site that already has
 * this module open does not need a second import.
 */
export {
  CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
  PROVISIONAL_EXPIRING_SOON_DAYS,
} from '@berelax/shared'

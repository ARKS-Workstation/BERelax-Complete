/**
 * The therapist eligibility **port**: who may take an appointment on a trading date, and when they
 * are present.
 *
 * `solveAvailability` (B-AVAIL-02) is handed `therapistIds` and `shifts` and asks no questions about
 * either — its own header says so: *"they hand this function a list that is already eligible, which is
 * why there is no therapist-attribute logic here to disagree with theirs"*. This module is that hand.
 *
 * ## The port is the point
 *
 * Rota, leave approval, contracts and accrual are **P-HR's**, and P-HR does not exist. So eligibility
 * is an injected interface with a provisional implementation behind it, not a guess at HR's schema:
 *
 *   - {@link TherapistEligibilityProvider} is the seam. One method, one query shape, one answer shape.
 *   - {@link resolveTherapistPool} is the **rule**, pure, over facts someone else read. It is the
 *     specification of what any implementation must compute, and `@berelax/db` computes the same
 *     answer in SQL over the tables of `0030_staff_availability.sql`. The two are asserted to agree
 *     over a matrix in `packages/fixtures/src/therapist-eligibility.itest.ts`, which is the only place
 *     that may import both.
 *   - {@link staticEligibilityProvider} is the provisional implementation: facts in, a provider out,
 *     no database. It is what B-AVAIL-05 and B-AVAIL-06 test against before P-HR lands, and what a
 *     property test can drive ten thousand times.
 *
 * Filling the port later must not change the solver, so the seam is shaped around what the solver
 * already takes: a list of ids and a list of `TherapistShift`s. Nothing here is a new input to
 * `solveAvailability`, and {@link poolSolverInput} is the whole of the wiring.
 *
 * ## Day-level facts are this module's; interval arithmetic stays the solver's
 *
 * The division is deliberate and it is the thing P-HR must not blur:
 *
 *   - **Here**: is this person employed on this trading date, do they hold the skill the treatment's
 *     style requires, are their mandatory credentials unexpired, are they rostered at all, and does
 *     approved leave cover their roster. All of these are answered once per trading date.
 *   - **The solver's**: does the therapist's *buffered* interval fit inside their presence with no
 *     gap, and does it collide with an appointment they already hold. Those are per-candidate
 *     questions, asked for every start on the grid, and `intervals.ts` already answers them.
 *
 * Approved leave is subtracted from the roster **here**, into the shifts the solver receives, because
 * that keeps the solver's presence test exactly one predicate — `coveredWithoutGap` — rather than two
 * that can disagree at the boundary minute. Half a day of leave therefore shortens a therapist's
 * presence rather than removing them from the pool, and a whole day of it empties their presence and
 * reports {@link EligibilityExclusionReason} `on_approved_leave`.
 *
 * ## Asian/Arabic is a treatment STYLE and never a therapist attribute
 *
 * ADR 0021. The query carries a `requiredSkill`, which the caller derives from the service's style
 * with `requiredSkillFor` from `@berelax/shared` — there is no style on a therapist here, in
 * `employee`, or anywhere in between. A therapist may hold both skills, neither, or one, and the
 * eligibility test is set membership. Nothing in this module can read a style, which is what makes it
 * impossible for a reassignment to reprice a booking (0017: the mapping "carries no price and never
 * will").
 *
 * ## Ids, never names
 *
 * A therapist has no display name until an admin sets one, and publishing one needs a recorded
 * photography consent as well (ADR 0020). Every therapist in this module is an id.
 *
 * Pure: dates, instants and records in, a pool out. No clock, no database, no framework.
 */
import { AppError, type TherapistSkill } from '@berelax/shared'
import type { LocalDate } from '../time.ts'
import { mergePeriods } from './intervals.ts'
import type { Period } from './room-predicates.ts'
import type { TherapistShift } from './solve.ts'

/**
 * The genders same-gender matching is defined over.
 *
 * Two labels, mirroring the `employee_gender` enum of `0030_staff_availability.sql` and the fixture
 * salon's own union. It lives here because the *rule* that reads it — strict same-gender matching,
 * B-AVAIL-05 — is a scheduling rule, and because a third label changes who may be assigned to whom
 * and should therefore be a deliberate edit in one place rather than a widened string.
 */
export const THERAPIST_GENDERS = ['female', 'male'] as const
export type TherapistGender = (typeof THERAPIST_GENDERS)[number]

/**
 * Why a therapist is not in the pool for a trading date.
 *
 * Named reasons rather than a filtered list, for the reason `resolveTradingDate` and
 * `roomUnavailableReason` give: *"no availability"* is the answer the front desk cannot act on, and
 * these six are six different conversations. `credential_expired` is a renewal, `missing_skill` is a
 * training record, `not_rostered` is a rota edit, and `not_employed` is neither.
 */
export type EligibilityExclusionReason =
  /** Not employed on this trading date: before `employed_from`, or after `employed_until`. */
  | 'not_employed'
  /** Does not hold the skill the treatment's style requires (`service_skill.required_skill`). */
  | 'missing_skill'
  /** A mandatory document type has no row at all. Absence is not permission; see below. */
  | 'credential_missing'
  /** A mandatory document's latest expiry is before this trading date. */
  | 'credential_expired'
  /** No shift on this trading date. A rota question, and the only one of the six that is. */
  | 'not_rostered'
  /** Rostered, but approved leave covers every rostered minute of the date. */
  | 'on_approved_leave'

/**
 * The reasons in the order they are applied, which is also the order they are reported in.
 *
 * Exported because the SQL implementation in `@berelax/db` mirrors this `CASE` order, and two
 * orderings of one list is one list plus a future disagreement: a therapist who is both unemployed and
 * unrostered must be reported the same way by both implementations or the agreement test in
 * `packages/fixtures` is comparing two different questions.
 *
 * The order is "least specific to this date, first". Employment and skill are facts about the person;
 * credentials are facts about their file; the roster and their leave are facts about the day.
 */
export const ELIGIBILITY_EXCLUSION_REASONS: readonly EligibilityExclusionReason[] = Object.freeze([
  'not_employed',
  'missing_skill',
  'credential_missing',
  'credential_expired',
  'not_rostered',
  'on_approved_leave',
])

/** One credential on file: its type, and the date it expires at the end of. */
export interface TherapistCredential {
  /** Mirrors `employee_document_type`. A plain string, because the mandatory list is data. */
  readonly documentType: string
  /**
   * Inclusive. A licence expiring on the 18th covers the 18th's trading date — including its 01:30
   * appointment, whose *calendar* date is the 19th.
   */
  readonly expiresOn: LocalDate
}

/** A therapist as this port reads them. No name, and no rota: those are elsewhere by design. */
export interface TherapistRecord {
  readonly therapistId: string
  /**
   * Absent when nobody has told the build (Y8-staff). Carried through the pool untouched: applying it
   * is B-AVAIL-05's, and a provider that dropped it would force that unit to read `employee` again.
   */
  readonly gender?: TherapistGender
  readonly employedFrom: LocalDate
  /** Absent for open-ended employment. Not "unknown": an unknown end date is not a storable state. */
  readonly employedUntil?: LocalDate
  readonly skills: readonly TherapistSkill[]
  readonly credentials: readonly TherapistCredential[]
}

/** A period of approved leave. Only approved leave ever reaches this type. */
export interface ApprovedLeave {
  readonly therapistId: string
  readonly period: Period
}

/**
 * Everything the rule needs, as facts. All of it injected; none of it read.
 *
 * This is the shape **P-HR must be able to produce** — it is the contract, written as a type. The
 * `@berelax/db` implementation reads exactly these five things out of `employee`, `employee_skill`,
 * `shift`/`shift_assignment`, `employee_approved_leave`, `employee_document` and
 * `regulatory_profile_current`.
 */
export interface EligibilityFacts {
  /**
   * `regulatory_profile.mandatory_therapist_document_types`, read from the row in force.
   *
   * Data rather than a constant, because it follows the licence class nobody has confirmed
   * (Y1-licence): a lawyer's answer must reach the credential gate without a deploy, exactly as the
   * banned-claims lexicon does (B-CAT-05). An **empty** list is a legitimate value meaning "no
   * credential gate", and it is a decision a lawyer takes rather than a default.
   */
  readonly mandatoryDocumentTypes: readonly string[]
  readonly therapists: readonly TherapistRecord[]
  /** Rostered spans for the trading date, as written. Leave is subtracted by the rule, not here. */
  readonly shifts: readonly TherapistShift[]
  readonly approvedLeave: readonly ApprovedLeave[]
}

/** The query. One trading date, one required skill, and optionally a narrowed candidate list. */
export interface EligibilityQuery {
  /**
   * The trading date, never a calendar date. 01:30 belongs to the previous one
   * (`resolveTradingDate`), and every date comparison in this module is against this value.
   */
  readonly tradingDate: LocalDate
  /**
   * What the treatment's style requires, from `requiredSkillFor(style)` in `@berelax/shared`.
   *
   * A skill and not a style, which is the ADR 0021 seam: this module cannot be given a style, so it
   * cannot grow a rule that reads one.
   */
  readonly requiredSkill: TherapistSkill
  /**
   * Narrows the candidates to these ids. Absent means "every employee".
   *
   * Production behaviour — a customer asking for the therapist they saw last time — and also the only
   * safe way to test a db-backed provider against the shared integration database: the integration
   * suite runs sequentially against one database and earlier files leave employees behind, so a test
   * isolates itself by narrowing what the query can SEE rather than by deleting rows that
   * `shift_assignment.employee_id` protects with ON DELETE RESTRICT.
   */
  readonly therapistIds?: readonly string[]
}

/** An eligible therapist, with the two attributes a later layer needs and nothing else. */
export interface EligibleTherapist {
  readonly therapistId: string
  readonly skills: readonly TherapistSkill[]
  /** Present only when it is on record. B-AVAIL-05 decides what strict matching does with absence. */
  readonly gender?: TherapistGender
}

export interface ExcludedTherapist {
  readonly therapistId: string
  readonly reason: EligibilityExclusionReason
}

/**
 * The pool for one trading date: who, when, and who not.
 *
 * `shifts` is presence **net of approved leave**, which is what makes this directly usable as
 * `SlotRequest.shifts` with no further arithmetic — see {@link poolSolverInput}.
 */
export interface TherapistPool {
  /** Ascending by id, so a seeded fixture and a screenshot stay diffable. */
  readonly therapists: readonly EligibleTherapist[]
  /** Presence net of approved leave. Ascending by therapist id, then by start. */
  readonly shifts: readonly TherapistShift[]
  /** Ascending by id. Every candidate is in exactly one of these two lists. */
  readonly excluded: readonly ExcludedTherapist[]
}

/**
 * The port. One method, and it is asynchronous because the real implementation reads a database.
 *
 * `packages/fixtures/src/therapist-eligibility.itest.ts` pins the db-backed reader against this
 * interface with `satisfies`, and `eligibility-port.test.ts` pins the signature itself with
 * `@ts-expect-error`: a P-HR extension that widens the answer, drops the gender, returns the pool
 * synchronously or takes a second required argument fails `pnpm typecheck` rather than review.
 */
export interface TherapistEligibilityProvider {
  eligibleTherapists(query: EligibilityQuery): Promise<TherapistPool>
}

/**
 * `from` with `minus` removed. Half-open throughout, so a hole ending exactly where a period begins
 * removes nothing.
 *
 * This is the same algorithm `tradingWindowsFor` applies to premises closures, one layer down and for
 * a different resource, and the duplication is deliberate rather than overlooked:
 * `business-day/windows.ts` cannot import it from `availability/` because `intervals.ts` already
 * imports `latestStartIn` from `windows.ts`, so the dependency would be circular. `eligibility-port.
 * test.ts` therefore asserts the two agree on the same input, which turns a copy into a checked
 * mirror.
 */
export function subtractPeriods(
  from: readonly Period[],
  minus: readonly Period[],
): readonly Period[] {
  let remaining: Period[] = mergePeriods(from)
  for (const hole of mergePeriods(minus)) {
    const next: Period[] = []
    for (const period of remaining) {
      if (hole.endsAt <= period.startsAt || hole.startsAt >= period.endsAt) {
        next.push(period)
        continue
      }
      if (hole.startsAt > period.startsAt) {
        next.push({ startsAt: period.startsAt, endsAt: hole.startsAt })
      }
      if (hole.endsAt < period.endsAt) {
        next.push({ startsAt: hole.endsAt, endsAt: period.endsAt })
      }
    }
    remaining = next
  }
  return remaining
}

/**
 * One therapist's presence on the date: their rostered spans, merged, less their approved leave.
 *
 * Merged first, and that is load-bearing rather than tidy. A roster written as 11:00–18:00 and
 * 18:00–02:00 is **one** presence, and `mergePeriods` joins abutting spans precisely so that a
 * treatment crossing 18:00 is not refused because the rota was entered in two halves.
 */
export function rosteredPresence(args: {
  readonly therapistId: string
  readonly shifts: readonly TherapistShift[]
  readonly approvedLeave: readonly ApprovedLeave[]
}): readonly Period[] {
  const { therapistId, shifts, approvedLeave } = args
  return subtractPeriods(
    shifts.filter((shift) => shift.therapistId === therapistId).map((shift) => shift.period),
    approvedLeave.filter((leave) => leave.therapistId === therapistId).map((leave) => leave.period),
  )
}

/** True when the employment period covers the trading date. Both bounds inclusive. */
export function employedOn(record: TherapistRecord, tradingDate: LocalDate): boolean {
  // `YYYY-MM-DD` compares and sorts as a string, which is why `LocalDate` is one: no Date, no zone,
  // and no re-derivation of a trading date the caller already resolved.
  if (record.employedFrom > tradingDate) return false
  return record.employedUntil === undefined || tradingDate <= record.employedUntil
}

/**
 * The credential verdict for one therapist on one trading date.
 *
 * **Absence is not permission.** A therapist with no professional licence on file is not more
 * eligible than one whose licence lapsed yesterday, so a mandatory type with no row at all is
 * `credential_missing` rather than a pass. That is stricter than the acceptance line, which speaks
 * only of an expired document, and it is the same fail-closed reading `service_room_type_compat` took
 * for rooms (0012): *"structural absence is a loud failure; a fall-back is a quiet one"*. The
 * permissive alternative makes a therapist whose file was never completed indistinguishable from one
 * whose credentials were checked.
 *
 * The **latest** expiry per type is what counts, because a renewal is a new row rather than an edit
 * (`employee_document_one_row_per_expiry`): taking the earliest, or the first returned, would report a
 * therapist as expired on the strength of the licence they have already replaced.
 */
export function credentialVerdict(args: {
  readonly credentials: readonly TherapistCredential[]
  readonly mandatoryDocumentTypes: readonly string[]
  readonly tradingDate: LocalDate
}): 'ok' | 'credential_missing' | 'credential_expired' {
  const { credentials, mandatoryDocumentTypes, tradingDate } = args
  let expired = false
  for (const documentType of mandatoryDocumentTypes) {
    const held = credentials.filter((credential) => credential.documentType === documentType)
    if (held.length === 0) return 'credential_missing'
    const latest = held.reduce(
      (best, credential) => (credential.expiresOn > best ? credential.expiresOn : best),
      held[0]?.expiresOn as LocalDate,
    )
    // Inclusive: a licence valid through the 18th covers the 18th's trading date, and that date runs
    // to 02:00 on the 19th. Comparing against the slot's calendar date instead would take the last
    // two hours of every trading day away from a therapist who is licensed for all of it.
    if (latest < tradingDate) expired = true
  }
  // Missing beats expired by returning early above; expired is reported only once every mandatory type
  // has at least one row, so the two reasons cannot both be true of one answer.
  return expired ? 'credential_expired' : 'ok'
}

/**
 * The pool, from facts. The rule, and the specification the SQL implementation mirrors.
 *
 * Order of the checks is {@link ELIGIBILITY_EXCLUSION_REASONS} and nothing else, so a therapist who
 * fails two of them is reported identically by both implementations.
 */
export function resolveTherapistPool(
  facts: EligibilityFacts,
  query: EligibilityQuery,
): TherapistPool {
  const { mandatoryDocumentTypes, therapists, shifts, approvedLeave } = facts
  const { tradingDate, requiredSkill, therapistIds } = query

  const narrowed =
    therapistIds === undefined
      ? therapists
      : therapists.filter((record) => therapistIds.includes(record.therapistId))

  const eligible: EligibleTherapist[] = []
  const excluded: ExcludedTherapist[] = []
  const presence: TherapistShift[] = []

  for (const record of [...narrowed].sort((a, b) => (a.therapistId < b.therapistId ? -1 : 1))) {
    const exclude = (reason: EligibilityExclusionReason): void => {
      excluded.push({ therapistId: record.therapistId, reason })
    }
    if (!employedOn(record, tradingDate)) {
      exclude('not_employed')
      continue
    }
    if (!record.skills.includes(requiredSkill)) {
      exclude('missing_skill')
      continue
    }
    const credentials = credentialVerdict({
      credentials: record.credentials,
      mandatoryDocumentTypes,
      tradingDate,
    })
    if (credentials !== 'ok') {
      exclude(credentials)
      continue
    }
    const rostered = shifts.filter((shift) => shift.therapistId === record.therapistId)
    if (rostered.length === 0) {
      exclude('not_rostered')
      continue
    }
    const available = rosteredPresence({
      therapistId: record.therapistId,
      shifts: rostered,
      approvedLeave,
    })
    // Rostered, but leave covers all of it. Reported as leave rather than as an empty presence,
    // because "on leave" is an answer and a therapist in the pool with no minutes is not: the solver
    // would drop them silently and the gap in the day would have no explanation.
    if (available.length === 0) {
      exclude('on_approved_leave')
      continue
    }
    eligible.push({
      therapistId: record.therapistId,
      skills: [...record.skills],
      ...(record.gender === undefined ? {} : { gender: record.gender }),
    })
    for (const period of available) {
      presence.push({ therapistId: record.therapistId, period })
    }
  }

  return { therapists: eligible, shifts: presence, excluded }
}

/**
 * The provisional implementation: facts in, a provider out. Pure, and a `Promise` only to satisfy the
 * port.
 *
 * This is what B-AVAIL-05 and B-AVAIL-06 are built against before P-HR exists, and what lets a
 * property test drive ten thousand pools without a database. It is deliberately *not* a stub that
 * returns a fixed answer: a stub would let the solver be wired to a shape nothing ever computed, and
 * the first real provider would be the first time the wiring was exercised.
 */
export function staticEligibilityProvider(facts: EligibilityFacts): TherapistEligibilityProvider {
  return {
    eligibleTherapists: (query) => Promise.resolve(resolveTherapistPool(facts, query)),
  }
}

/**
 * The two `SlotRequest` fields a pool supplies. The whole of the wiring, on purpose.
 *
 * `solveAvailability` is unchanged by this unit, and this function is why: a pool becomes
 * `{ ...request, ...poolSolverInput(pool) }` and nothing in the solver has to learn what a credential
 * or a leave request is. When P-HR replaces the provider, this call site does not move.
 */
export function poolSolverInput(pool: TherapistPool): {
  readonly therapistIds: readonly string[]
  readonly shifts: readonly TherapistShift[]
} {
  return {
    therapistIds: pool.therapists.map((therapist) => therapist.therapistId),
    shifts: pool.shifts,
  }
}

/**
 * Fails when a pool does not account for every candidate it was asked about.
 *
 * Exported so an implementation — including P-HR's — can be held to it. A therapist who is in neither
 * list is the defect this catches, and it is invisible from the outside: the pool reads as a shorter
 * roster, availability is quietly narrower, and nothing says which person vanished or why. Listed
 * twice is the same defect from the other side, and it double-counts a therapist into two reasons.
 */
export function assertPoolIsTotal(pool: TherapistPool, candidateIds: readonly string[]): void {
  const answered = [
    ...pool.therapists.map((therapist) => therapist.therapistId),
    ...pool.excluded.map((therapist) => therapist.therapistId),
  ]
  const missing = candidateIds.filter((id) => !answered.includes(id))
  const duplicated = [...new Set(answered.filter((id, i) => answered.indexOf(id) !== i))]
  if (missing.length > 0 || duplicated.length > 0) {
    throw new AppError(
      'invariant_violated',
      'A therapist pool must place every candidate in exactly one of eligible or excluded. ' +
        `Unaccounted for: [${missing.join(', ')}]; listed twice: [${duplicated.join(', ')}].`,
      { details: { missing, duplicated } },
    )
  }
}

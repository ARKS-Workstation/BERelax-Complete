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
 *     style requires, are their mandatory credentials unexpired, are they rostered at all, does
 *     approved leave cover their roster, and — when the query names a client — does same-gender
 *     matching permit the pair. All of these are answered once per trading date.
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
 * ## Same-gender matching is the seventh check, and only half of it is here
 *
 * B-AVAIL-05. {@link genderVerdict} is the per-therapist half and it is applied **last** — see
 * {@link ELIGIBILITY_EXCLUSION_REASONS} for why the position is load-bearing. The other half is
 * `gender-match.ts`: the mode, what a booking request with no client gender does
 * (`requires_client_gender`, zero slots), the advisory label on a cross-gender slot, and the narrowing
 * that keeps an ineligible therapist out of the solver's candidate list rather than filtering them out
 * of its answers. The split is not taste — a port that imported `gender-match.ts`, which imports this
 * module, is a cycle that `pnpm boundaries` rejects.
 *
 * ## Ids, never names
 *
 * A therapist has no display name until an admin sets one, and publishing one needs a recorded
 * photography consent as well (ADR 0020). Every therapist in this module is an id.
 *
 * Pure: dates, instants and records in, a pool out. No clock, no database, no framework.
 */
import {
  AppError,
  type GenderMatchingMode,
  genderMatchingMode,
  type TherapistSkill,
} from '@berelax/shared'
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
 * Why a therapist is not in the pool for a trading date, or for this client.
 *
 * Named reasons rather than a filtered list, for the reason `resolveTradingDate` and
 * `roomUnavailableReason` give: *"no availability"* is the answer the front desk cannot act on, and
 * these seven are seven different conversations. `credential_expired` is a renewal, `missing_skill` is
 * a training record, `not_rostered` is a rota edit, `not_employed` is neither, and `gender_mismatch`
 * is not a question about the therapist at all — it is a question about who is asking.
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
  /** No shift on this trading date. A rota question, and the only one of the seven that is. */
  | 'not_rostered'
  /** Rostered, but approved leave covers every rostered minute of the date. */
  | 'on_approved_leave'
  /**
   * Same-gender matching excludes them from **this booking** (B-AVAIL-05, `gender-match.ts`).
   *
   * The only reason here that is not a fact about the therapist or the day: the same therapist is
   * eligible for the next client. It is therefore also the only one that is not actionable by the
   * business — there is no renewal, rota edit or training record that answers it.
   */
  | 'gender_mismatch'

/**
 * The reasons in the order they are applied, which is also the order they are reported in.
 *
 * Exported because the SQL implementation in `@berelax/db` mirrors this `CASE` order, and two
 * orderings of one list is one list plus a future disagreement: a therapist who is both unemployed and
 * unrostered must be reported the same way by both implementations or the agreement test in
 * `packages/fixtures` is comparing two different questions. That file also pins the two lists to each
 * other, as a runtime `toEqual` on the order and a compile-time check that neither union has a member
 * the other lacks — a seventh reason added to one side and not to the other is a therapist excluded for
 * a reason the caller cannot name.
 *
 * The order is "least specific to this date, first". Employment and skill are facts about the person;
 * credentials are facts about their file; the roster and their leave are facts about the day.
 *
 * `gender_mismatch` is **last**, and that is a decision rather than an appendix. Two reasons:
 *
 *   1. It is the only reason that is useful *because* everything else passed. "We have no female
 *      therapist free at 20:00" is actionable; "the therapist who left in March is the wrong gender for
 *      you" is noise, and it is what any earlier position would report.
 *   2. Reporting it for a therapist who is excluded anyway discloses a person's recorded gender to a
 *      caller that has no operational use for it. Last means the gender of a therapist is only ever
 *      named when it is the whole of the answer.
 */
export const ELIGIBILITY_EXCLUSION_REASONS: readonly EligibilityExclusionReason[] = Object.freeze([
  'not_employed',
  'missing_skill',
  'credential_missing',
  'credential_expired',
  'not_rostered',
  'on_approved_leave',
  'gender_mismatch',
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
   * Absent when nobody has told the build (Y8-staff), and absence is never a match — see
   * {@link sameGenderMatch}. Carried through the pool as well as applied, because a caller that is
   * re-validating a tuple inside the booking transaction has to be able to check the pair again
   * (`narrowPoolByGender`) without reading `employee` a second time.
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
  /**
   * The **client's** gender, when it is known. Absent is the ordinary state at a phone booking.
   *
   * A different question from the therapist's, and read in a different place: therapist gender is a
   * column on `employee`, and this is a fact about the person asking for the appointment, which no
   * table holds — `customer` has no gender column and this unit added none. It reaches the rule as an
   * argument, from the booking request, which is also why it is optional *here*: the admin calendar and
   * the reminder scheduler ask "who is working on Thursday" and have no client at all. Absent therefore
   * means "not a client-specific question", and the pool is not narrowed by gender.
   *
   * It does **not** mean "any therapist will do" for a booking. A booking request with no client gender
   * is refused outright in strict mode with the reason `requires_client_gender`, and that is
   * `solveGenderMatchedAvailability`'s (`gender-match.ts`): its request type makes the field a required
   * key with a possibly-undefined value, so a caller cannot omit it without saying so.
   */
  readonly clientGender?: TherapistGender
  /**
   * `booking.same_gender_matching`, read through `genderMatchingMode`. Absent is **strict**.
   *
   * Optional, and that is the fail-safe rather than a convenience: the strict reading has to be what a
   * caller gets for saying nothing, so that a provider, a test or a future call site that has never
   * heard of this field cannot relax a compliance constraint by omission.
   */
  readonly genderMatching?: GenderMatchingMode
}

/** An eligible therapist, with the two attributes a later layer needs and nothing else. */
export interface EligibleTherapist {
  readonly therapistId: string
  readonly skills: readonly TherapistSkill[]
  /**
   * Present only when it is on record. Under strict matching absence is a MISMATCH, not a wildcard:
   * `sameGenderMatch` is a claim about a pair and a pair with a hole in it cannot be claimed.
   */
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
 * True only when both genders are on record **and** they are the same. The primitive of B-AVAIL-05.
 *
 * `false` for an unknown gender on either side, and that is the substance of the rule rather than a
 * defensive default: same-gender matching is a claim about a pair, and a pair with a hole in it cannot
 * be claimed. Nineteen therapists have photographs and no staff list (Y8-staff), so `employee.gender`
 * is nullable and a fresh install has holes everywhere — which under strict matching means availability
 * offers **nobody** until HR data exists. That is the loud failure rather than the quiet one, and it is
 * the same argument 0030 makes for not seeding nineteen fabricated people.
 *
 * Lives here, beside the other verdicts, and not in `gender-match.ts` where the rest of the unit is:
 * `resolveTherapistPool` below has to apply it to stay in step with the SQL, and a port that imported
 * `gender-match.ts` — which imports this module — is a cycle, which `pnpm boundaries` rejects.
 */
export function sameGenderMatch(
  clientGender: TherapistGender | undefined,
  therapistGender: TherapistGender | undefined,
): boolean {
  if (clientGender === undefined || therapistGender === undefined) return false
  return clientGender === therapistGender
}

/**
 * The gender verdict for one therapist against one client, under one mode. The seventh check.
 *
 * Three ways to reach `'ok'`, and each of them is a decision:
 *
 *   - the mode is `'advisory'` — the pool is **not** narrowed, because advisory means the cross-gender
 *     slot is offered and labelled rather than withheld. Labelling it is the slot layer's
 *     (`gender-match.ts`), which is why this returns `'ok'` rather than a third verdict;
 *   - no client gender was supplied — this is not a client-specific query at all (see
 *     {@link EligibilityQuery.clientGender}). A *booking request* with no client gender is refused with
 *     `requires_client_gender`, one layer up, before any start is considered;
 *   - the two genders are on record and equal.
 *
 * Everything else is `'gender_mismatch'`, including a therapist whose gender nobody has recorded.
 */
export function genderVerdict(args: {
  readonly therapistGender?: TherapistGender
  readonly clientGender?: TherapistGender
  readonly genderMatching?: GenderMatchingMode
}): 'ok' | 'gender_mismatch' {
  // Through `genderMatchingMode` rather than `=== 'advisory'` on the raw field: one normaliser decides
  // what an absent, stale or unreadable mode means, and it decides it the same way here, in the db
  // reader and in the settings store.
  if (genderMatchingMode(args.genderMatching) !== 'strict') return 'ok'
  if (args.clientGender === undefined) return 'ok'
  return sameGenderMatch(args.clientGender, args.therapistGender) ? 'ok' : 'gender_mismatch'
}

/**
 * {@link genderVerdict} for one record under one query, with the optional keys assembled.
 *
 * A named function rather than three conditional spreads inside the loop below: under
 * `exactOptionalPropertyTypes` an absent key and a present-and-undefined one are different types, so
 * every optional field has to be spread conditionally, and three of those in a loop body is where the
 * check stops being readable.
 */
function genderExclusion(
  record: TherapistRecord,
  query: EligibilityQuery,
): 'ok' | 'gender_mismatch' {
  return genderVerdict({
    ...(record.gender === undefined ? {} : { therapistGender: record.gender }),
    ...(query.clientGender === undefined ? {} : { clientGender: query.clientGender }),
    ...(query.genderMatching === undefined ? {} : { genderMatching: query.genderMatching }),
  })
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
    // Last, which is what makes the ordering structural rather than remembered: the six checks above
    // are about the person and the day, this one is about the client, and a therapist is only ever
    // reported as the wrong gender when they would otherwise have been offered.
    if (genderExclusion(record, query) !== 'ok') {
      exclude('gender_mismatch')
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

/**
 * Same-gender matching: a **hard** constraint on availability, default strict.
 *
 * ADDED and the Department of Health licence this business, docs/04 §3 records that UAE municipal and
 * licensing practice commonly restricts massage to same-gender delivery, and ADR 0020 settles the
 * software response: *a hard constraint in the availability solver, default strict, downgradable to
 * advisory only as an audited configuration change and only once the licensing authority confirms in
 * writing*. `Y9-gender` is still **open** — the exact regulatory basis is unconfirmed, and docs/13 §5
 * notes that the live site's "ladies' therapists available on request" copy suggests something weaker.
 * Where the scope is unknown this module keeps the strict reading; it does not interpret the rule.
 *
 * ## Hard means never offered, not sorted lower
 *
 * A slot offered and then refused at booking is worse than no slot: the customer has been told yes, and
 * a non-compliant appointment found at inspection is a licence risk rather than a scheduling annoyance.
 * So the rule runs on the **pool the solver is given**, not on the slots it returns:
 * {@link narrowPoolByGender} removes the therapist *and their presence* before
 * {@link solveGenderMatchedAvailability} calls `solveAvailability`, so an ineligible therapist is never
 * a candidate, never reaches `availableTherapistIds`, and never reaches `assignShape`. A post-filter
 * over the answers would leave them in the ids a caller reads, and `assignShape` sorts by id: the
 * cross-gender therapist would be chosen and the slot would look compliant.
 *
 * ## Strict is what you get for saying nothing
 *
 * The mode comes from `booking.same_gender_matching` (compliance-locked, owner-only, audited) through
 * `genderMatchingMode` in `@berelax/shared`, which answers `'strict'` for every value that is not
 * exactly `'advisory'` — a missing row, an unreadable one, and the `'off'` a previous build's schema
 * allowed. `genderMatching` is optional on every type here for the same reason: a call site, a test or a
 * future provider that has never heard of the field cannot relax a compliance constraint by omission.
 * `packages/db/src/settings/availability.ts` proves the database half — no `app_setting` row at all
 * still reads strict.
 *
 * ## The client's gender is a different question from the therapist's
 *
 * The therapist's is `employee.gender`, nullable because nineteen therapists have photographs and no
 * staff list (Y8-staff). The client's is on no table at all — `customer` has no gender column, this unit
 * added none, and inventing one would be a column the front desk fills in with a guess. It is an
 * **argument**, supplied by the booking request, and at a phone booking it is very often unknown.
 *
 * Strict matching with an unknown client gender therefore returns **zero slots and the reason code
 * {@link GenderMatchRefusal `requires_client_gender`}**, so the caller knows to ask rather than reading
 * an unexplained empty day as "we are full". The field is a *required key with a possibly-undefined
 * value* on {@link GenderMatchedRequest}, which is deliberate: `clientGender: undefined` has to be
 * written out, so no call site can omit the question by accident.
 *
 * An unknown *therapist* gender is a mismatch, not a wildcard (`sameGenderMatch`). A fresh install
 * therefore offers nobody under strict matching, which is the loud failure rather than the quiet one.
 *
 * ## Asian/Arabic is a treatment STYLE and never a therapist attribute
 *
 * ADR 0021, and nothing here can reach one: this module reads a gender and a mode and has no access to
 * a style, a skill or a price. Therapists are ids throughout — a therapist has no display name until an
 * admin sets one (ADR 0020).
 *
 * Pure: a pool, a gender, a mode and a solver request in; slots out. No clock, no database.
 */
import { type GenderMatchingMode, genderMatchingMode } from '@berelax/shared'
import type { TradingWindow } from '../business-day/windows.ts'
import {
  type EligibleTherapist,
  type ExcludedTherapist,
  genderVerdict,
  poolSolverInput,
  sameGenderMatch,
  type TherapistGender,
  type TherapistPool,
} from './eligibility-port.ts'
import {
  type CandidateSlot,
  type RejectedStart,
  type SlotRequest,
  solveAvailability,
} from './solve.ts'

/**
 * Why a whole booking request is refused before any start is considered.
 *
 * One member, and it is a *request-level* answer rather than a per-therapist one: no roster change, no
 * renewal and no second therapist fixes it, and the next step belongs to whoever is taking the
 * booking. Named for the same reason `SlotRejection` and `EligibilityExclusionReason` are named — an
 * empty list with no reason is the answer the front desk cannot act on.
 */
export type GenderMatchRefusal = 'requires_client_gender'

/** A pool with the gender rule applied, and everything a caller needs to explain the result. */
export interface GenderNarrowedPool {
  /** The mode actually applied, after normalisation. Never the raw stored value. */
  readonly mode: GenderMatchingMode
  /** Non-null when the request cannot be answered at all. `pool.therapists` is then empty. */
  readonly refusal: GenderMatchRefusal | null
  /**
   * The pool the solver may see: presence filtered to the therapists that survived, so the two halves
   * of `poolSolverInput` cannot disagree about who the query was about.
   */
  readonly pool: TherapistPool
  /** Those this rule removed, with `gender_mismatch`. A subset of `pool.excluded`. */
  readonly excludedByGender: readonly ExcludedTherapist[]
  /**
   * Of the surviving therapists, those **proved** to be a same-gender match for a known client gender.
   * Empty when the client's gender is unknown, because then nothing is proved.
   */
  readonly sameGenderTherapistIds: readonly string[]
}

/**
 * Applies the gender rule to a pool. The whole of the hard constraint.
 *
 * Re-applied here rather than trusted from the provider, and that is the same argument `assignShape`
 * makes for re-checking a shape's own rules: `EligibilityQuery` can carry `clientGender` and
 * `genderMatching`, and a provider — including P-HR's, and including a cached one — may ignore them. A
 * second application of one predicate (`genderVerdict`, shared with `resolveTherapistPool` and mirrored
 * by the SQL) narrows a pool that is already narrow and catches one that is not. The failure it prevents
 * is the only one that matters here: a cross-gender therapist reaching the solver because the layer
 * below was asked politely.
 */
export function narrowPoolByGender(args: {
  readonly pool: TherapistPool
  readonly clientGender: TherapistGender | undefined
  readonly genderMatching?: GenderMatchingMode
}): GenderNarrowedPool {
  const { pool, clientGender, genderMatching } = args
  const mode = genderMatchingMode(genderMatching)
  // Strict and no client gender: nothing can be matched, so nothing is offered. Computed before the
  // loop because it is a property of the request, not of any therapist.
  const refusal: GenderMatchRefusal | null =
    mode === 'strict' && clientGender === undefined ? 'requires_client_gender' : null

  const kept: EligibleTherapist[] = []
  const excludedByGender: ExcludedTherapist[] = []
  for (const therapist of pool.therapists) {
    const verdict =
      refusal === null
        ? genderVerdict({
            ...(therapist.gender === undefined ? {} : { therapistGender: therapist.gender }),
            ...(clientGender === undefined ? {} : { clientGender }),
            genderMatching: mode,
          })
        : // On a refusal every candidate is removed, so a caller that ignores `refusal` still gets zero
          // slots. A refusal that is only a flag is a refusal somebody books through.
          'gender_mismatch'
    if (verdict === 'ok') kept.push(therapist)
    else excludedByGender.push({ therapistId: therapist.therapistId, reason: 'gender_mismatch' })
  }

  const keptIds = new Set(kept.map((therapist) => therapist.therapistId))
  return {
    mode,
    refusal,
    pool: {
      therapists: kept,
      // Presence goes with the therapist. Leaving a removed therapist's shifts behind would hand
      // `solveAvailability` presence for an id it was never given — the port's own warning — and would
      // make the "was this therapist considered" spy in the tests unable to tell the two apart.
      shifts: pool.shifts.filter((shift) => keptIds.has(shift.therapistId)),
      excluded: [...pool.excluded, ...excludedByGender],
    },
    excludedByGender,
    sameGenderTherapistIds: kept
      .filter((therapist) => sameGenderMatch(clientGender, therapist.gender))
      .map((therapist) => therapist.therapistId),
  }
}

/**
 * An offerable start, with the gender label every slot carries in both modes.
 *
 * `genderMismatch` is never absent and never `undefined`, which is why it is a required `boolean` and
 * not an optional flag set only when it is true: a caller reading `slot.genderMismatch` on a slot from
 * a build that forgot to set it would read `undefined`, and `undefined` is falsy — a cross-gender slot
 * would present as a compliant one.
 */
export interface GenderMatchedSlot extends CandidateSlot {
  /**
   * `false` means every therapist offered for this start is a **proved** same-gender match.
   *
   * `true` means delivering it is not proved compliant: either no same-gender therapist is free, or the
   * client's gender is unknown so nothing can be proved. The asymmetry is the point — `false` is a
   * claim and needs evidence on both sides of the pair, `true` needs none. In strict mode it is always
   * `false`, because a start that could only be delivered cross-gender is not offered at all.
   */
  readonly genderMismatch: boolean
  /**
   * Free for this start but not proved a same-gender match. **Always empty in strict mode.**
   *
   * Named rather than offered: these ids are absent from `availableTherapistIds` whenever a proved match
   * exists, so a caller cannot reach a cross-gender delivery by accident, and a caller that has
   * deliberately relaxed the rule — a two-therapist shape under advisory with only one same-gender
   * therapist free — does not have to recompute who they were.
   */
  readonly crossGenderTherapistIds: readonly string[]
}

/** The answer: slots, why starts were rejected, and why the whole request was refused if it was. */
export interface GenderMatchedSolution {
  readonly mode: GenderMatchingMode
  readonly slots: readonly GenderMatchedSlot[]
  readonly rejected: readonly RejectedStart[]
  readonly windows: readonly TradingWindow[]
  /** `null` when the request was answered. Never absent, so a caller cannot forget to look. */
  readonly refusal: GenderMatchRefusal | null
  readonly excludedByGender: readonly ExcludedTherapist[]
}

/**
 * Everything the solver needs, with the pool and the client in place of the two fields the pool supplies.
 *
 * `therapistIds` and `shifts` are **not** accepted from the caller, for the reason `ShapeSlotRequest`
 * refuses `clients` and `therapistBufferMinutes`: both are derived here, so no caller can hand the
 * solver a therapist list that the gender rule has not been applied to.
 */
export interface GenderMatchedRequest extends Omit<SlotRequest, 'therapistIds' | 'shifts'> {
  readonly pool: TherapistPool
  /**
   * The client's gender, or `undefined` when nobody has asked.
   *
   * A required key with a possibly-undefined value, not an optional property: `clientGender: undefined`
   * has to be written, so "we did not collect it" is a visible statement at the call site rather than a
   * field somebody forgot. Under strict matching that statement is answered with
   * `requires_client_gender` and zero slots.
   */
  readonly clientGender: TherapistGender | undefined
  /** Absent is strict. See the module header. */
  readonly genderMatching?: GenderMatchingMode
}

/**
 * Offerable starts for one client, with same-gender matching applied as a hard constraint.
 *
 * Narrow, then solve, then label. Never solve then filter: by the time `solveAvailability` has returned,
 * an excluded therapist is already in `availableTherapistIds` and in the room and therapist intervals
 * that were computed from their presence.
 */
export function solveGenderMatchedAvailability(
  request: GenderMatchedRequest,
): GenderMatchedSolution {
  const { pool, clientGender, genderMatching, ...solverFields } = request
  const narrowed = narrowPoolByGender({
    pool,
    clientGender,
    ...(genderMatching === undefined ? {} : { genderMatching }),
  })

  if (narrowed.refusal !== null) {
    // No windows and no rejections: no start was considered, so there is nothing to report about any.
    // The refusal is the answer, and inventing a list of rejected starts would suggest the day was
    // examined and found full.
    return {
      mode: narrowed.mode,
      slots: [],
      rejected: [],
      windows: [],
      refusal: narrowed.refusal,
      excludedByGender: narrowed.excludedByGender,
    }
  }

  const solution = solveAvailability({ ...solverFields, ...poolSolverInput(narrowed.pool) })
  const proved = new Set(narrowed.sameGenderTherapistIds)
  const slots = solution.slots.map((slot): GenderMatchedSlot => {
    const matched = slot.availableTherapistIds.filter((id) => proved.has(id))
    const crossGenderTherapistIds = slot.availableTherapistIds.filter((id) => !proved.has(id))
    // A proved match exists: offer only those, and the slot is compliant. None does: offer what is
    // free and say so. The invariant this keeps is the one a caller can rely on — `genderMismatch`
    // false means every id in `availableTherapistIds` is a proved match, in either mode.
    return matched.length > 0
      ? { ...slot, availableTherapistIds: matched, genderMismatch: false, crossGenderTherapistIds }
      : { ...slot, genderMismatch: true, crossGenderTherapistIds }
  })

  return {
    mode: narrowed.mode,
    slots,
    rejected: solution.rejected,
    windows: solution.windows,
    refusal: null,
    excludedByGender: narrowed.excludedByGender,
  }
}

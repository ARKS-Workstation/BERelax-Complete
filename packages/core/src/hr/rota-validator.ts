import { AppError } from '@berelax/shared'
import type { Period } from '../availability/room-predicates.ts'
import { ASIA_DUBAI, addMinutes, type LocalDate, type TimeZone, toLocal } from '../time.ts'
import {
  type CredentialAssessment,
  type CredentialPolicy,
  evaluateCredentialsOn,
  type HeldCredential,
} from './credentials.ts'
import type { WorkingHoursRules } from './rates.ts'
import {
  mergePresences,
  type RosteredShift,
  summariseWorkedHours,
  type WorkedHoursSummary,
  type WorkingHoursViolation,
} from './working-hours.ts'

/**
 * The rota validator: every reason a draft rota may not be published, and nothing else. Pure.
 *
 * A rota is published or it is not, so this whole module is a pile of refusals. Each refusal carries a
 * RULE NAME, and the names are the contract: `rota_change_request.refused_rule` stores one, the screen
 * prints one, and every gate case in block 108 asserts a known-bad fixture is rejected **by name**. A
 * validator that answered only "not publishable" would pass every one of those cases while rejecting for
 * the wrong reason, which is the failure ADR 0003 exists to stop.
 *
 * ## The four claims, and exactly what each one measures
 *
 * The defect these comments exist to prevent is a check whose stated claim is not what it measures, so
 * each rule states its measurement:
 *
 *   1. **`minimum_floor_coverage`** — claim: at least `minimumTherapistsOnFloor` therapists are on the
 *      floor for the WHOLE of every segment of the day's open window. Measured as: for each segment of
 *      `[opensAt, closesAt)`, the number of employees **in the therapist roster** whose merged presence,
 *      built from the shifts filed under THAT trading date, CONTAINS the segment.
 *
 *      Three parts of that are decisions:
 *
 *      *Therapists, not employees.* A receptionist on shift covers no treatment. Counting assignments
 *      would report a fully covered floor with nobody able to deliver anything, so an employee absent
 *      from `therapists` contributes nothing — and an assignment naming an employee absent from the
 *      roster entirely is REFUSED rather than ignored, because silently skipping it under-counts cover.
 *
 *      *Contains, not overlaps.* A therapist whose shift ends at 00:45 does not cover the 00:30–01:00
 *      segment: the floor is short for fifteen minutes of it. Containment is the strict reading and it is
 *      what makes the segment grid mean anything — with overlap, one therapist present for one minute of
 *      each segment would cover the entire day.
 *
 *      *Filed under that trading date, not present at that instant.* This is the one that looks wrong and
 *      is not. `readEligibleTherapists` joins `shift` on `trading_date` (0030), so a shift filed under the
 *      wrong trading date offers no candidate of the date it physically covers — the booking system cannot
 *      see it, so it cannot serve a treatment in that segment, so it is not cover. Counting by instant
 *      would pass a rota whose cover the solver cannot find, and the customer would meet the difference.
 *      The visible consequence is the loud one: a shift mis-filed under the following date reports as
 *      missing cover on the date it was meant for.
 *
 *   2. **`wet_room_capability`** — claim: whenever the wet room is bookable, at least
 *      `minimumWetRoomCapable` of the therapists on the floor can deliver a wet-room treatment. Measured
 *      as: for each segment OVERLAPPING any of the day's `wetRoomBookableDuring` periods, the number of
 *      on-the-floor therapists (same containment test) holding at least one skill in `wetRoomSkills`.
 *
 *      Overlap and not containment for the bookability half, which is the strict direction: ten minutes of
 *      bookable wet room inside a thirty-minute segment still needs somebody who can run the bath.
 *
 *   3. **`daily_treatment_load_cap`** and **`daily_high_intensity_load_cap`** — claim: no therapist is
 *      booked past the day's treatment-minute cap, nor past the high-intensity sub-cap. Measured as: the
 *      sum of `minutes` over the treatment loads for that employee and trading date, and the same sum
 *      restricted to loads whose `treatmentCode` is in the rule's `highIntensityTreatmentCodes`.
 *
 *      TREATMENT minutes and not rostered minutes: the cap is on hands-on work, and a therapist rostered
 *      eight hours with four booked has worked four. The rostered side is rules 4 to 6's.
 *
 *   4. **`daily_overtime_cap`, `weekly_ordinary_cap`, `minimum_rest`** — P-HR-05's, unchanged. They are
 *      not re-derived here: {@link validateRota} calls `summariseWorkedHours` and translates what it
 *      returns. A second reading of "how long is a 18:00–02:00 shift" is the defect that module exists not
 *      to have, and writing one here would be that defect with a different file name.
 *
 *   5. **`credential_not_current`** — claim: every therapist rostered on a trading date holds every
 *      mandatory document, unexpired, on that date. Measured by `evaluateCredentialsOn` from
 *      `./credentials.ts` — P-HR-02's evaluator, called and not reimplemented.
 *
 *      This rule blocks PUBLICATION and not only an open-shift claim, and the acceptance criterion's own
 *      logic forces that: if a claim is refused because the claimant's licence has expired, an assignment
 *      must be refused for the same reason, or the rule is evaded by writing the assignment directly.
 *      Its consequence on a fresh database is worth knowing before it surprises somebody — `employee_document`
 *      is empty in the seed and six document types are mandatory, so no rota over the seeded therapists
 *      publishes until their files exist. That is a true statement about the business's readiness rather
 *      than a bug in the validator, and the rota screen prints it.
 *
 * ## Why the thresholds arrive as VERSIONS and not as numbers
 *
 * {@link RotaCoverageRules} is one row of `rota_coverage_rule` (migration 0081) and {@link validateRota}
 * takes the whole version list, picking the one governing each trading date. A rota is asked about the
 * past — "was the floor covered on the 4th of March?" — and raising the floor minimum in April must not
 * make March's published rota retroactively non-compliant. 0081's header argues it at length; it is the
 * same decision `working_hours_rule` and `leave_entitlement_rule` took, for the same reason.
 *
 * Pure: instants and integers in, refusals out. No clock, no I/O, and the zone is an argument.
 */

/** Every rule this module can refuse by. The strings are stored and asserted, so they are a contract. */
export const ROTA_RULE_NAMES = [
  'minimum_floor_coverage',
  'wet_room_capability',
  'daily_treatment_load_cap',
  'daily_high_intensity_load_cap',
  'daily_overtime_cap',
  'weekly_ordinary_cap',
  'minimum_rest',
  'credential_not_current',
] as const

export type RotaRuleName = (typeof ROTA_RULE_NAMES)[number]

/** One version of `rota_coverage_rule`. The figures, never a figure this module holds. */
export interface RotaCoverageRules {
  /** The first trading date this version governs. */
  readonly effectiveFrom: LocalDate
  readonly coverageSegmentMinutes: number
  readonly minimumTherapistsOnFloor: number
  readonly minimumWetRoomCapable: number
  readonly treatmentMinutesCapPerDay: number
  readonly highIntensityMinutesCapPerDay: number
  /**
   * The `service.treatment` codes the sub-cap applies to. EMPTY in the shipped version 1, which makes
   * the sub-cap inert rather than absent: no treatment in the catalogue is recorded as heavy work and
   * 0004 refuses "Therapeutic Deep Tissue" as a claim, so a list here would be invented (Y9-coverage).
   */
  readonly highIntensityTreatmentCodes: readonly string[]
}

/** One trading date of the rota: its window, its holiday-ness, and when the wet room is sellable. */
export interface RotaTradingDay {
  readonly tradingDate: LocalDate
  /** `business_day.opens_at`. Never re-derived: `resolveTradingDate` is the one reading of the window. */
  readonly opensAt: Period['startsAt']
  /** `business_day.closes_at`, which falls on the next calendar date on a normal day. */
  readonly closesAt: Period['endsAt']
  /**
   * When the wet room is bookable, as periods rather than a boolean.
   *
   * A boolean could not say "the bath is out until Thursday": `room_block` takes the room out for part of
   * a day (0012), and a whole-day flag would demand wet cover during a maintenance window or excuse it
   * for the rest of the day. Empty means the wet room is not sellable at all that day, and then rule 2
   * cannot fire.
   */
  readonly wetRoomBookableDuring: readonly Period[]
  readonly isPublicHoliday: boolean
}

/** A therapist who may count towards cover, and the skills they hold (`employee_skill.skill`). */
export interface RotaTherapist {
  readonly employeeId: string
  readonly skills: readonly string[]
  /** Everything on file for them, for rule 5. Empty means nothing is on file, which is not eligible. */
  readonly credentials: readonly HeldCredential[]
}

/** One booked treatment's load on one therapist, which is what the fatigue caps are measured over. */
export interface TreatmentLoad {
  readonly appointmentId: string
  readonly employeeId: string
  /** `appointment.trading_date`, so a 01:30 treatment loads the day that opened at 11:00. */
  readonly tradingDate: LocalDate
  readonly minutes: number
  /** `service.treatment`, matched against the rule version's high-intensity list. */
  readonly treatmentCode: string
}

/** One segment of one trading day's open window, and what was on the floor during it. */
export interface RotaSegment {
  readonly tradingDate: LocalDate
  /** 0-based within the day, so a caller can point at "the 27th segment" without re-deriving it. */
  readonly index: number
  readonly period: Period
  /** `2026-03-04 00:30-01:00`, the wording a violation and the screen both use. */
  readonly label: string
  readonly therapistsOnFloor: readonly string[]
  readonly wetRoomCapableOnFloor: readonly string[]
  readonly isWetRoomBookable: boolean
}

export type RotaViolation =
  | {
      readonly rule: 'minimum_floor_coverage'
      readonly tradingDate: LocalDate
      readonly segmentLabel: string
      readonly segmentIndex: number
      readonly onFloor: number
      readonly required: number
    }
  | {
      readonly rule: 'wet_room_capability'
      readonly tradingDate: LocalDate
      readonly segmentLabel: string
      readonly segmentIndex: number
      readonly capableOnFloor: number
      readonly required: number
    }
  | {
      readonly rule: 'daily_treatment_load_cap' | 'daily_high_intensity_load_cap'
      readonly tradingDate: LocalDate
      readonly employeeId: string
      readonly minutes: number
      readonly capMinutes: number
      /** The appointments that make up the figure, so the refusal names something movable. */
      readonly appointmentIds: readonly string[]
    }
  | {
      readonly rule: 'daily_overtime_cap'
      readonly tradingDate: LocalDate
      readonly employeeId: string
      readonly overtimeMinutes: number
      readonly capMinutes: number
    }
  | {
      readonly rule: 'weekly_ordinary_cap'
      readonly employeeId: string
      readonly weekStartTradingDate: LocalDate
      readonly totalMinutes: number
      readonly capMinutes: number
    }
  | {
      readonly rule: 'minimum_rest'
      readonly employeeId: string
      readonly earlierShiftId: string
      readonly laterShiftId: string
      readonly gapMinutes: number
      readonly minimumMinutes: number
    }
  | {
      readonly rule: 'credential_not_current'
      readonly employeeId: string
      readonly tradingDate: LocalDate
      /** The mandatory types that are not satisfying, worst first, as P-HR-02 ordered them. */
      readonly blocking: readonly CredentialAssessment[]
    }

export interface RotaValidation {
  /** True exactly when `violations` is empty. A publisher reads this; a screen reads the list. */
  readonly isPublishable: boolean
  readonly violations: readonly RotaViolation[]
  /** Every segment of every day, whether or not it breached. The rota grid is drawn from this. */
  readonly segments: readonly RotaSegment[]
  /** P-HR-05's answer, passed through so a caller needs no second read of the same shifts. */
  readonly workedHours: WorkedHoursSummary
}

export interface ValidateRotaArgs {
  readonly days: readonly RotaTradingDay[]
  readonly therapists: readonly RotaTherapist[]
  readonly assignments: readonly RosteredShift[]
  readonly treatmentLoads: readonly TreatmentLoad[]
  readonly coverageRuleVersions: readonly RotaCoverageRules[]
  readonly workingHoursRuleVersions: readonly WorkingHoursRules[]
  /**
   * The skills that reach a wet-room treatment, from the catalogue.
   *
   * An argument and not a constant, and derived rather than recorded, which is the decision worth stating.
   * `therapist_skill` is `('asian_style','arabic_style')` and there is no wet-room value in it: 0012 maps
   * `morocco_bath_jacuzzi` to `required_room_type = 'wet'` for both styles, and ADR 0021 makes style an
   * attribute of the TREATMENT, so "can deliver a wet-room treatment" is exactly "holds the skill a
   * wet-room service requires". Adding a `wet_room` skill instead would invent a training fact about
   * nineteen people nobody has told us anything about (brief rule 15, Y9-coverage).
   *
   * The day a real capability table exists, it changes this one argument and no rule.
   */
  readonly wetRoomSkills: readonly string[]
  readonly credentialPolicy: CredentialPolicy
  readonly zone?: TimeZone
}

/**
 * The coverage rule version governing a trading date: the latest one effective at or before it.
 *
 * Deliberately a near-copy of `rulesFor` in `./rates.ts` rather than a shared generic over both tables.
 * The two tables are different units' and are versioned on different questions, and a shared helper is
 * what makes "which version governs March" one function that two callers then argue about — the message
 * below names `rota_coverage_rule` and that is half of its value.
 */
export function rotaCoverageRulesFor(
  versions: readonly RotaCoverageRules[],
  tradingDate: LocalDate,
): RotaCoverageRules {
  let governing: RotaCoverageRules | undefined
  for (const version of versions) {
    if (version.effectiveFrom > tradingDate) continue
    if (governing === undefined || version.effectiveFrom > governing.effectiveFrom) {
      governing = version
    }
  }
  if (governing === undefined) {
    throw new AppError(
      'invariant_violated',
      `No rota coverage rule version is effective on or before the trading date ${tradingDate}, so the ` +
        'floor minimum, the wet-room minimum and the two daily treatment caps are unknown. 0081 seeds a ' +
        'version from a sentinel date before any trading this business could have done; an empty answer ' +
        'means the row is gone. A default here would be a rota validated against thresholds nobody set.',
    )
  }
  assertRotaCoverageRules(governing)
  return governing
}

/**
 * The figures have to be usable before they are used, and a nonsense threshold is the failure that looks
 * like a passing validator: a floor minimum of 0 makes rule 1 unable to fire at all.
 */
export function assertRotaCoverageRules(rules: RotaCoverageRules): void {
  const whole = (label: string, value: number, minimum: number, maximum: number) => {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new AppError(
        'validation',
        `${label} must be a whole number between ${minimum} and ${maximum}, got ${value}. 0081's CHECK ` +
          'constraints refuse the row, so a value arriving here is a hand-built rule set rather than a ' +
          'database read.',
      )
    }
  }
  whole('The coverage segment length in minutes', rules.coverageSegmentMinutes, 1, 1440)
  whole('The minimum therapists on the floor', rules.minimumTherapistsOnFloor, 1, 500)
  whole('The minimum wet-room-capable therapists', rules.minimumWetRoomCapable, 0, 500)
  whole('The daily treatment-minute cap', rules.treatmentMinutesCapPerDay, 1, 1440)
  whole('The daily high-intensity minute cap', rules.highIntensityMinutesCapPerDay, 0, 1440)
  if (rules.minimumWetRoomCapable > rules.minimumTherapistsOnFloor) {
    throw new AppError(
      'validation',
      `A rota cannot need ${rules.minimumWetRoomCapable} wet-room-capable therapists out of a floor ` +
        `minimum of ${rules.minimumTherapistsOnFloor}: no rota could satisfy both, so every rota would ` +
        'be refused by whichever rule was evaluated first.',
    )
  }
  if (rules.highIntensityMinutesCapPerDay > rules.treatmentMinutesCapPerDay) {
    throw new AppError(
      'validation',
      `A high-intensity sub-cap of ${rules.highIntensityMinutesCapPerDay} minutes above the total cap ` +
        `of ${rules.treatmentMinutesCapPerDay} is not a sub-cap: the total cap would refuse first and ` +
        'the sub-cap could never fire, so it would read as a rule that passes.',
    )
  }
}

/** `HH:MM` in the business zone, which is the only form a segment label ever needs. */
function localTimeOf(instant: Period['startsAt'], zone: TimeZone): string {
  return toLocal(instant, zone).time
}

/**
 * The segments of one trading day's open window, in order.
 *
 * Walked from `opensAt` towards `closesAt` in whole steps, with a SHORT final segment when the window is
 * not a whole number of steps — not dropped, and not extended past close. Dropping it would leave the last
 * minutes of the day uncovered by any rule, which for a window ending at 02:00 is exactly the region the
 * acceptance criterion is about; extending it would demand cover after close.
 */
export function rotaSegments(
  day: RotaTradingDay,
  segmentMinutes: number,
  zone: TimeZone = ASIA_DUBAI,
): readonly { readonly index: number; readonly period: Period; readonly label: string }[] {
  if (day.closesAt <= day.opensAt) {
    throw new AppError(
      'validation',
      `Trading date ${day.tradingDate} closes at or before it opens. A window of 11:00-02:00 does NOT ` +
        'look like this: its close instant is after its open instant, and only wall-clock subtraction ' +
        'makes it appear negative.',
    )
  }
  const segments: { index: number; period: Period; label: string }[] = []
  let index = 0
  for (let startsAt = day.opensAt; startsAt < day.closesAt; index += 1) {
    const candidate = addMinutes(startsAt, segmentMinutes)
    const endsAt = candidate < day.closesAt ? candidate : day.closesAt
    segments.push({
      index,
      period: { startsAt, endsAt } as Period,
      label: `${day.tradingDate} ${localTimeOf(startsAt, zone)}-${localTimeOf(endsAt, zone)}`,
    })
    startsAt = endsAt
  }
  return segments
}

/** True when `outer` covers every instant of `inner`, both half-open. */
function contains(outer: Period, inner: Period): boolean {
  return outer.startsAt <= inner.startsAt && outer.endsAt >= inner.endsAt
}

/** True when the two half-open periods share at least one instant. */
function overlaps(a: Period, b: Period): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

/**
 * Everything wrong with a draft rota, in one pass.
 *
 * Violations come back in a stable order — coverage by day then segment, then the load caps, then
 * P-HR-05's three, then the credential rule — because a screen that listed them differently on two reads
 * of the same rota would look like the rota had changed.
 */
/** `employeeId` and a trading date, which is the key every per-day tally in this module groups by. */
function dayKey(employeeId: string, tradingDate: LocalDate): string {
  return `${employeeId}\u0000${tradingDate}`
}

/**
 * Presence per (employee, trading date), merged.
 *
 * Merged and not raw, for `mergePresences`'s reason: a shift written as 18:00–22:00 plus 22:00–02:00 is
 * ONE presence, so a segment straddling the join is covered and the zero-minute gap between the halves is
 * not a rest breach.
 */
function presencesByDay(assignments: readonly RosteredShift[]): Map<string, readonly Period[]> {
  const grouped = new Map<string, RosteredShift[]>()
  for (const shift of assignments) {
    const key = dayKey(shift.employeeId, shift.tradingDate)
    const held = grouped.get(key)
    if (held === undefined) grouped.set(key, [shift])
    else held.push(shift)
  }
  const presences = new Map<string, readonly Period[]>()
  for (const [key, group] of grouped) {
    presences.set(
      key,
      mergePresences(group).map((presence) => presence.period),
    )
  }
  return presences
}

/**
 * Rules 1 and 2, and the segment grid they are measured on, for ONE trading day.
 *
 * Returns the segments as well as the violations, because the rota grid is drawn from them: a screen that
 * recomputed which therapists were on the floor would be a second reading of the containment test, and it
 * would disagree with the refusal printed above it on the boundary minute.
 */
function coverageOfDay(args: {
  readonly day: RotaTradingDay
  readonly rules: RotaCoverageRules
  readonly therapists: readonly RotaTherapist[]
  readonly presences: ReadonlyMap<string, readonly Period[]>
  readonly wetSkills: ReadonlySet<string>
  readonly zone: TimeZone
}): { readonly segments: readonly RotaSegment[]; readonly violations: readonly RotaViolation[] } {
  const { day, rules, therapists, presences, wetSkills, zone } = args
  if (
    rules.minimumWetRoomCapable > 0 &&
    day.wetRoomBookableDuring.length > 0 &&
    wetSkills.size === 0
  ) {
    // An empty skill set would make every therapist incapable and fire rule 2 on every segment — a rule
    // firing for the wrong reason, which is worse than one that does not fire at all: the refusal would
    // name the segment, and the cause would be an argument nobody filled in.
    throw new AppError(
      'validation',
      `Trading date ${day.tradingDate} has the wet room bookable and the rule version effective ` +
        `${rules.effectiveFrom} needs ${rules.minimumWetRoomCapable} wet-room-capable therapists, but ` +
        'no wet-room skills were supplied. With an empty set nobody is capable, so every segment would ' +
        'be refused and the refusal would name the segment rather than the missing argument.',
    )
  }
  const segments: RotaSegment[] = []
  const violations: RotaViolation[] = []
  for (const segment of rotaSegments(day, rules.coverageSegmentMinutes, zone)) {
    const onFloor: string[] = []
    const capable: string[] = []
    for (const therapist of therapists) {
      const present = presences.get(dayKey(therapist.employeeId, day.tradingDate))
      if (present === undefined) continue
      if (!present.some((presence) => contains(presence, segment.period))) continue
      onFloor.push(therapist.employeeId)
      if (therapist.skills.some((skill) => wetSkills.has(skill))) capable.push(therapist.employeeId)
    }
    const isWetRoomBookable = day.wetRoomBookableDuring.some((window) =>
      overlaps(window, segment.period),
    )
    segments.push({
      tradingDate: day.tradingDate,
      index: segment.index,
      period: segment.period,
      label: segment.label,
      therapistsOnFloor: onFloor,
      wetRoomCapableOnFloor: capable,
      isWetRoomBookable,
    })
    if (onFloor.length < rules.minimumTherapistsOnFloor) {
      violations.push({
        rule: 'minimum_floor_coverage',
        tradingDate: day.tradingDate,
        segmentLabel: segment.label,
        segmentIndex: segment.index,
        onFloor: onFloor.length,
        required: rules.minimumTherapistsOnFloor,
      })
    }
    if (isWetRoomBookable && capable.length < rules.minimumWetRoomCapable) {
      violations.push({
        rule: 'wet_room_capability',
        tradingDate: day.tradingDate,
        segmentLabel: segment.label,
        segmentIndex: segment.index,
        capableOnFloor: capable.length,
        required: rules.minimumWetRoomCapable,
      })
    }
  }
  return { segments, violations }
}

/**
 * Rule 3, both caps, over every (therapist, trading date) that has any booked treatment.
 *
 * Grouped by the LOAD's trading date and not by the roster's, which is the attribution
 * `appointment.trading_date` already carries: a treatment starting at 01:30 loads the day that opened at
 * 11:00, and grouping by a calendar date would move it onto a day the therapist may not be rostered on.
 */
function loadCapViolations(args: {
  readonly treatmentLoads: readonly TreatmentLoad[]
  readonly coverageRuleVersions: readonly RotaCoverageRules[]
}): readonly RotaViolation[] {
  const grouped = new Map<string, TreatmentLoad[]>()
  for (const load of args.treatmentLoads) {
    if (!Number.isInteger(load.minutes) || load.minutes <= 0) {
      throw new AppError(
        'validation',
        `Treatment ${load.appointmentId} carries ${load.minutes} minutes. A zero or fractional load ` +
          'would let a cap be approached without ever being reached, which is a cap that never fires.',
      )
    }
    const key = dayKey(load.employeeId, load.tradingDate)
    const held = grouped.get(key)
    if (held === undefined) grouped.set(key, [load])
    else held.push(load)
  }

  const violations: RotaViolation[] = []
  for (const key of [...grouped.keys()].sort()) {
    const group = grouped.get(key) as TreatmentLoad[]
    const first = group[0] as TreatmentLoad
    const rules = rotaCoverageRulesFor(args.coverageRuleVersions, first.tradingDate)
    const heavy = new Set(rules.highIntensityTreatmentCodes)
    let total = 0
    let highIntensity = 0
    for (const load of group) {
      total += load.minutes
      if (heavy.has(load.treatmentCode)) highIntensity += load.minutes
    }
    if (total > rules.treatmentMinutesCapPerDay) {
      violations.push({
        rule: 'daily_treatment_load_cap',
        tradingDate: first.tradingDate,
        employeeId: first.employeeId,
        minutes: total,
        capMinutes: rules.treatmentMinutesCapPerDay,
        appointmentIds: group.map((load) => load.appointmentId).sort(),
      })
    }
    if (highIntensity > rules.highIntensityMinutesCapPerDay) {
      violations.push({
        rule: 'daily_high_intensity_load_cap',
        tradingDate: first.tradingDate,
        employeeId: first.employeeId,
        minutes: highIntensity,
        capMinutes: rules.highIntensityMinutesCapPerDay,
        appointmentIds: group
          .filter((load) => heavy.has(load.treatmentCode))
          .map((load) => load.appointmentId)
          .sort(),
      })
    }
  }
  return violations
}

/**
 * Rule 4: P-HR-05's three violations, TRANSLATED into this module's vocabulary and not re-derived.
 *
 * Translated one kind at a time, with the last kind's label ANNOTATED rather than inferred, so a fourth
 * kind added to `WorkingHoursViolation` is a type error here instead of a violation this validator
 * silently drops.
 */
function asRotaViolation(violation: WorkingHoursViolation): RotaViolation {
  if (violation.kind === 'daily_overtime_cap') {
    return {
      rule: 'daily_overtime_cap',
      tradingDate: violation.tradingDate,
      employeeId: violation.employeeId,
      overtimeMinutes: violation.overtimeMinutes,
      capMinutes: violation.capMinutes,
    }
  }
  if (violation.kind === 'weekly_ordinary_cap') {
    return {
      rule: 'weekly_ordinary_cap',
      employeeId: violation.employeeId,
      weekStartTradingDate: violation.weekStartTradingDate,
      totalMinutes: violation.totalMinutes,
      capMinutes: violation.capMinutes,
    }
  }
  // The one kind left. Annotated rather than left implicit, and that annotation is the exhaustiveness
  // check: a fourth kind added to `WorkingHoursViolation` makes this line a type error, where a `default`
  // branch would have swallowed it and dropped the new violation silently.
  const remaining: 'minimum_rest' = violation.kind
  return {
    rule: remaining,
    employeeId: violation.employeeId,
    earlierShiftId: violation.earlierShiftId,
    laterShiftId: violation.laterShiftId,
    gapMinutes: violation.gapMinutes,
    minimumMinutes: violation.minimumMinutes,
  }
}

function workedHoursViolations(summary: WorkedHoursSummary): readonly RotaViolation[] {
  return summary.violations.map(asRotaViolation)
}

/**
 * Rule 5, through P-HR-02's evaluator.
 *
 * One verdict per (employee, trading date) and not one per employee, because the question is about a DATE:
 * a licence expiring on Wednesday makes Thursday's shift unworkable and leaves Tuesday's alone.
 * `evaluateCredentialsOn` takes a date rather than an instant for exactly this caller's sake — see its own
 * comment — and it is CALLED rather than reimplemented, so a rota and an availability query cannot
 * disagree about the boundary day.
 */
function credentialViolations(args: {
  readonly assignments: readonly RosteredShift[]
  readonly therapistById: ReadonlyMap<string, RotaTherapist>
  readonly credentialPolicy: CredentialPolicy
}): readonly RotaViolation[] {
  const violations: RotaViolation[] = []
  const judged = new Set<string>()
  const ordered = [...args.assignments].sort(
    (a, b) =>
      (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0) ||
      (a.tradingDate < b.tradingDate ? -1 : a.tradingDate > b.tradingDate ? 1 : 0),
  )
  for (const shift of ordered) {
    const key = dayKey(shift.employeeId, shift.tradingDate)
    if (judged.has(key)) continue
    judged.add(key)
    const therapist = args.therapistById.get(shift.employeeId) as RotaTherapist
    const verdict = evaluateCredentialsOn({
      credentials: therapist.credentials,
      policy: args.credentialPolicy,
      asOfDate: shift.tradingDate,
    })
    if (verdict.eligible) continue
    violations.push({
      rule: 'credential_not_current',
      employeeId: shift.employeeId,
      tradingDate: shift.tradingDate,
      blocking: verdict.blocking,
    })
  }
  return violations
}

/**
 * Every assignment must name a therapist this rota was validated against, and a day it covers.
 *
 * Refused rather than ignored, both of them. An assignment naming an employee absent from the roster is
 * either a non-therapist — whose cover is real for the front desk and nil for the floor — or a typo, and
 * in both cases skipping it silently UNDER-counts cover: a rota would pass its coverage rule with nobody
 * on the floor. An assignment on a trading date outside the rota's days would be counted against no
 * segment at all, so its cover would be left out of the answer with nothing saying so.
 */
function assertAssignmentsAreInScope(args: {
  readonly assignments: readonly RosteredShift[]
  readonly therapistById: ReadonlyMap<string, RotaTherapist>
  readonly dayByDate: ReadonlyMap<string, RotaTradingDay>
}): void {
  for (const shift of args.assignments) {
    if (!args.therapistById.has(shift.employeeId)) {
      throw new AppError(
        'validation',
        `Shift ${shift.shiftId} assigns employee ${shift.employeeId}, who is not in the therapist roster ` +
          'this rota was validated against. Coverage counts therapists, so an unknown employee would be ' +
          'silently worth nothing and the floor would read as short — or, if they were the only one ' +
          'rostered, as empty. Pass every assigned employee, therapist or not.',
      )
    }
    if (!args.dayByDate.has(shift.tradingDate)) {
      throw new AppError(
        'validation',
        `Shift ${shift.shiftId} is filed under trading date ${shift.tradingDate}, which is not one of ` +
          'the days this rota covers. Its cover would be counted against no segment at all, so the ' +
          'coverage answer would silently omit it.',
      )
    }
  }
}

export function validateRota(args: ValidateRotaArgs): RotaValidation {
  const {
    days,
    therapists,
    assignments,
    treatmentLoads,
    coverageRuleVersions,
    workingHoursRuleVersions,
    wetRoomSkills,
    credentialPolicy,
    zone = ASIA_DUBAI,
  } = args

  const therapistById = new Map(therapists.map((therapist) => [therapist.employeeId, therapist]))
  const dayByDate = new Map(days.map((day) => [String(day.tradingDate), day]))
  if (dayByDate.size !== days.length) {
    throw new AppError(
      'validation',
      'The same trading date appears twice in the rota. Two windows for one date would make the segment ' +
        'grid ambiguous, and the coverage answer would depend on which one was read second.',
    )
  }
  assertAssignmentsAreInScope({ assignments, therapistById, dayByDate })

  const presences = presencesByDay(assignments)
  const wetSkills = new Set(wetRoomSkills)
  const segments: RotaSegment[] = []
  const violations: RotaViolation[] = []

  // Rules 1 and 2, day by day and segment by segment, in the rota's own day order.
  for (const day of days) {
    const coverage = coverageOfDay({
      day,
      rules: rotaCoverageRulesFor(coverageRuleVersions, day.tradingDate),
      therapists,
      presences,
      wetSkills,
      zone,
    })
    segments.push(...coverage.segments)
    violations.push(...coverage.violations)
  }

  // Rule 3.
  violations.push(...loadCapViolations({ treatmentLoads, coverageRuleVersions }))

  // Rule 4, through P-HR-05. `workedHours` is returned to the caller as well, so a screen needs no
  // second read of the same shifts to show the hours beside the breaches.
  const workedHours = summariseWorkedHours({
    shifts: assignments,
    ruleVersions: workingHoursRuleVersions,
    publicHolidays: new Set(
      days.filter((day) => day.isPublicHoliday).map((day) => day.tradingDate),
    ),
    zone,
  })
  violations.push(...workedHoursViolations(workedHours))

  // Rule 5, through P-HR-02.
  violations.push(...credentialViolations({ assignments, therapistById, credentialPolicy }))

  return { isPublishable: violations.length === 0, violations, segments, workedHours }
}

/** Human wording for one refusal, for a screen and for `rota_change_request.refusal_detail`. */
export function describeRotaViolation(violation: RotaViolation): string {
  switch (violation.rule) {
    case 'minimum_floor_coverage':
      return `${violation.segmentLabel}: ${violation.onFloor} therapist(s) on the floor, ${violation.required} required`
    case 'wet_room_capability':
      return `${violation.segmentLabel}: the wet room is bookable and ${violation.capableOnFloor} of the therapists on the floor can deliver a wet-room treatment, ${violation.required} required`
    case 'daily_treatment_load_cap':
      return `${violation.tradingDate}: ${violation.minutes} treatment minutes against a cap of ${violation.capMinutes}`
    case 'daily_high_intensity_load_cap':
      return `${violation.tradingDate}: ${violation.minutes} high-intensity treatment minutes against a cap of ${violation.capMinutes}`
    case 'daily_overtime_cap':
      return `${violation.tradingDate}: ${violation.overtimeMinutes} overtime minutes against a daily cap of ${violation.capMinutes}`
    case 'weekly_ordinary_cap':
      return `week from ${violation.weekStartTradingDate}: ${violation.totalMinutes} minutes against a weekly cap of ${violation.capMinutes}`
    case 'minimum_rest':
      return `shifts ${violation.earlierShiftId} and ${violation.laterShiftId}: ${violation.gapMinutes} minutes of rest, ${violation.minimumMinutes} required`
    case 'credential_not_current':
      return `${violation.tradingDate}: ${violation.blocking
        .map((assessment) => `${assessment.documentType} ${assessment.status}`)
        .join(', ')}`
  }
}

/**
 * A swap: one shift moves from one therapist to another, and the WHOLE validator is re-run.
 *
 * Re-run and not "the coverage part re-checked", which is the acceptance criterion and is also the only
 * safe reading. A swap changes who is on the floor (rules 1 and 2), how many hours each of the two has
 * that day and that week (rule 4), whether either of them now has too little rest (rule 4), and whether
 * the incoming therapist may legally work at all (rule 5). A cheaper check would have to decide which of
 * those a swap cannot affect, and the answer is none of them.
 *
 * Returns the validation of the rota AS SWAPPED. The caller publishes it when `isPublishable`, and records
 * the first violation's rule name when it is not — which is why the order violations come back in is
 * stable and documented.
 */
export function validateSwap(
  args: ValidateRotaArgs & {
    readonly shiftId: string
    readonly fromEmployeeId: string
    readonly toEmployeeId: string
  },
): RotaValidation {
  const { shiftId, fromEmployeeId, toEmployeeId } = args
  if (fromEmployeeId === toEmployeeId) {
    throw new AppError(
      'validation',
      'A swap between one therapist and themselves changes nothing, so validating it would report the ' +
        'rota as publishable and the swap as applied while no assignment moved.',
    )
  }
  const moving = args.assignments.find(
    (shift) => shift.shiftId === shiftId && shift.employeeId === fromEmployeeId,
  )
  if (moving === undefined) {
    throw new AppError(
      'not_found',
      `Shift ${shiftId} is not assigned to employee ${fromEmployeeId} in this rota, so there is nothing ` +
        'to swap. Validating it anyway would report on the rota unchanged and call that a valid swap.',
    )
  }
  if (
    args.assignments.some((shift) => shift.shiftId === shiftId && shift.employeeId === toEmployeeId)
  ) {
    throw new AppError(
      'validation',
      `Employee ${toEmployeeId} is already on shift ${shiftId}. Swapping onto it would drop the other ` +
        'therapist and leave the floor one short, reported as a coverage breach with no cause visible.',
    )
  }
  return validateRota({
    ...args,
    assignments: args.assignments.map((shift) =>
      shift.shiftId === shiftId && shift.employeeId === fromEmployeeId
        ? { ...shift, employeeId: toEmployeeId }
        : shift,
    ),
  })
}

/**
 * An open shift claimed: a `shift` row with no assignment gains one, and the whole validator re-runs.
 *
 * The credential refusal the acceptance criterion names is not implemented here. It is rule 5 of
 * {@link validateRota}, which calls `evaluateCredentialsOn` from `./credentials.ts` — P-HR-02's evaluator —
 * so a claim by a therapist whose licence has expired is refused by the same function that refuses them an
 * appointment in `credentialVerdict` and takes them off one in P-HR-03's sweep. A second expiry comparison
 * in this file would be the third opinion, and the one that disagrees with availability on the boundary
 * day; `packages/fixtures/src/hr-rota.test.ts` asserts by source scan that this module contains none.
 */
export function validateOpenShiftClaim(
  args: ValidateRotaArgs & {
    readonly shiftId: string
    readonly tradingDate: LocalDate
    readonly period: Period
    readonly claimedBy: string
  },
): RotaValidation {
  const { shiftId, tradingDate, period, claimedBy } = args
  if (args.assignments.some((shift) => shift.shiftId === shiftId)) {
    throw new AppError(
      'validation',
      `Shift ${shiftId} already has somebody on it, so it is not an open shift. An open shift is a ` +
        '`shift` row with no `shift_assignment` row (0030), and claiming an assigned one would either ' +
        'double-staff the span or silently displace whoever is on it.',
    )
  }
  return validateRota({
    ...args,
    assignments: [...args.assignments, { shiftId, employeeId: claimedBy, tradingDate, period }],
  })
}

/** One published assignment, reduced to the four facts that decide whether a rota has changed. */
export interface RotaAssignmentRef {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly startsAt: Period['startsAt']
  readonly endsAt: Period['endsAt']
}

/**
 * The canonical text of an assignment set: what `rota_version.assignment_digest` is the sha-256 of.
 *
 * Pure, deterministic, and deliberately NOT the hash. `packages/core` hashes nothing — `booking-token.ts`
 * takes a `tokenSha256Hex` its caller computed, for the same reason — so the digest is computed by
 * `publishRota` in `packages/db`, over exactly this string. The split is what keeps the comparison
 * checkable: this function's output is readable in a test failure, and a hash is not.
 *
 * Three properties the form has to have, each of which a naive `JSON.stringify` lacks:
 *
 *   * **Order-independent.** The rows arrive from a SQL read whose `order by` can be lost in an edit, and
 *     a digest that changed when the ordering did would report every re-publish as a change and notify
 *     every therapist about nothing.
 *   * **Duplicates NOT collapsed.** Two identical rows are a defect the primary key refuses, and
 *     collapsing them here would hide it from the one comparison that looks at the whole set.
 *   * **Unambiguous.** The fields are joined with a delimiter none of them can contain (`|`, against a
 *     uuid, an ISO date and two integers), so one row's text cannot be assembled from another's values.
 *     The `rota-v1` prefix is the version of the FORM: change what goes into it and every existing digest
 *     stops matching, which is correct — it is no longer the same question — and the prefix is what makes
 *     that visible rather than mysterious.
 */
export function rotaAssignmentCanonicalForm(assignments: readonly RotaAssignmentRef[]): string {
  const rows = assignments
    .map(
      (row) => `${row.employeeId}|${row.tradingDate}|${String(row.startsAt)}|${String(row.endsAt)}`,
    )
    .sort()
  return ['rota-v1', ...rows].join('\n')
}

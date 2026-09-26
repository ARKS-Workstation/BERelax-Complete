import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The rota read and write side: everything the validator needs, and the publication itself.
 *
 * The **rules** are `packages/core/src/hr/rota-validator.ts`'s and stay there — `packages/db` must never
 * import `packages/core` — so this module returns **rows** and never a violation, a segment or a verdict.
 * `packages/fixtures/src/hr-rota.itest.ts` is the one place that may import both and is where the pair is
 * asserted to work, the same arrangement `hr-working-hours.itest.ts` and `hr-credentials.itest.ts` have.
 *
 * ## Why the write takes a VERDICT and refuses without one
 *
 * {@link publishRota} cannot validate: the validator is in the package it may not import. So the decision
 * arrives as an injected port — {@link RotaVerdict} — and publishing with `isPublishable: false` throws,
 * naming the rule. That is the `booking-token.ts` arrangement exactly, and it is what stops the one shape
 * this unit must not have: a publish path that does not consult the validator at all. A caller who simply
 * did not call it has to construct a verdict saying the rota is publishable, in a typed field, which is a
 * lie somebody can find rather than an omission nobody can see.
 *
 * ## The three things the database enforces without help from here
 *
 *   1. An **unchanged re-publish** is refused at COMMIT by `rota_version_changes_something` (ZW003). So
 *      "re-publishing an unchanged version emits no notification" needs no comparison in this module: no
 *      version is created, and `rota_publication_notice` has a NOT NULL reference to one.
 *   2. A **concurrent double-publish** is refused by `unique (supersedes_id)`. Two publishers reading the
 *      same current version both insert a row superseding it and the second gets a unique violation, so
 *      there are never two rival current rotas. That is why {@link publishRota} does NOT lock the current
 *      version first: a lock would serialise a race the constraint already decides correctly, and the
 *      constraint keeps working for a caller that forgets the lock.
 *   3. A **published rota is immutable** — `refuse_published_rota_change` (ZW001) for every role. Nothing
 *      here issues an UPDATE against either table, and if it did the database would refuse it.
 */

// ---------------------------------------------------------------------------------------------
// The rule tables
// ---------------------------------------------------------------------------------------------

/** One version of `rota_coverage_rule`. Structurally `RotaCoverageRules` in `@berelax/core`. */
export interface RotaCoverageRuleRow {
  readonly effectiveFrom: string
  readonly coverageSegmentMinutes: number
  readonly minimumTherapistsOnFloor: number
  readonly minimumWetRoomCapable: number
  readonly treatmentMinutesCapPerDay: number
  readonly highIntensityMinutesCapPerDay: number
  readonly highIntensityTreatmentCodes: readonly string[]
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
}

/** One version of `labour_cost_rule`. Structurally `LabourCostRules` in `@berelax/core`. */
export interface LabourCostRuleRow {
  readonly effectiveFrom: string
  readonly monthlyWageDaysDivisor: number
  readonly paidMinutesPerDay: number
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
}

/**
 * Every version of the coverage thresholds, oldest first.
 *
 * Every version and not the current one, which is the whole point of the table: the validator picks the
 * row governing each trading date, so a rota published in March is still judged by March's figures after
 * April raises them. A "current row" read here would undo the versioning one layer up.
 *
 * An empty answer throws rather than returning `[]`, for `readWorkingHoursRules`'s reason: a rota
 * validated against no thresholds is a rota nothing refused.
 */
export async function readRotaCoverageRules(sql: Sql): Promise<readonly RotaCoverageRuleRow[]> {
  const rows = await sql<RotaCoverageRuleRow[]>`
    select effective_from::text              as "effectiveFrom",
           coverage_segment_minutes          as "coverageSegmentMinutes",
           minimum_therapists_on_floor       as "minimumTherapistsOnFloor",
           minimum_wet_room_capable          as "minimumWetRoomCapable",
           treatment_minutes_cap_per_day     as "treatmentMinutesCapPerDay",
           high_intensity_minutes_cap_per_day as "highIntensityMinutesCapPerDay",
           high_intensity_treatment_codes    as "highIntensityTreatmentCodes",
           is_provisional                    as "isProvisional",
           open_question_id                  as "openQuestionId",
           provisional_note                  as "provisionalNote",
           source_note                       as "sourceNote"
      from rota_coverage_rule
     order by effective_from
  `
  if (rows.length === 0) {
    throw new AppError(
      'invariant_violated',
      'No rota coverage rule version exists, so the floor minimum, the wet-room minimum and the two ' +
        'daily treatment caps are unknown. 0081 seeds version 1 flagged provisional against Y9-coverage; ' +
        'an empty table means the row was deleted. A rota validated against no thresholds is a rota ' +
        'nothing refused.',
    )
  }
  return rows
}

/** Every version of the wage divisors, oldest first. Empty throws, for the reason above. */
export async function readLabourCostRules(sql: Sql): Promise<readonly LabourCostRuleRow[]> {
  const rows = await sql<LabourCostRuleRow[]>`
    select effective_from::text       as "effectiveFrom",
           monthly_wage_days_divisor  as "monthlyWageDaysDivisor",
           paid_minutes_per_day       as "paidMinutesPerDay",
           is_provisional             as "isProvisional",
           open_question_id           as "openQuestionId",
           provisional_note           as "provisionalNote",
           source_note                as "sourceNote"
      from labour_cost_rule
     order by effective_from
  `
  if (rows.length === 0) {
    throw new AppError(
      'invariant_violated',
      'No labour-cost rule version exists, so what an hour of a monthly wage is worth is unknown. 0081 ' +
        'seeds version 1 flagged provisional against Y9-overtime. A forecast computed without it would ' +
        'be a forecast that invented its own idea of what an hour costs.',
    )
  }
  return rows
}

// ---------------------------------------------------------------------------------------------
// What the validator needs about the premises and the people
// ---------------------------------------------------------------------------------------------

/** One trading day's window, straight from `business_day`, never re-derived. */
export interface TradingDayWindowRow {
  readonly tradingDate: string
  readonly opensAt: number
  readonly closesAt: number
}

export async function readTradingDayWindows(
  sql: Sql,
  args: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<readonly TradingDayWindowRow[]> {
  const rows = await sql<{ tradingDate: string; opensAt: Date; closesAt: Date }[]>`
    select trading_date::text as "tradingDate", opens_at as "opensAt", closes_at as "closesAt"
      from business_day
     where trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
     order by trading_date
  `
  return rows.map((row) => ({
    tradingDate: row.tradingDate,
    opensAt: row.opensAt.getTime(),
    closesAt: row.closesAt.getTime(),
  }))
}

/** A therapist the rota may roster: the handle, the skills, and the monthly wage if one is recorded. */
export interface RotaTherapistRow {
  readonly employeeId: string
  /** `staff_reference`, e.g. "Therapist 07". Never a person's name (ADR 0020, brief rule 10). */
  readonly reference: string
  readonly skills: readonly string[]
  /** `employee.basic_wage_fils`, a MONTHLY figure. Null for every seeded employee — a wage is a fact. */
  readonly basicWageFils: number | null
}

/**
 * The therapists employed across the rota's dates, with their skills and wages.
 *
 * ## Who counts as a therapist, since no column says
 *
 * `employee` has no role column: there is nothing in this database that says a person is a therapist rather
 * than a receptionist. So the answer is DERIVED, and it is the availability solver's own reading — a
 * therapist is somebody who holds a skill. `employee_skill.skill` is the `therapist_skill` enum (0030 reuses
 * 0017's type deliberately, so a second spelling cannot drift), which makes "holds at least one
 * `employee_skill` row" exactly "can be the required_skill side of an eligibility join", and that is what
 * `readEligibleTherapists` asks.
 *
 * The filter is load-bearing rather than tidy, and it was missing from the first version of this function.
 * Coverage counts THERAPISTS — a receptionist on shift covers no treatment — and the validator enforces that
 * by counting only the roster it is given, so a read that returned every employee handed the rule a roster
 * that included the front desk. The claim and the measurement then disagreed in the one place the whole rule
 * lives, which is this unit's dominant defect class; the rule was right and the shipped caller was not.
 *
 * A rostered employee with NO skill row therefore does not appear here, and `apps/web/app/(admin)/hr/rota`
 * counts and prints them rather than passing them to the validator, which would refuse the call.
 *
 * Employment is compared against the TRADING dates at both ends, which is `employee.employed_from`'s own
 * comment: trading runs 11:00–02:00, so a comparison against a calendar date gets the last two hours of
 * every day wrong. A therapist who leaves mid-rota is included — they can legitimately be rostered for the
 * part of the period they are still employed for, and excluding them would make their shifts look like
 * assignments to an unknown employee, which the validator refuses.
 *
 * `basic_wage_fils` comes back as a string from `postgres.js` because the column is on the `fils_nonneg`
 * domain over `bigint`; it is converted here and checked to be a safe integer, because a wage that
 * silently became a float is ADR 0007's failure at the boundary rather than in the arithmetic.
 */
export async function readRotaTherapists(
  sql: Sql,
  args: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<readonly RotaTherapistRow[]> {
  const rows = await sql<
    { employeeId: string; reference: string; skills: string[]; basicWageFils: string | null }[]
  >`
    select e.id                as "employeeId",
           e.staff_reference   as "reference",
           coalesce(
             (select array_agg(es.skill::text order by es.skill::text)
                from employee_skill es where es.employee_id = e.id),
             '{}'::text[])     as "skills",
           e.basic_wage_fils::text as "basicWageFils"
      from employee e
     where e.employed_from <= ${args.toTradingDate}::date
       and (e.employed_until is null or e.employed_until >= ${args.fromTradingDate}::date)
       -- The derivation, and the whole reason this read can be called "therapists". See the header.
       and exists (select 1 from employee_skill es where es.employee_id = e.id)
     order by e.staff_reference
  `
  return rows.map((row) => {
    if (row.basicWageFils === null) {
      return {
        employeeId: row.employeeId,
        reference: row.reference,
        skills: row.skills,
        basicWageFils: null,
      }
    }
    const wage = Number(row.basicWageFils)
    if (!Number.isSafeInteger(wage)) {
      throw new AppError(
        'invariant_violated',
        `Employee ${row.employeeId} has a basic wage of ${row.basicWageFils} fils, which is not an exact ` +
          'integer in JavaScript. ADR 0007: money is integer fils, and a wage that became a float at this ' +
          'boundary would put a fraction in the forecast with nothing looking wrong.',
      )
    }
    return {
      employeeId: row.employeeId,
      reference: row.reference,
      skills: row.skills,
      basicWageFils: wage,
    }
  })
}

/**
 * The `therapist_skill` values that reach a wet-room treatment, DERIVED from the catalogue.
 *
 * There is no `wet_room` value in `therapist_skill` and this unit deliberately does not add one. 0012
 * maps `morocco_bath_jacuzzi` to `required_room_type = 'wet'` for both styles and ADR 0021 makes style an
 * attribute of the TREATMENT, so "can deliver a wet-room treatment" is exactly "holds the skill a
 * wet-room service requires" — a join, not a column. A new skill value would instead be a claim about
 * which of nineteen people is trained on the bath, and nobody has said (brief rule 15, Y9-coverage).
 *
 * The consequence today is worth stating because it is what a reader will check: both styles reach the
 * wet room, so every therapist holding either skill counts as capable and the rule is cheap to satisfy.
 * It is not vacuous — a rota whose floor holds only employees with no skill row at all fails it, and that
 * is a real state, because `employee_skill` is where a therapist's styles are recorded and a new joiner
 * has none. The day a real capability table exists it replaces this one read and no rule changes.
 *
 * Archived and unpublished services are excluded: a treatment nobody can book demands no cover.
 */
export async function readWetRoomSkills(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ skill: string }[]>`
    select distinct sk.required_skill::text as skill
      from service_room_type_compat c
      join service s
        on s.style = c.service_style
       and s.treatment_key = c.service_treatment_key
      join service_skill sk on sk.style = c.service_style
     where c.room_type = 'wet'
       and s.archived_at is null
       and s.published_at is not null
     order by 1
  `
  return rows.map((row) => row.skill)
}

/** When the wet room is sellable on one trading date, as instants. */
export interface WetRoomWindowRow {
  readonly tradingDate: string
  readonly startsAt: number
  readonly endsAt: number
}

/**
 * The periods the wet room is bookable in, per trading date, with `resource_block` subtracted.
 *
 * Periods and not a per-day boolean, because "the bath is out until Thursday" is a `resource_block` over
 * part of a day (0012) and a whole-day flag would either demand wet cover during a maintenance window or
 * excuse it for the rest of the day. The subtraction is done in SQL with a multirange difference, so the
 * gaps are exact rather than approximated by a caller looping over blocks.
 *
 * A wet room that is not `is_bookable` at all yields no rows, and then the rule cannot fire — which is
 * right: an unbookable room needs no cover, and a rota refused for a room nobody can book would be a
 * refusal naming a segment whose cause is a room flag.
 */
export async function readWetRoomBookableWindows(
  sql: Sql,
  args: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<readonly WetRoomWindowRow[]> {
  const rows = await sql<{ tradingDate: string; startsAt: Date; endsAt: Date }[]>`
    select bd.trading_date::text as "tradingDate",
           lower(w.r)            as "startsAt",
           upper(w.r)            as "endsAt"
      from business_day bd
      cross join lateral (
        select unnest(
          tstzmultirange(tstzrange(bd.opens_at, bd.closes_at, '[)'))
          - coalesce(
              (select range_agg(rb.period)
                 from resource_block rb
                 join rooms rm on rm.id = rb.room_id
                where rm.room_type = 'wet'
                  and rm.is_bookable
                  and rb.period && tstzrange(bd.opens_at, bd.closes_at, '[)')),
              '{}'::tstzmultirange)
        ) as r
      ) w
     where bd.trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
       and exists (select 1 from rooms where room_type = 'wet' and is_bookable)
     order by bd.trading_date, lower(w.r)
  `
  return rows.map((row) => ({
    tradingDate: row.tradingDate,
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
  }))
}

/** One booked treatment's load on one therapist, which is what the fatigue caps are measured over. */
export interface TreatmentLoadRow {
  readonly appointmentId: string
  readonly employeeId: string
  readonly tradingDate: string
  readonly minutes: number
  readonly treatmentCode: string
}

/**
 * The booked treatment load per therapist per trading date.
 *
 * `holds_resources` only, which is the generated column 0038 added: a cancelled or no-show appointment
 * holds nothing and loads nobody, and counting it would refuse a rota for work that will not happen.
 *
 * `duration_minutes` and NOT the period's length, and not the turnaround either. The cap is on hands-on
 * treatment minutes (Y9-coverage says "treatment-hours"), the turnaround is the room's changeover and the
 * therapist buffer is rest — including either would make the cap measure something Y9-coverage does not
 * name, which is this unit's dominant defect class.
 *
 * `service.treatment_key` is the code the rule version's high-intensity list is matched against, so the
 * classification lives in one place and the SQL carries none of it.
 */
export async function readTreatmentLoads(
  sql: Sql,
  args: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<readonly TreatmentLoadRow[]> {
  return await sql<TreatmentLoadRow[]>`
    select a.id                 as "appointmentId",
           a.therapist_id       as "employeeId",
           a.trading_date::text as "tradingDate",
           sv.duration_minutes  as "minutes",
           s.treatment_key      as "treatmentCode"
      from appointment a
      join service_variant sv on sv.id = a.service_variant_id
      join service s on s.id = sv.service_id
     where a.trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
       and a.holds_resources
     order by a.therapist_id, a.trading_date, a.id
  `
}

// ---------------------------------------------------------------------------------------------
// The published versions
// ---------------------------------------------------------------------------------------------

export interface RotaVersionRow {
  readonly id: string
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly versionNo: number
  readonly supersedesId: string | null
  readonly coverageRuleEffectiveFrom: string
  readonly workingHoursRuleEffectiveFrom: string
  readonly labourCostRuleEffectiveFrom: string
  readonly forecastLabourCostFils: number
  readonly forecastUnpricedEmployees: number
  readonly assignmentDigest: string
  readonly publishedAt: Date
  readonly publishedBy: string
}

export interface RotaVersionAssignmentRow {
  readonly employeeId: string
  readonly tradingDate: string
  readonly startsAt: number
  readonly endsAt: number
  readonly sourceShiftId: string | null
}

/**
 * The version in force for a period: the one nothing supersedes.
 *
 * Expressed as "no other row points at me" rather than "the greatest `version_no`", and the two are the
 * same answer only while the numbering is unbroken. The supersession chain is the structure that is
 * enforced (`unique (supersedes_id)` plus `assert_rota_version_sequence`), so reading the chain is reading
 * the thing the database guarantees; `max(version_no)` would be reading a number beside it.
 */
export async function readCurrentRotaVersion(
  sql: Sql,
  args: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<RotaVersionRow | null> {
  const rows = await sql<
    (Omit<RotaVersionRow, 'forecastLabourCostFils'> & {
      forecastLabourCostFils: string
    })[]
  >`
    select v.id,
           v.from_trading_date::text             as "fromTradingDate",
           v.to_trading_date::text               as "toTradingDate",
           v.version_no                          as "versionNo",
           v.supersedes_id                       as "supersedesId",
           v.coverage_rule_effective_from::text  as "coverageRuleEffectiveFrom",
           v.working_hours_rule_effective_from::text as "workingHoursRuleEffectiveFrom",
           v.labour_cost_rule_effective_from::text   as "labourCostRuleEffectiveFrom",
           v.forecast_labour_cost_fils::text     as "forecastLabourCostFils",
           v.forecast_unpriced_employees         as "forecastUnpricedEmployees",
           v.assignment_digest                   as "assignmentDigest",
           v.published_at                        as "publishedAt",
           v.published_by                        as "publishedBy"
      from rota_version v
     where v.from_trading_date = ${args.fromTradingDate}::date
       and v.to_trading_date = ${args.toTradingDate}::date
       and not exists (select 1 from rota_version later where later.supersedes_id = v.id)
  `
  const [row] = rows
  if (row === undefined) return null
  if (rows.length > 1) {
    throw new AppError(
      'invariant_violated',
      `${rows.length} rota versions for ${args.fromTradingDate}..${args.toTradingDate} are superseded by ` +
        'nothing, so there is no current rota. `unique (supersedes_id)` is what makes this impossible, ' +
        'so seeing it means the constraint is gone rather than that a publish raced.',
    )
  }
  return { ...row, forecastLabourCostFils: Number(row.forecastLabourCostFils) }
}

export async function readRotaVersionAssignments(
  sql: Sql,
  rotaVersionId: string,
): Promise<readonly RotaVersionAssignmentRow[]> {
  const rows = await sql<
    {
      employeeId: string
      tradingDate: string
      startsAt: Date
      endsAt: Date
      sourceShiftId: string | null
    }[]
  >`
    select employee_id          as "employeeId",
           trading_date::text   as "tradingDate",
           lower(period)        as "startsAt",
           upper(period)        as "endsAt",
           source_shift_id      as "sourceShiftId"
      from rota_version_assignment
     where rota_version_id = ${rotaVersionId}::uuid
     order by employee_id, trading_date, lower(period)
  `
  return rows.map((row) => ({
    employeeId: row.employeeId,
    tradingDate: row.tradingDate,
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
    sourceShiftId: row.sourceShiftId,
  }))
}

export interface RotaPublicationNoticeRow {
  readonly employeeId: string
  readonly templateKey: string
  readonly outcome: string
  readonly skippedReason: string | null
  readonly messageId: string | null
}

export async function readRotaPublicationNotices(
  sql: Sql,
  rotaVersionId: string,
): Promise<readonly RotaPublicationNoticeRow[]> {
  return await sql<RotaPublicationNoticeRow[]>`
    select employee_id     as "employeeId",
           template_key    as "templateKey",
           outcome,
           skipped_reason  as "skippedReason",
           message_id      as "messageId"
      from rota_publication_notice
     where rota_version_id = ${rotaVersionId}::uuid
     order by employee_id
  `
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

/** One assignment to publish. Snapshotted onto `rota_version_assignment`, never referenced. */
export interface RotaAssignmentToPublish {
  readonly employeeId: string
  readonly tradingDate: string
  readonly startsAt: number
  readonly endsAt: number
  /** The draft `shift` row it came from, while it lasts. Null for a span with no draft row. */
  readonly sourceShiftId: string | null
}

/**
 * The validator's answer, injected.
 *
 * A PORT, because `packages/db` may not import `packages/core` and the decision is `packages/core`'s. It
 * is required rather than optional, which is the load-bearing part: a caller that never validated has to
 * write `isPublishable: true` into a typed field, and that is a lie somebody can find in a diff rather
 * than a call somebody forgot to make.
 */
export interface RotaVerdict {
  readonly isPublishable: boolean
  /** The rule that refused it, from `ROTA_RULE_NAMES` in `@berelax/core`. Null when publishable. */
  readonly refusedRule: string | null
  /** `describeRotaViolation`'s wording for that refusal. Null when publishable. */
  readonly refusalDetail: string | null
}

/** The template every rota notification is addressed at. Pinned by a CHECK on the notice table too. */
export const ROTA_PUBLISHED_TEMPLATE_KEY = 'hr.rota_published'

export interface PublishRotaArgs {
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly assignments: readonly RotaAssignmentToPublish[]
  readonly verdict: RotaVerdict
  /** The three rule versions that judged and priced it, as `effective_from` dates. */
  readonly coverageRuleEffectiveFrom: string
  readonly workingHoursRuleEffectiveFrom: string
  readonly labourCostRuleEffectiveFrom: string
  readonly forecastLabourCostFils: number
  readonly forecastUnpricedEmployees: number
  /** `rotaAssignmentCanonicalForm()` from `@berelax/core`, over the same assignments. */
  readonly assignmentCanonicalForm: string
  readonly publishedBy: string
}

export interface PublishedRota {
  readonly rotaVersionId: string
  readonly versionNo: number
  readonly supersededId: string | null
  readonly assignmentDigest: string
  /** One per DISTINCT assigned employee. The count the acceptance criterion is about. */
  readonly noticesWritten: number
}

/** The sha-256 of the canonical form, which is what `rota_version.assignment_digest` holds. */
export function rotaAssignmentDigest(canonicalForm: string): string {
  return createHash('sha256').update(canonicalForm, 'utf8').digest('hex')
}

/**
 * Publishes a rota: one immutable version, its snapshotted assignments, one notice per employee, one audit
 * row. All in one transaction, because a version with no notices is a rota nobody was told about.
 *
 * The staff notification is a `rota_publication_notice` row with outcome `skipped` and
 * `no_recipient_on_file`, and that is the honest shipped state rather than a stub that reports success:
 * **nothing in this build holds a staff phone or email.** `employee` has no contact column and there is no
 * `employee_contact` table, so a recipient here would be invented, in the one place an invented value
 * would actually reach a stranger (brief rule 15). 0075 records the same gap for the Google re-auth ladder
 * and answers it the same way. The row says what was attempted, for whom and against which template, and
 * the rota screen prints the count — so the day a staff address exists, the send is one branch here and
 * everything that counts notifications already works.
 */
export async function publishRota(sql: Sql, args: PublishRotaArgs): Promise<PublishedRota> {
  if (!args.verdict.isPublishable) {
    throw new AppError(
      'invariant_violated',
      `This rota is not publishable: ${args.verdict.refusedRule ?? 'unknown rule'} — ` +
        `${args.verdict.refusalDetail ?? 'no detail'}. The publish is refused here rather than recorded ` +
        'and corrected, because a published rota is immutable and a therapist reading it would be reading ' +
        'a roster the business may not lawfully run.',
    )
  }
  if (args.verdict.refusedRule !== null) {
    throw new AppError(
      'validation',
      `A publishable rota carries no refused rule, and this verdict names ${args.verdict.refusedRule}. ` +
        'Half a verdict is the shape that survives a review as "already checked".',
    )
  }
  if (args.assignments.length === 0) {
    throw new AppError(
      'validation',
      'A rota with no assignments rosters nobody. Publishing one would notify nobody and would read as a ' +
        'week the premises trades with no therapists, which no coverage rule would have allowed.',
    )
  }
  if (args.toTradingDate < args.fromTradingDate) {
    throw new AppError(
      'validation',
      `The rota period ${args.fromTradingDate}..${args.toTradingDate} ends before it starts`,
    )
  }

  // Two draft rows with the SAME employee and the SAME span. 0030 allows them — overlapping shifts for one
  // employee are "not an error", because a roster written in two halves is one presence — and
  // `rota_version_assignment`'s primary key does not, for the reason on it: two identical rows would be
  // counted twice by anything reading them.
  //
  // The validator cannot see this case at all: `mergePresences` collapses the two into one presence, so the
  // rota is valid and the publish then fails on a primary key. Refused HERE, naming the employee and the
  // span, because the message the constraint gives is "duplicate key value violates
  // rota_version_assignment_pkey" and the thing to fix is a duplicated shift row in the draft.
  const spans = new Set<string>()
  for (const assignment of args.assignments) {
    const key = `${assignment.employeeId}\u0000${assignment.tradingDate}\u0000${assignment.startsAt}\u0000${assignment.endsAt}`
    if (spans.has(key)) {
      throw new AppError(
        'validation',
        `Employee ${assignment.employeeId} is rostered twice on exactly the same span on ` +
          `${assignment.tradingDate}, so the draft holds two identical shift rows. That is legal in ` +
          '`shift` (0030: overlapping rows for one employee are one presence) and it cannot be published: ' +
          'the published rota would hold the span twice, and anything counting the rows would count it ' +
          'twice. Remove the duplicate draft shift.',
      )
    }
    spans.add(key)
  }

  const digest = rotaAssignmentDigest(args.assignmentCanonicalForm)
  const employeeIds = [...new Set(args.assignments.map((row) => row.employeeId))].sort()

  return await sql.begin(async (tx) => {
    // The current version is read inside the transaction and NOT locked. `unique (supersedes_id)` decides
    // a concurrent publish correctly — the second insert violates it — and a lock here would only hide
    // the race from a caller who would then rely on the lock being remembered.
    const [current] = await tx<{ id: string; versionNo: number }[]>`
      select v.id, v.version_no as "versionNo"
        from rota_version v
       where v.from_trading_date = ${args.fromTradingDate}::date
         and v.to_trading_date = ${args.toTradingDate}::date
         and not exists (select 1 from rota_version later where later.supersedes_id = v.id)
    `
    const [version] = await tx<{ id: string; versionNo: number }[]>`
      insert into rota_version (
        from_trading_date, to_trading_date, supersedes_id, version_no,
        coverage_rule_effective_from, working_hours_rule_effective_from,
        labour_cost_rule_effective_from,
        forecast_labour_cost_fils, forecast_unpriced_employees,
        assignment_digest, published_by
      ) values (
        ${args.fromTradingDate}::date, ${args.toTradingDate}::date,
        ${current?.id ?? null}, ${(current?.versionNo ?? 0) + 1},
        ${args.coverageRuleEffectiveFrom}::date,
        ${args.workingHoursRuleEffectiveFrom}::date,
        ${args.labourCostRuleEffectiveFrom}::date,
        ${args.forecastLabourCostFils}, ${args.forecastUnpricedEmployees},
        ${digest}, ${args.publishedBy}
      )
      returning id, version_no as "versionNo"
    `
    if (version === undefined) {
      throw new AppError('invariant_violated', 'The rota version insert returned no row')
    }

    for (const assignment of args.assignments) {
      await tx`
        insert into rota_version_assignment (
          rota_version_id, employee_id, trading_date, period, source_shift_id
        ) values (
          ${version.id}::uuid, ${assignment.employeeId}::uuid, ${assignment.tradingDate}::date,
          tstzrange(
            to_timestamp(${assignment.startsAt} / 1000.0),
            to_timestamp(${assignment.endsAt} / 1000.0),
            '[)'
          ),
          ${assignment.sourceShiftId}
        )
      `
    }

    // One per DISTINCT employee, which is what the acceptance criterion says and what
    // `rota_publication_notice_one_per_employee_per_version` enforces: somebody rostered on four days of
    // the week is told once about the week, not four times.
    for (const employeeId of employeeIds) {
      await tx`
        insert into rota_publication_notice (
          rota_version_id, employee_id, template_key, outcome, skipped_reason
        ) values (
          ${version.id}::uuid, ${employeeId}::uuid, ${ROTA_PUBLISHED_TEMPLATE_KEY},
          'skipped', 'no_recipient_on_file'
        )
      `
    }

    await tx`
      insert into audit_event (
        actor_kind, actor_label, action, entity_type, entity_id, operation, after_state
      ) values (
        'staff', ${args.publishedBy}, 'hr.rota.published', 'rota_version', ${version.id}, 'create',
        ${tx.json({
          fromTradingDate: args.fromTradingDate,
          toTradingDate: args.toTradingDate,
          versionNo: version.versionNo,
          supersedesId: current?.id ?? null,
          assignments: args.assignments.length,
          employees: employeeIds.length,
          forecastLabourCostFils: args.forecastLabourCostFils,
          forecastUnpricedEmployees: args.forecastUnpricedEmployees,
          assignmentDigest: digest,
          coverageRuleEffectiveFrom: args.coverageRuleEffectiveFrom,
          workingHoursRuleEffectiveFrom: args.workingHoursRuleEffectiveFrom,
          labourCostRuleEffectiveFrom: args.labourCostRuleEffectiveFrom,
        })}
      )
    `

    return {
      rotaVersionId: version.id,
      versionNo: version.versionNo,
      supersededId: current?.id ?? null,
      assignmentDigest: digest,
      noticesWritten: employeeIds.length,
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Swaps and open-shift claims
// ---------------------------------------------------------------------------------------------

export interface RotaChangeRequestArgs {
  readonly kind: 'swap' | 'open_shift_claim'
  /** The published version the request was made against. */
  readonly rotaVersionId: string
  readonly shiftId: string | null
  /** Null for a claim: an open shift has no assignment, so there is nobody to take it from. */
  readonly fromEmployeeId: string | null
  readonly toEmployeeId: string
  readonly verdict: RotaVerdict
  readonly requestedBy: string
  /**
   * How to publish the rota AS CHANGED, when the verdict allows it.
   *
   * A thunk rather than the arguments, because the caller has already validated the changed rota and
   * therefore already holds its assignments, its digest and its forecast. Recomputing any of them here
   * would be a second answer to "what does this rota cost", and the one that could disagree with the
   * verdict beside it.
   */
  readonly publish: () => Promise<PublishedRota>
}

export interface RotaChangeRequestResult {
  readonly requestId: string
  readonly decision: 'applied' | 'refused'
  readonly refusedRule: string | null
  readonly appliedRotaVersionId: string | null
}

/**
 * Records a swap or a claim, applying it when the validator allowed it and recording the rule when not.
 *
 * Decided in the transaction that made it, with no pending state. A pending request needs an APPROVER and
 * there is no admin session until W-SYS-01, so a pending row would sit waiting for an identity that does
 * not exist — and the first thing built on top of it would be a way to approve without one.
 *
 * The REFUSED rows are the point of the table: "why can't I swap with her on Thursday?" has one answer and
 * it is the rule name the validator returned. Without the row, that answer exists only in whatever the
 * screen happened to say at the time.
 */
export async function recordRotaChangeRequest(
  sql: Sql,
  args: RotaChangeRequestArgs,
): Promise<RotaChangeRequestResult> {
  if ((args.kind === 'swap') !== (args.fromEmployeeId !== null)) {
    throw new AppError(
      'validation',
      `A ${args.kind} ${args.kind === 'swap' ? 'needs' : 'must not name'} a therapist to take the shift ` +
        'from. An open shift is a `shift` row with no assignment (0030), so there is nobody to take it ' +
        'from; a swap without a giver would silently create an assignment out of nothing.',
    )
  }
  if (args.verdict.isPublishable === (args.verdict.refusedRule !== null)) {
    throw new AppError(
      'validation',
      'A verdict either allows the change and names no rule, or refuses it and names one. This one says ' +
        `isPublishable=${args.verdict.isPublishable} and refusedRule=${String(args.verdict.refusedRule)}, ` +
        'which is half a verdict — the shape that survives a review as "already checked".',
    )
  }

  // The application is published OUTSIDE the request insert's transaction boundary on purpose: `publish`
  // opens its own, and nesting `sql.begin` inside `sql.begin` on postgres.js yields a SAVEPOINT whose
  // rollback would leave the request row claiming a version that no longer exists. Publish first, then
  // record — so a failed publish records nothing rather than recording a lie.
  const applied = args.verdict.isPublishable ? await args.publish() : null

  const [row] = await sql<{ id: string }[]>`
    insert into rota_change_request (
      kind, rota_version_id, shift_id, from_employee_id, to_employee_id,
      decision, refused_rule, refusal_detail, applied_rota_version_id, requested_by
    ) values (
      ${args.kind}, ${args.rotaVersionId}::uuid,
      ${args.shiftId === null ? null : args.shiftId}::uuid,
      ${args.fromEmployeeId === null ? null : args.fromEmployeeId}::uuid,
      ${args.toEmployeeId}::uuid,
      ${applied === null ? 'refused' : 'applied'},
      ${args.verdict.refusedRule}, ${args.verdict.refusalDetail},
      ${applied?.rotaVersionId ?? null},
      ${args.requestedBy}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The rota change request insert returned no row')
  }
  return {
    requestId: row.id,
    decision: applied === null ? 'refused' : 'applied',
    refusedRule: args.verdict.refusedRule,
    appliedRotaVersionId: applied?.rotaVersionId ?? null,
  }
}

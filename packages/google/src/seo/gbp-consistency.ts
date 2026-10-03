import {
  describeGoogleProvenance,
  filsFromStoredDigits,
  type GbpClockTime,
  type GbpConsistencyReport,
  type GbpDayHours,
  type GbpFactProvenance,
  type GbpServicePrice,
  gbpConsistencyReport,
  parseClockTime,
  parseGrossAedToFils,
  SCHEMA_DAY_NAMES,
} from '@berelax/core'
import {
  type Actor,
  type PremisesFacts,
  readPremisesFacts,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type {
  BusinessProfileProvider,
  GbpBusinessPeriod,
  GbpDayOfWeek,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { LOCATION_READ_MASK } from '../adapters/business-information.ts'
import { parseGbpResourceRef } from '../capability-resolver.ts'
import { type DegradationCause, type WithGoogleDeps, withGoogle } from '../with-google.ts'

/**
 * The third consumer of the Google connection: what the website says against what the profile shows.
 *
 * ## Why this unit is a MANUAL SNAPSHOT and not an API read
 *
 * There is no Business Profile API access in this build. docs/10 §4 is the reference and
 * `OPEN-QUESTIONS Y3-gbp-api` is the question — *"GBP Basic API Access application"*, status **open**,
 * an application nobody has answered. So `localSeoChecker` declares `degradesTo: 'manual_snapshot'`
 * (`../consumers.ts`), and this module's ordinary path at launch is the degraded one.
 *
 * That makes the degradation a FEATURE rather than an error path, which docs/10 §6 states as a rule for
 * the whole Google surface: *"A fallback designed as something you hope not to need is a fallback you
 * never finish."* The acceptance criterion is the measurable form of it — the finding count is the same
 * in both modes — and it is asserted in `gbp-consistency.itest.ts` against one seeded divergence driven
 * through both.
 *
 * ## What a manual snapshot IS, and the one thing it is not
 *
 * It is **a named human's claim about what Google shows**, recorded with who made it and when. It is not
 * an observation this system made, and the two are never rendered as one thing: the claim's
 * `claimedBy`/`claimedAtIso` ride on `GbpFactProvenance` into every finding, and
 * `describeGoogleProvenance` is the sentence that spells the difference out. A snapshot written down
 * without an author would be indistinguishable from a reading, which is the brief's rule 15 one step out
 * from a value: a plausible provenance is worse than a blank one.
 *
 * The claim is recorded as an `audit_event` with `operation: 'create'` and the staff actor who made it,
 * which is **append-only** (ADR 0008) and therefore answers *who said so* for ever. There is no
 * `gbp_snapshot` table, and that is a decision rather than an omission: the snapshot's whole value is
 * the comparison it is made for, which happens in the same request, and a second home for it would be a
 * second answer to what the profile said on a given day — with nothing holding the two equal.
 *
 * ## Read-only by construction
 *
 * `.dependency-cruiser.cjs`'s `gbp-consistency-check-is-read-only` forbids this module from reaching
 * `../adapters/business-information-write.ts`, with a known-bad fixture in `scripts/test-gates.mjs` that
 * asserts the rule fires by name. The write adapter exists — a human-approved hours change is a real
 * feature — and it is reached from the screen, never from the checker. A checker that could write is a
 * checker that will eventually be asked to "just fix it", and the fix a naive PATCH applies is wiping
 * the Ramadan `specialHours` (docs/10 §7).
 *
 * ## NAP comes only from the premises row
 *
 * `readPremisesFacts` is the one read, and it is the authority docs/09 §4 names. This module holds no
 * address, no telephone number, no price and no opening-hour literal, which
 * `packages/fixtures/src/seo-nap-literals.test.ts` scans for — because a module with its own copy of the
 * hours answers *"consistent"* about itself, silently and for ever.
 *
 * **The WhatsApp number is deliberately not compared.** `premises.phone_whatsapp` holds
 * `WHATSAPP-PENDING-Y1-NAP`, which `is_placeholder_text()` refuses, and `Y1-nap` resolved to **neither**
 * candidate: promoting the prototype's number would publish a number that may not reach the business.
 * A comparison against a placeholder would report a divergence on every run, about a value nobody has
 * confirmed — which is the cry-wolf finding ADR 0085 is about. The manifest's `provisional` note for
 * this unit predates that reversal and says to take the prototype number; `whatsappIsPlaceholder` on the
 * facts row is why this module does not.
 */

/** Which arm produced the Google side of the comparison. */
export type GbpCheckMode = 'api' | 'manual_snapshot'

/** One day of the Google profile's week, as a person transcribed it from the screen. */
export interface GbpSnapshotDay {
  /** `premises_hours.day_of_week`: 0 is Sunday. */
  readonly dayOfWeek: number
  /** `HH:MM`, or absent when the person marked the day closed. */
  readonly openText?: string
  readonly closeText?: string
  readonly closed?: boolean
}

/** One price point from the profile, as a person transcribed it. AED, not fils: a form takes AED. */
export interface GbpSnapshotPrice {
  readonly serviceKey: string
  readonly durationMinutes: number
  readonly grossAedText: string
}

/**
 * A human's claim about what the Google profile shows.
 *
 * `claimedBy` is a staff reference and never a person's name (the brief's rule 10), because the admin
 * session carries an employment handle and this build has no display name for anybody.
 */
export interface GbpManualSnapshot {
  readonly claimedBy: string
  readonly claimedAtIso: string
  readonly days: readonly GbpSnapshotDay[]
  readonly prices: readonly GbpSnapshotPrice[]
}

/** One row of the snapshot form: what to look at on the profile, and what to type. */
export interface GbpSnapshotFormField {
  readonly name: string
  readonly label: string
  readonly kind: 'time_of_day' | 'closed_flag' | 'amount_aed'
}

/**
 * The form, as a view model.
 *
 * It deliberately does NOT carry the website's own values. A form that pre-filled the Google column with
 * what the premises row says would be answered by a person pressing Enter, and the check would then
 * report *"consistent"* about a profile nobody looked at — the self-comparison this unit's NAP rule
 * exists to prevent, arriving through the one door the rule cannot close.
 */
export interface GbpSnapshotForm {
  readonly reason: string
  readonly fields: readonly GbpSnapshotFormField[]
}

export interface GbpConsistencyOutcome {
  readonly mode: GbpCheckMode
  /** Why the API arm was not used, or null when it was. */
  readonly cause: DegradationCause | 'AccessNotGranted' | null
  /** Null when there is no snapshot to compare: the form is rendered and nothing is judged. */
  readonly report: GbpConsistencyReport | null
  /** The sentence that says whether the Google figures were read or claimed. */
  readonly provenance: string | null
  /** Rendered whenever the API arm did not answer. The degraded mode's working feature. */
  readonly form: GbpSnapshotForm | null
  readonly correlationId: string
}

export interface GbpConsistencyDeps {
  readonly sql: Sql
  readonly google: WithGoogleDeps
  readonly profile: Pick<BusinessProfileProvider, 'getLocation'>
  /** Who the audit row for a recorded claim is attributed to. The person, never the agent. */
  readonly actor: Actor
}

/** `premises_hours.day_of_week` (0 = Sunday) for each API day name. One statement, both directions. */
const DAY_OF_WEEK_FOR: Readonly<Record<GbpDayOfWeek, number>> = Object.freeze({
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
})

const clockTimeOf = (time: { readonly hours: number; readonly minutes: number }): GbpClockTime => ({
  hours: time.hours,
  minutes: time.minutes,
})

/**
 * The website's trading week, from `premises_hours`.
 *
 * A closed day loses its times here rather than carrying them, which is the discriminated union in
 * `@berelax/core` doing its job: the row holds an `open_time` and a `close_time` even when `is_closed`
 * is true, and a comparison that read them would report a divergence about a day nobody is open on.
 */
export function websiteHoursFrom(facts: PremisesFacts): readonly GbpDayHours[] {
  return facts.hours.map((row) =>
    row.isClosed
      ? { dayOfWeek: row.dayOfWeek, isClosed: true as const }
      : {
          dayOfWeek: row.dayOfWeek,
          isClosed: false as const,
          open: parseClockTime(row.openTime),
          close: parseClockTime(row.closeTime),
        },
  )
}

/**
 * The website's prices, from the price in force.
 *
 * `grossPriceFils` arrives as a string because the `fils` domain is `bigint` and the driver never parses
 * one; `filsFromStoredDigits` is the reader that checks the round trip rather than `Number()`, which is
 * where a money figure silently rounds (ADR 0007).
 *
 * The key is the slug and the duration, because a service is priced per duration and the display name is
 * editable copy — matching on a name would make a rename look like a price change.
 */
export function websitePricesFrom(facts: PremisesFacts): readonly GbpServicePrice[] {
  return facts.prices.map((row) => ({
    serviceKey: row.slug,
    label: row.publicDisplayName,
    durationMinutes: row.durationMinutes,
    grossFils: filsFromStoredDigits(row.grossPriceFils, `${row.slug} gross price`),
  }))
}

/** The profile's week, from `regularHours.periods`. A day with no period is a day it is closed. */
export function googleHoursFrom(
  periods: readonly GbpBusinessPeriod[],
  daysToReport: readonly number[],
): readonly GbpDayHours[] {
  const byDay = new Map<number, GbpBusinessPeriod>()
  for (const period of periods) {
    const dayOfWeek = DAY_OF_WEEK_FOR[period.openDay]
    byDay.set(dayOfWeek, period)
  }
  return daysToReport.map((dayOfWeek) => {
    const period = byDay.get(dayOfWeek)
    return period === undefined
      ? { dayOfWeek, isClosed: true as const }
      : {
          dayOfWeek,
          isClosed: false as const,
          open: clockTimeOf(period.openTime),
          close: clockTimeOf(period.closeTime),
        }
  })
}

/** A transcribed snapshot, read into the comparison's shape, refusing anything unreadable. */
export function snapshotHoursFrom(snapshot: GbpManualSnapshot): readonly GbpDayHours[] {
  return snapshot.days.map((day) => {
    if (day.closed === true) return { dayOfWeek: day.dayOfWeek, isClosed: true as const }
    if (day.openText === undefined || day.closeText === undefined) {
      throw new AppError(
        'validation',
        `The snapshot for ${SCHEMA_DAY_NAMES[day.dayOfWeek] ?? `day ${day.dayOfWeek}`} carries ` +
          'neither a pair of times nor a closed mark. A half-filled day would be compared as midnight ' +
          'and would report a divergence against a value nobody entered.',
        {
          userFacing: true,
          details: { reason: 'gbp_snapshot_day_incomplete', day: day.dayOfWeek },
        },
      )
    }
    return {
      dayOfWeek: day.dayOfWeek,
      isClosed: false as const,
      open: parseClockTime(day.openText),
      close: parseClockTime(day.closeText),
    }
  })
}

/** The transcribed prices, matched to the website's labels so a finding reads the same in both arms. */
export function snapshotPricesFrom(
  snapshot: GbpManualSnapshot,
  website: readonly GbpServicePrice[],
): readonly GbpServicePrice[] {
  return snapshot.prices.map((price) => {
    const known = website.find(
      (candidate) =>
        candidate.serviceKey === price.serviceKey &&
        candidate.durationMinutes === price.durationMinutes,
    )
    if (known === undefined) {
      throw new AppError(
        'validation',
        `The snapshot names ${price.serviceKey} at ${price.durationMinutes} minutes, which is not a ` +
          'published price point. A snapshot of a service this site does not sell has nothing to be ' +
          'compared against, and inventing a label for it would put a service name in a finding that ' +
          'no row supports.',
        { userFacing: true, details: { reason: 'gbp_snapshot_price_unknown' } },
      )
    }
    return {
      serviceKey: price.serviceKey,
      label: known.label,
      durationMinutes: price.durationMinutes,
      grossFils: parseGrossAedToFils(price.grossAedText),
    }
  })
}

/**
 * The form a person fills in, built from the subjects the comparison can judge.
 *
 * Built from the premises facts rather than from a fixed list, so a service added to the menu appears on
 * the form with no code change — and so a form field can never name a subject the comparison would then
 * refuse.
 */
export function manualSnapshotForm(facts: PremisesFacts, reason: string): GbpSnapshotForm {
  const fields: GbpSnapshotFormField[] = []
  for (const row of facts.hours) {
    const day = SCHEMA_DAY_NAMES[row.dayOfWeek] ?? `day ${row.dayOfWeek}`
    fields.push({ name: `open-${row.dayOfWeek}`, label: `${day}: opens`, kind: 'time_of_day' })
    fields.push({ name: `close-${row.dayOfWeek}`, label: `${day}: closes`, kind: 'time_of_day' })
    fields.push({ name: `closed-${row.dayOfWeek}`, label: `${day}: closed`, kind: 'closed_flag' })
  }
  for (const price of facts.prices) {
    fields.push({
      name: `price-${price.slug}-${price.durationMinutes}`,
      label: `${price.publicDisplayName} (${price.durationMinutes} minutes): price on the profile`,
      kind: 'amount_aed',
    })
  }
  return { reason, fields: Object.freeze(fields) }
}

/**
 * The claim, as an append-only audit row.
 *
 * `operation: 'create'` so `AuditWriter.requiresAudit` treats it as a row that must exist, and the
 * actor is the person who made the claim. The payload is the transcription verbatim: it is evidence of
 * what somebody said they saw, and normalising it here would record this build's reading of their
 * answer rather than their answer.
 */
export async function recordManualSnapshot(
  deps: Pick<GbpConsistencyDeps, 'sql' | 'actor'>,
  snapshot: GbpManualSnapshot,
): Promise<void> {
  await withUnitOfWork(deps.sql, deps.actor, async (uow) => {
    await uow.audit.record({
      action: 'google.gbp_snapshot.recorded',
      entityType: 'gbp_manual_snapshot',
      operation: 'create',
      after: {
        claimedBy: snapshot.claimedBy,
        claimedAtIso: snapshot.claimedAtIso,
        days: snapshot.days,
        prices: snapshot.prices,
      },
    })
  })
}

/**
 * Runs the check.
 *
 * The API arm is tried first and is expected to degrade for the whole of this build's life so far. The
 * degraded arm is not an error: with a snapshot it produces the same findings, and without one it
 * produces the form. Neither throws, which is the acceptance criterion's own wording and the reason the
 * outcome is a value rather than an exception.
 */
export async function runGbpConsistencyCheck(
  deps: GbpConsistencyDeps,
  options: { readonly snapshot?: GbpManualSnapshot } = {},
): Promise<GbpConsistencyOutcome> {
  const facts = await readPremisesFacts(deps.sql)
  if (facts === null) {
    throw new AppError(
      'invariant_violated',
      'There is no premises row, so there is nothing to compare the Google profile against. 0003 seeds ' +
        'the singleton; an absent one means this database never had its migrations applied.',
    )
  }
  const website = { hours: websiteHoursFrom(facts), prices: websitePricesFrom(facts) }
  const daysToReport = website.hours.map((day) => day.dayOfWeek)

  const outcome = await withGoogle(deps.google, 'gbp_location', async (context) => {
    const ref = parseGbpResourceRef(context.resourceRef)
    const location = await deps.profile.getLocation({
      name: ref.location,
      readMask: LOCATION_READ_MASK,
    })
    return googleHoursFrom(location.regularHours?.periods ?? [], daysToReport)
  })

  if (outcome.kind === 'ok') {
    const provenance: Extract<GbpFactProvenance, { side: 'google' }> = {
      side: 'google',
      authority: 'business_information_v1',
    }
    return {
      mode: 'api',
      cause: null,
      // The API arm compares hours only. Business Information carries no service prices at all — a
      // profile's prices live in a separate `priceLists` resource docs/10 §7 does not cover and this
      // build has never read — so a price finding is the snapshot's to make. Passing the website's own
      // prices as the Google side would make every price agree with itself.
      report: gbpConsistencyReport({
        website: { hours: website.hours, prices: [] },
        google: { provenance, hours: outcome.value, prices: [] },
      }),
      provenance: describeGoogleProvenance(provenance),
      form: null,
      correlationId: outcome.correlationId,
    }
  }

  const reason =
    `The Google profile could not be read (${outcome.cause}), so this check is running on a snapshot ` +
    'somebody records by hand. There is no Business Profile API access in this build: docs/10 §4 and ' +
    'OPEN-QUESTIONS Y3-gbp-api.'

  if (options.snapshot === undefined) {
    return {
      mode: 'manual_snapshot',
      cause: outcome.cause,
      report: null,
      provenance: null,
      form: manualSnapshotForm(facts, reason),
      correlationId: outcome.correlationId,
    }
  }

  const provenance: Extract<GbpFactProvenance, { side: 'google' }> = {
    side: 'google',
    authority: 'manual_snapshot',
    claimedBy: options.snapshot.claimedBy,
    claimedAtIso: options.snapshot.claimedAtIso,
  }
  return {
    mode: 'manual_snapshot',
    cause: outcome.cause,
    report: gbpConsistencyReport({
      website,
      google: {
        provenance,
        hours: snapshotHoursFrom(options.snapshot),
        prices: snapshotPricesFrom(options.snapshot, website.prices),
      },
    }),
    provenance: describeGoogleProvenance(provenance),
    // The form stays on the outcome even when a snapshot was supplied: the screen renders it again with
    // the findings beside it, because the next thing an owner does after reading a divergence is correct
    // the transcription or record a fresher one.
    form: manualSnapshotForm(facts, reason),
    correlationId: outcome.correlationId,
  }
}

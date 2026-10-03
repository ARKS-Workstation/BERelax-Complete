import {
  type AnalyticsAggregateKind,
  actionSourceFor,
  analyticsEventId,
  DISPATCH_DESTINATIONS,
  dispatchPayloadBytes,
} from '@berelax/analytics'
import {
  assertStatementIsInThePast,
  buildEgressPayload,
  type ConversionStatement,
  conversionStatements,
  packageConversionStatements,
} from '@berelax/core'
import {
  enqueueAnalyticsDispatch,
  type OfflineConversionFacts,
  offlineInvoiceConversions,
  offlineNoShowConversions,
  offlinePackageConversions,
  type Sql,
  tradingDateAt,
} from '@berelax/db'
import { AppError, FUNNEL_TERMINAL_STAGE, type FunnelStage } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The offline conversion loop (A-MEAS-05).
 *
 * ## What this pass is for
 *
 * A walk-in and a phone booking never had a browser, so no on-page tag ever reported them. The till is
 * what knows they happened, and it knows it HOURS or DAYS after the visit. So this pass reads the
 * documents for a trading date and enqueues the conversion each one is worth, carrying the instant of the
 * actual visit.
 *
 * ## A corrected value is a NEW statement, and that is the whole design
 *
 * `conversionStatements` in `@berelax/core` turns a conversion's outcome into an ordered ledger of
 * statements, each with its own revision, its own instant and a signed DELTA. This pass enqueues one
 * dispatch per statement, and the revision is what makes each `event_id` its own — without which the
 * platform deduplicates the correction against the figure it corrects and discards it silently, leaving
 * the wrong number standing with nothing saying so.
 *
 * The arithmetic is not here. A no-show's void being exactly the negative of everything already stated, a
 * credit note's sign, and the invoice gross winning over the booking estimate are all decided in one pure
 * module, because A-MEAS-07 compares internal truth against what was pushed and a second derivation of the
 * value is precisely the variance it would report with both sides internally consistent.
 *
 * ## The past instant is asserted and never computed
 *
 * `assertStatementIsInThePast` refuses a statement dated at or after the pass. The database's own
 * `occurred_at <= decided_at` (0137) is satisfied by EQUALITY, so it cannot tell "the visit was two days
 * ago" from "the visit was this instant" — and equality is exactly what a clock read in the wrong place
 * produces. The platform's accepted AGE for a past event is its own figure and is not on file in this
 * build, so nothing is clamped to a window (brief rule 15, OPEN-QUESTIONS `Y1-analytics-credentials`).
 *
 * ## What this pass CANNOT do yet, and refuses rather than guesses
 *
 * `analytics_dispatch.session_id` is the session whose consent governs the push, and nothing in this
 * schema joins an analytics session to a booking: A-FIRST-08 owns first- and last-touch attribution and is
 * not built. So the session comes from {@link AnalyticsSessionResolver}, whose production implementation
 * refuses by name, and every refusal is COUNTED and logged. A pass that picked a session would be a
 * confident answer derived from nothing — and the consequence is not a wrong report, it is a conversion
 * pushed under somebody else's consent decision.
 *
 * The consent gate itself is NOT re-asked here, for ADR 0091's reason: `enqueueAnalyticsDispatch` asks
 * `dispatch_consent_gap`, the ZY312 trigger asks the same function, and a second check in a second
 * producer is the defect A-MEAS-02 was built to prevent.
 */

export const OFFLINE_CONVERSIONS_JOB = 'analytics.offline-conversions'

/** The `agent_definition` row 0137's sibling pass shares. Spelled once and read by the registry. */
export const OFFLINE_CONVERSIONS_AGENT = 'analytics_dispatch'

/**
 * Which analytics session a conversion belongs to, or why it cannot be said.
 *
 * An injected SEAM and not a repository call, because the answer is A-FIRST-08's to give and the shape of
 * its table is not decided. A resolver rather than a nullable column keeps this pass's own logic — the
 * ledger, the instants, the enqueue — testable against a real database today.
 */
export type AnalyticsSessionResolver = (
  facts: OfflineConversionFacts,
) => Promise<string | null> | string | null

/**
 * The resolver this build ships, which answers "nothing on file" for every conversion.
 *
 * Not a stub to be replaced quietly: it is the honest answer while A-FIRST-08 does not exist, and the
 * pass's log line carries the count so that "no conversions were uploaded" reads as *the attribution is
 * missing* rather than as *there were none*. ADR 0002's rule, applied to a pass instead of a report.
 */
export const NO_ATTRIBUTION_ON_FILE: AnalyticsSessionResolver = () => null

export interface OfflineConversionPassResult {
  readonly conversions: number
  readonly statements: number
  readonly enqueued: number
  readonly suppressed: number
  readonly alreadyPresent: number
  /** Conversions skipped because no analytics session is on file. A-FIRST-08's, and counted until then. */
  readonly withoutASession: number
  /** Conversions skipped because no booking channel is on file, so the action source would be a guess. */
  readonly withoutAChannel: number
  /** The arithmetic sum, in fils, of every statement this pass enqueued. Zero for a voided conversion. */
  readonly netFils: number
}

/** The terminal funnel stage, narrowed once, because a conversion value belongs to exactly one stage. */
const TERMINAL: FunnelStage = ((stage: FunnelStage | undefined): FunnelStage => {
  if (stage === undefined) {
    throw new AppError(
      'invariant_violated',
      'FUNNEL_STAGES is empty, so there is no terminal stage for a conversion value to belong to. The ' +
        'egress guard drops a figure on any other stage, so every statement here would push nothing.',
    )
  }
  return stage
})(FUNNEL_TERMINAL_STAGE)

/** The aggregate kind each fact's id is, as a TOTAL map so a fourth kind stops this file compiling. */
const AGGREGATE_KIND: Readonly<
  Record<OfflineConversionFacts['aggregate'], AnalyticsAggregateKind>
> = Object.freeze({
  invoice: 'invoice',
  booking: 'booking',
  package: 'package',
})

/**
 * The statements one conversion's facts are worth.
 *
 * A package goes through `packageConversionStatements` and everything else through
 * `conversionStatements`, which is the one branch in this pass: the provisional `Y11-vat-package` position
 * values a package at REDEMPTION and pushes zero at the sale, and that is a different ledger rather than a
 * different figure in the same one.
 */
export function statementsFor(facts: OfflineConversionFacts): readonly ConversionStatement[] {
  if (facts.aggregate === 'package') {
    return packageConversionStatements({
      saleAtIso: facts.occurredAtIso,
      redemption:
        facts.releasedFils === null || facts.releasedAtIso === null
          ? undefined
          : { releasedFils: facts.releasedFils, redeemedAtIso: facts.releasedAtIso },
    })
  }
  return conversionStatements({
    initialFils: facts.grossFils,
    occurredAtIso: facts.occurredAtIso,
    noShow: facts.noShowAtIso === null ? undefined : { atIso: facts.noShowAtIso },
    credited:
      facts.creditedFils === 0 || facts.creditedAtIso === null
        ? undefined
        : { grossFils: facts.creditedFils, atIso: facts.creditedAtIso },
  })
}

/**
 * One pass over a trading date's offline conversions. Takes its instant, so a suite drives it frozen.
 *
 * Every statement is enqueued INDIVIDUALLY and the result is reported per statement rather than per
 * conversion, because the thing worth counting is what a platform was told: a conversion of three
 * statements is three rows, three ids and three figures that have to sum to the document.
 */
export async function runOfflineConversionPass(
  sql: Sql,
  input: {
    readonly tradingDate: string
    readonly nowIso: string
    readonly destinations: readonly string[]
    readonly resolveSession: AnalyticsSessionResolver
  },
): Promise<OfflineConversionPassResult> {
  const facts = [
    ...(await offlineInvoiceConversions(sql, { tradingDate: input.tradingDate })),
    ...(await offlineNoShowConversions(sql, { tradingDate: input.tradingDate })),
    ...(await offlinePackageConversions(sql, { tradingDate: input.tradingDate })),
  ]
  return enqueueOfflineConversions(sql, {
    facts,
    nowIso: input.nowIso,
    destinations: input.destinations,
    resolveSession: input.resolveSession,
  })
}

/**
 * The second half of the pass: the facts, as statements, as dispatch rows.
 *
 * Separate from the READ so that the ledger, the identities and the instants can be proved against a real
 * database without a trading date's worth of invoices, credit notes and packages being constructed first.
 * `offline-conversions.itest.ts` supplies the facts the way the till will and asserts the sums over the
 * rows this writes; it drives `runOfflineConversionPass` over the SEEDED trading dates for the other half,
 * which is the one a hand-built fixture cannot cover — whether the three queries find anything at all.
 */
export async function enqueueOfflineConversions(
  sql: Sql,
  input: {
    readonly facts: readonly OfflineConversionFacts[]
    readonly nowIso: string
    readonly destinations: readonly string[]
    readonly resolveSession: AnalyticsSessionResolver
  },
): Promise<OfflineConversionPassResult> {
  if (input.destinations.length === 0) {
    throw new AppError(
      'invariant_violated',
      'An offline conversion pass was asked to upload to no destinations at all, which would report a ' +
        "clean pass over every conversion while telling nobody anything — ADR 0002's failure exactly. " +
        "The destinations are the registry's `DISPATCH_DESTINATIONS`.",
    )
  }
  const facts = input.facts

  let statements = 0
  let enqueued = 0
  let suppressed = 0
  let alreadyPresent = 0
  let withoutASession = 0
  let withoutAChannel = 0
  let netFils = 0

  for (const conversion of facts) {
    const sessionId = await input.resolveSession(conversion)
    if (sessionId === null) {
      withoutASession += 1
      console.warn(
        `${OFFLINE_CONVERSIONS_JOB} has no analytics session for ${conversion.aggregate} ` +
          `${conversion.aggregateId}, so its conversion is NOT uploaded. A-FIRST-08 owns the attribution; ` +
          "a session chosen here would push a conversion under somebody else's consent decision.",
      )
      continue
    }
    if (conversion.bookingSource === null) {
      withoutAChannel += 1
      console.warn(
        `${OFFLINE_CONVERSIONS_JOB} has no booking channel for ${conversion.aggregate} ` +
          `${conversion.aggregateId}, so its action_source is not uploaded rather than defaulted: the ` +
          'value a default reaches is `website`, which reports a walk-in as a web order.',
      )
      continue
    }
    const actionSource = actionSourceFor(conversion.bookingSource)

    for (const statement of statementsFor(conversion)) {
      assertStatementIsInThePast({ statement, passAtIso: input.nowIso })
      statements += 1
      netFils += statement.valueFils
      /*
       * The payload is built from the SALE's or the document's catalogue ref... which this pass does not
       * have, so it is built for the package-template ref the egress guard already has a code for and the
       * FIGURE is what travels. The value is carried on the terminal stage only — the guard drops it
       * anywhere else and counts the drop, which is why the stage is pinned here rather than taken from
       * the facts.
       */
      const { payload } = buildEgressPayload({
        ref: { kind: 'package_template' },
        eventType: TERMINAL,
        quantity: 1,
        valueFils: statement.valueFils,
      })
      for (const destination of input.destinations) {
        const result = await enqueueAnalyticsDispatch(sql, {
          sessionId,
          destination,
          funnelStage: TERMINAL,
          decidedAtIso: input.nowIso,
          eventId: analyticsEventId({
            kind: AGGREGATE_KIND[conversion.aggregate],
            aggregateId: conversion.aggregateId,
            stage: TERMINAL,
            revision: statement.revision,
          }),
          payload: dispatchPayloadBytes(payload),
          actionSource,
          // The instant of the VISIT, the no-show or the credit note — never the instant of the pass.
          occurredAtIso: statement.occurredAtIso,
        })
        if (result.alreadyPresent) alreadyPresent += 1
        else if (result.state === 'queued') enqueued += 1
        else suppressed += 1
      }
    }
  }

  return {
    conversions: facts.length,
    statements,
    enqueued,
    suppressed,
    alreadyPresent,
    withoutASession,
    withoutAChannel,
    netFils,
  }
}

/** A log line on every pass, including an empty one — a pass that logged only changes reads as stopped. */
export function describeOfflineConversionPass(result: OfflineConversionPassResult): string {
  return (
    `${result.conversions} conversion(s), ${result.statements} statement(s), ${result.enqueued} queued, ` +
    `${result.suppressed} suppressed by consent, ${result.alreadyPresent} already on file, net ` +
    `${result.netFils} fils; NOT uploaded: ${result.withoutASession} with no analytics session ` +
    `(A-FIRST-08), ${result.withoutAChannel} with no booking channel`
  )
}

let configured: Sql | undefined

export function setOfflineConversionSql(sql: Sql): void {
  configured = sql
}

async function offlineConversionsHandler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${OFFLINE_CONVERSIONS_JOB} ran before setOfflineConversionSql() supplied a connection. run.ts ` +
        'calls it before startWorkers().',
    )
  }
  const nowIso = context.now()
  /*
   * The trading date the pass is FOR, which is the one that has just closed.
   *
   * `tradingDateAt` and not a truncated timestamp, for `cash-forecast.ts`' reason: trading runs
   * 11:00-02:00, so a pass at 03:17 belongs to the session that opened the previous morning — the
   * calendar's own answer, which is the row whose `opens_at` is the most recent one before this instant.
   * If the calendar holds nothing this pass REFUSES: a conversion dated a day out is credited to the
   * wrong campaign, and a date derived by subtracting 24 hours is a day out at every weekly boundary.
   */
  const tradingDate = await tradingDateAt(configured, nowIso)
  if (tradingDate === null) {
    throw new AppError(
      'invariant_violated',
      `The trading calendar holds no day covering ${nowIso}, so there is no trading date whose offline ` +
        'conversions this pass could upload. A date derived by subtracting a day instead would be a day ' +
        'out at every boundary, and a conversion a day out is credited to the wrong campaign.',
      { details: { nowIso } },
    )
  }
  const result = await runOfflineConversionPass(configured, {
    tradingDate,
    nowIso,
    destinations: DISPATCH_DESTINATIONS,
    /*
     * The shipped resolver, which answers "nothing on file" for every conversion. The pass still RUNS, so
     * the log line below carries the count — ADR 0002's rule applied to a pass: "no conversions were
     * uploaded" has to read as *the attribution is missing* rather than as *there were none*. Throwing
     * instead would burn the retry budget and mark the shared agent unhealthy for the half of the
     * pipeline that is working.
     */
    resolveSession: NO_ATTRIBUTION_ON_FILE,
  })
  console.log(
    `${OFFLINE_CONVERSIONS_JOB} ${nowIso} for ${tradingDate}: ${describeOfflineConversionPass(result)}`,
  )
}

/**
 * The pass's definition.
 *
 * Nightly at 03:17, after trading closes at 02:00, so a trading date is COMPLETE before its conversions
 * are uploaded. A pass over a day still in progress would upload the morning's treatments and then have
 * nothing to say about the evening's, and a conversion is not a figure that can be topped up — it is a new
 * statement with its own id, so an incomplete day would be uploaded as a correction to itself.
 *
 * It shares `analytics_dispatch`' agent rather than declaring a second one, and the LIMIT of that is worth
 * stating rather than defending. The two passes are one pipeline — this one produces the rows that one
 * drains — so a watchdog asking "did the analytics dispatch pipeline run" gets a true answer. But the
 * consumer writes a heartbeat every five minutes, so this pass failing for a week is invisible to a
 * per-agent watchdog: the half that is working reports health for the half that is not. A second agent
 * needs an `agent_definition` and an `agent_heartbeat` row in a migration (0031's convention, restated by
 * 0110 and 0122), and this unit was allocated no migration number. Handed to A-MEAS-06, whose subject is
 * the heartbeat, the watchdog and the dead letter for exactly this dispatcher, by a NOTE on the manifest.
 */
export const OFFLINE_CONVERSIONS_JOB_DEFINITION: JobDefinition<never> = {
  name: OFFLINE_CONVERSIONS_JOB,
  purpose:
    "Uploads a trading date's offline conversions: a walk-in or phone booking never had a browser, so " +
    'the till is what knows it happened and knows it hours later. Each conversion becomes an ordered ' +
    'ledger of STATEMENTS — the document gross, a no-show void that sums the conversion to zero, a credit ' +
    'note as a negative, a package valued at redemption — each with its own event_id and the instant of ' +
    'the actual visit. It does NOT re-decide consent (ADR 0076/0091) and does not choose an analytics ' +
    'session: A-FIRST-08 owns the attribution, so until then every conversion is counted as having none ' +
    'and the count is in the log line (A-MEAS-05, ADR 0092).',
  cron: '17 3 * * *',
  agent: OFFLINE_CONVERSIONS_AGENT,
  retryLimit: 2,
  retryDelaySeconds: 300,
  retryBackoff: true,
  expireInSeconds: 600,
  handler: offlineConversionsHandler,
}

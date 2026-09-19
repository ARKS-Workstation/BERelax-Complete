import {
  createRunBudget,
  gscCalendarDate,
  inspectionBudget,
  instantFromIso,
  URL_INSPECTION_DAILY_CAP,
} from '@berelax/core'
import {
  claimUrlInspectionBatch,
  type InspectionCoverage,
  inspectionCoverage,
  openInspectionRun,
  recordInspectionOutcomes,
  type Sql,
  withAgentRun,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import {
  type InspectionCollection,
  inspectClaimedUrls,
  type UrlInspectionDeps,
} from './url-inspection.ts'

/**
 * The URL Inspection rotation, as an agent run.
 *
 * docs/10 §7 states the constraint and the answer in one line: URL Inspection is **2,000/day per site and
 * effectively unraisable — inspect a rotating priority subset, not everything daily.** With 5,000
 * candidates that is three days to cover the site once, so the only question that matters is whether the
 * rotation actually rotates. Two things make it do so, and neither is in this file:
 *
 *   - the **persisted cursor** (`last_inspected_at`, ordered NULLS FIRST by `claimUrlInspectionBatch`), so
 *     every candidate is covered before any is covered twice. A subset chosen by a shuffle or by a hash of
 *     the date would re-inspect some URLs on day two while others waited a fortnight, and nothing would
 *     say so;
 *   - the **day ledger** (`seo_url_inspection_run`), so a retry takes the remainder of the cap rather than
 *     a second full one.
 *
 * What this file does is pair them with the cap arithmetic in `@berelax/core` — `packages/db` may not
 * import `packages/core`, so the budget is computed here and handed to the claim, and the database still
 * refuses a claim that would breach the cap. That refusal is what makes the pairing checkable instead of
 * trusted.
 *
 * A separate agent from the nightly snapshot, for the reason migration 0042 records: the rotation can be
 * refused all night by an exhausted quota while the snapshot is perfectly healthy, and a shared heartbeat
 * would report the pair as fine because one of them ran.
 *
 * Here rather than in `apps/worker` for the reason `nightly-pass.ts` records: it pairs `withAgentRun` from
 * `@berelax/db` with the cap arithmetic from `@berelax/core`, and only a test inside this package may seal
 * a Google token — so this is the only place the whole rotation can be driven end to end.
 */

/** The `agent_definition` row this pass reports to. Seeded by migration 0042. */
export const SEO_URL_INSPECTION_AGENT = 'seo_url_inspection'

export interface RotationPassResult {
  readonly collection?: InspectionCollection
  /** The URLs claimed, in claim order: never-inspected first, then least recently inspected. */
  readonly claimed: readonly string[]
  /** Of those, the ones never inspected before this run. The coverage progress of the current cycle. */
  readonly newlyCovered: readonly string[]
  readonly recorded: number
  readonly spentBefore: number
  readonly dailyCap: number
  readonly coverage: InspectionCoverage
  readonly capReached: boolean
}

export interface RotationPassOptions {
  readonly jobId?: string
  /** Lowered only by a test, so the cap can be reached without 2,000 calls. */
  readonly dailyCap?: number
}

/**
 * Runs one rotation pass for one property.
 *
 * The property is resolved by `withGoogle` from the `gsc` capability, exactly as the snapshot resolves it,
 * so this pass never names a site itself. That is the whole reason the chokepoint takes a capability rather
 * than a connection (docs/10 §2): the account verified on the Search Console property is frequently not the
 * one that owns the Business Profile listing, and a consumer that chose would be where that guess lives.
 *
 * The order is: read the day's spend, compute the budget, claim that many URLs, inspect them, record what
 * came back. Claiming BEFORE inspecting is deliberate and is the same argument the column comment in 0042
 * makes — Google charges the quota for the request, so a pass that marked a URL only after a successful
 * answer would re-request every failure at full price.
 */
export async function runUrlInspectionRotation(
  sql: Sql,
  deps: UrlInspectionDeps,
  atIso: string,
  options: RotationPassOptions = {},
): Promise<RotationPassResult> {
  const runDate = gscCalendarDate(instantFromIso(atIso))
  const dailyCap = options.dailyCap ?? URL_INSPECTION_DAILY_CAP
  let result: RotationPassResult = {
    claimed: [],
    newlyCovered: [],
    recorded: 0,
    spentBefore: 0,
    dailyCap,
    coverage: { candidates: 0, everInspected: 0, neverInspected: 0 },
    capReached: false,
  }

  const run = await withAgentRun(
    sql,
    {
      agentKey: SEO_URL_INSPECTION_AGENT,
      startedAtIso: atIso,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    },
    async () => {
      // Which property, without guessing, and without a parameter a caller could get wrong: one empty
      // inspection call through the chokepoint resolves the connection, the resource and the degraded mode
      // exactly as every other consumer does. An EMPTY batch makes no call to Google at all, so it costs
      // nothing against the 2,000 — and it means the degraded branch below is reached by the same code path
      // as a real pass rather than by a second, less-travelled one.
      const probe = await inspectClaimedUrls(deps, [])
      if (probe.kind === 'degraded') {
        result = { ...result, collection: probe }
        return
      }
      const siteUrl = probe.siteUrl

      const ledger = await openInspectionRun(sql, { siteUrl, runDate, dailyCap })
      const coverageBefore = await inspectionCoverage(sql, siteUrl)
      const budget = inspectionBudget({
        spentToday: ledger.spentToday,
        dailyCap: ledger.dailyCap,
        // The whole candidate set, not only the uncovered part. A run that stopped at the end of a
        // coverage cycle would leave the day's remaining quota unspent for ever: the cap does not carry
        // over, so the honest use of a remainder is to start the next cycle with it — and because the claim
        // orders NULLS FIRST, every uncovered URL is still taken before any re-inspection.
        candidates: coverageBefore.candidates,
      })
      const claimed = await claimUrlInspectionBatch(sql, {
        siteUrl,
        runDate,
        nowIso: atIso,
        take: budget.take,
      })

      const collection = await inspectClaimedUrls(
        deps,
        claimed.map((row) => row.url),
      )
      if (collection.kind === 'degraded') {
        // The claim has already marked these URLs, and that is correct: Google was reached, or it was not,
        // through the same chokepoint that decides what a failure means. Re-opening the cursor here would
        // be the beginning of a loop that spends the cap on the same URLs.
        result = {
          ...result,
          collection,
          claimed: claimed.map((row) => row.url),
          spentBefore: ledger.spentToday,
          dailyCap: ledger.dailyCap,
          coverage: await inspectionCoverage(sql, siteUrl),
          capReached: budget.capReached,
        }
        return
      }

      const recorded = await recordInspectionOutcomes(sql, {
        siteUrl,
        outcomes: collection.outcomes,
      })
      result = {
        collection,
        claimed: claimed.map((row) => row.url),
        newlyCovered: claimed
          .filter((row) => row.previouslyInspectedAtIso === null)
          .map((row) => row.url),
        recorded,
        spentBefore: ledger.spentToday,
        dailyCap: ledger.dailyCap,
        coverage: await inspectionCoverage(sql, siteUrl),
        capReached: budget.capReached,
      }
    },
    createRunBudget,
  )

  if (run.outcome === 'failed' || run.outcome === 'budget_exceeded') {
    throw new AppError(
      'provider_unavailable',
      `The URL Inspection rotation failed: ${run.error ?? 'no error recorded'}`,
      { details: { reason: 'seo_url_inspection_failed', runId: run.runId } },
    )
  }
  return result
}

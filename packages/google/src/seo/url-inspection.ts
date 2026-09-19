import type { InspectionOutcome } from '@berelax/db'
// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { SearchConsoleProvider } from '@berelax/providers/google'
import { parseGscResourceRef } from '../capability-resolver.ts'
import type { DegradedMode } from '../consumers.ts'
import type { DegradationCause, WithGoogleDeps } from '../with-google.ts'
import { withGoogle } from '../with-google.ts'

/**
 * URL Inspection for a claimed batch: the I/O half of the rotation.
 *
 * The rotation's *choice* — which URLs, and how many the day's quota still allows — is deliberately not
 * here. It is a claim against persisted state (`claimUrlInspectionBatch`) plus the cap arithmetic
 * (`inspectionBudget` in `@berelax/core`), and `rotation-pass.ts` pairs the two. This function takes the
 * URLs it was given and asks Google about each, which is all the API offers: **one URL per call, no batch
 * form**, and that single fact is why the 2,000-a-day cap shapes the whole feature (docs/10 §7).
 *
 * ## Why a failed inspection is a result rather than a throw
 *
 * A URL Inspection call can fail for a reason that has nothing to do with the rest of the batch — and with
 * up to 2,000 calls in a pass, something eventually will. Aborting the batch on the first failure would
 * discard the outcomes already collected while Google has already charged the quota for every call made,
 * so the day's remaining budget would be spent on work whose answers were thrown away. Each failure is
 * therefore counted and named, the batch continues, and the caller decides what to do with a pass in which
 * every call failed.
 *
 * The one exception is a failure that ends the batch by definition: an exhausted quota. Every subsequent
 * call that day is refused, so continuing would spend 1,999 pointless requests to learn the same thing.
 */

export interface UrlInspectionDeps {
  readonly google: WithGoogleDeps
  readonly searchConsole: Pick<SearchConsoleProvider, 'inspectUrl'>
}

export interface InspectionRunOutcome {
  readonly kind: 'inspected'
  readonly siteUrl: string
  readonly outcomes: readonly InspectionOutcome[]
  /** URLs whose inspection failed, with the reason. Counted, never silently dropped. */
  readonly failures: readonly { readonly url: string; readonly reason: string }[]
  /** True when Google refused on quota and the batch stopped early rather than burning the remainder. */
  readonly quotaExhausted: boolean
  readonly correlationId: string
  readonly connectionId: string
}

export interface InspectionDegraded {
  readonly kind: 'degraded'
  readonly mode: DegradedMode
  readonly cause: DegradationCause
  readonly correlationId: string
  readonly connectionId: string | null
}

export type InspectionCollection = InspectionRunOutcome | InspectionDegraded

/** True for the one failure that makes every further call in the same day pointless. */
function isQuotaRefusal(error: unknown): boolean {
  const details = (error as { details?: { failureMode?: string } }).details
  const code = (error as { code?: string }).code
  return details?.failureMode === 'quota_exhausted' || code === 'quota_exhausted'
}

export async function inspectClaimedUrls(
  deps: UrlInspectionDeps,
  urls: readonly string[],
): Promise<InspectionCollection> {
  const outcome = await withGoogle(deps.google, 'gsc', async (context) => {
    const { siteUrl } = parseGscResourceRef(context.resourceRef)
    const outcomes: InspectionOutcome[] = []
    const failures: { url: string; reason: string }[] = []
    let quotaExhausted = false

    for (const url of urls) {
      try {
        const result = await deps.searchConsole.inspectUrl({ siteUrl, inspectionUrl: url })
        outcomes.push({
          url,
          verdict: result.verdict,
          coverageState: result.coverageState,
          // Null rather than "now" for a URL Google has never crawled. That is the empty case docs/10 §7
          // says to handle rather than render as a zero, and a timestamp invented here would read as a
          // crawl that happened.
          lastCrawledAtIso: result.lastCrawledAtIso ?? null,
        })
      } catch (error) {
        if (isQuotaRefusal(error)) {
          quotaExhausted = true
          break
        }
        failures.push({
          url,
          // The classified reason or the error's own name — never the upstream message, which an upstream
          // library may have assembled from the request (docs/10 §4 on the six places a token must not
          // reach; a failure list is written to a log line).
          reason:
            (error as { details?: { reason?: string } }).details?.reason ??
            (error as { code?: string }).code ??
            'unknown',
        })
      }
    }
    return { siteUrl, outcomes, failures, quotaExhausted }
  })

  if (outcome.kind === 'degraded') {
    return {
      kind: 'degraded',
      mode: outcome.mode,
      cause: outcome.cause,
      correlationId: outcome.correlationId,
      connectionId: outcome.connectionId,
    }
  }
  return {
    kind: 'inspected',
    correlationId: outcome.correlationId,
    connectionId: outcome.connectionId,
    ...outcome.value,
  }
}

/**
 * The publish loop, closed: one job run, five artefacts.
 *
 * W-SITE-08's M4 criterion names them and says *"four out of five is a failure"*: publishing a service in
 * admin produces, within one job run, **the route live with correct JSON-LD, an updated sitemap lastmod,
 * an IndexNow ping containing exactly the changed URLs, a CDN purge for those paths, and an audit_event.**
 *
 * Two of the five need nothing from this job. The route is live and its JSON-LD correct because the pages
 * are rendered from the rows (`graph-input.ts`), and the sitemap's `lastmod` is `updated_at` on those same
 * rows — so a publish moves both by writing the row, which is the whole point of deriving them rather than
 * baking them. What this job does is the other three, plus the revalidation that makes the first two
 * visible before a cache expires.
 *
 * ## Why a rejected ping does NOT fail the publish
 *
 * A ping is a notification and a purge is an optimisation; a publish is a decision somebody made. Rolling
 * back a publication because Bing was unreachable would be a worse failure than a page re-crawled a day
 * late, and it would be the kind of failure an operator cannot act on. So each outbound call's outcome is
 * recorded — in `publish_propagation` and, when it is a rejection, as `last_error` on the agent row where
 * docs/09 §5's console shows it — and the run reports `succeeded`.
 *
 * It is **not** silent, which is the other half of the criterion. The three places a rejection appears
 * are the propagation row, the heartbeat's `last_error`, and the audit row's `after` state; a run that
 * sent nothing because the IndexNow key is a marker (`Y1-indexnow-key`) is recorded as `refused_no_key`
 * rather than as a success with an empty outbox.
 *
 * ## Why the URL set is derived here and the cache tags are declared
 *
 * The URLs are the paths the change touches, from `revalidationPathsFor` / `contentRevalidationPathsFor`
 * — the same functions the revalidate endpoints use, so the set that is pinged is the set that was
 * revalidated. The TAGS come from docs/09 §5's declared map (`INTERCONNECTION_MAP`), because the
 * criterion is *"exactly its declared tags and no others"* and a derived set cannot be held to a
 * declaration.
 *
 * `apps/worker` may not import `apps/web` (`nothing-imports-an-app`), so both arrive as arguments. That
 * is the right shape in any case: the caller is the publish endpoint, which already knows what it
 * published.
 */
import {
  type Actor,
  AuditWriter,
  type PropagationOutcome,
  type PropagationRecord,
  type PropagationSurface,
  recordPropagation,
  type Sql,
} from '@berelax/db'
import { createFakePurge, type PurgePort, purgeIdempotencyKey } from '@berelax/media/purge'
import { type IndexNowProvider, indexNowIdempotencyKey } from '@berelax/providers/seo'
import type { JobContext, JobDefinition } from '../job.ts'

/** What the caller publishes, and what it already knows about the change. */
export interface PropagateInput {
  readonly surface: PropagationSurface
  /** The row that changed, or null for a surface with no single row behind it (a theme change). */
  readonly subjectId: string | null
  /** The site origin, so the paths become the absolute URLs IndexNow requires. */
  readonly origin: string
  /** The paths the change touches, from the revalidation modules. Deduplicated and sorted here. */
  readonly paths: readonly string[]
  /** The tags docs/09 §5's map declares for this change. Recorded, never derived. */
  readonly cacheTags: readonly string[]
  /** Why, for the purge outbox and the audit row. */
  readonly reason: string
}

export interface PropagateDeps {
  readonly sql: Sql
  /**
   * `revalidatePath` from `next/cache`, or a recorder in a test.
   *
   * Injected for `src/revalidate/catalogue.ts`'s reason: `next/cache` only works inside a request or a
   * server action, so a worker cannot call it directly — and the decision about WHICH paths is the part
   * worth testing without a server.
   */
  readonly revalidate: (path: string) => void
  /**
   * The IndexNow provider, or null when there is no key.
   *
   * Null rather than a no-op provider, and the distinction is the acceptance criterion's: a no-op would
   * report success and the pipeline would claim pings it never made. Null is recorded as
   * `refused_no_key` with the open question in the error, which is a visibly unanswered state.
   */
  readonly indexNow: IndexNowProvider | null
  readonly purge: PurgePort
  /** Who to attribute the audit row to. Never a name nobody signed in with. */
  readonly actor: Actor
}

export interface PropagateReport {
  readonly record: PropagationRecord
  /** Every path revalidated, in the order they were. */
  readonly revalidated: readonly string[]
  /** The absolute URLs submitted, sorted — exactly what the ping carried. */
  readonly changedUrls: readonly string[]
  /** True when an earlier run already covered this URL set and nothing was sent again. */
  readonly deduplicated: boolean
}

/** The five artefacts, named, so a test asserts by name rather than by count. */
export const PUBLISH_ARTEFACTS = [
  'route-live',
  'sitemap-lastmod',
  'indexnow-ping',
  'cdn-purge',
  'audit-event',
] as const
export type PublishArtefact = (typeof PUBLISH_ARTEFACTS)[number]

/** The agent this job reports to (migration 0158). */
export const PUBLISH_PROPAGATE_AGENT = 'publish_propagate'

/** The queue name, for the registry. A publish enqueues it; there is no cron. */
export const PUBLISH_PROPAGATE_JOB = 'publish.propagate'

/**
 * One propagation run.
 *
 * The order is load-bearing and is the reverse of the obvious one. **Revalidate first, then ping.** A
 * crawler that arrives in the second between the ping and the revalidation is served the cached page the
 * ping said had changed — which teaches it that this site's pings are noise, and IndexNow's documented
 * remedy for a site that does that is to stop honouring them.
 */
export async function propagatePublish(
  input: PropagateInput,
  deps: PropagateDeps,
): Promise<PropagateReport> {
  const paths = [...new Set(input.paths)].sort()
  const changedUrls = paths.map((path) => `${input.origin}${path}`)
  const key = indexNowIdempotencyKey(changedUrls)

  for (const path of paths) deps.revalidate(path)

  let indexnowOutcome: PropagationOutcome = 'not_attempted'
  let indexnowError: string | null = null
  if (deps.indexNow === null) {
    indexnowOutcome = 'refused_no_key'
    indexnowError =
      'seo.indexnow_key holds a marker rather than a key (Y1-indexnow-key), so no submission was made. ' +
      'A key is published by this site at /<key>.txt and verified by the search engine fetching it, so ' +
      'there is nothing to fall back to.'
  } else {
    const host = new URL(input.origin).host
    const outcome = await deps.indexNow.submit({ host, urls: changedUrls, idempotencyKey: key })
    if (outcome.kind === 'rejected') {
      indexnowOutcome = 'rejected'
      indexnowError = `${outcome.reason}: ${outcome.detail}`
    } else {
      indexnowOutcome = outcome.deduplicated ? 'deduplicated' : 'accepted'
    }
  }

  const purged = await deps.purge.purge({
    paths,
    reason: input.reason,
    idempotencyKey: purgeIdempotencyKey(paths),
  })
  const purgeOutcome: PropagationOutcome =
    purged.kind === 'rejected' ? 'rejected' : purged.deduplicated ? 'deduplicated' : 'accepted'
  const purgeError = purged.kind === 'rejected' ? purged.detail : null

  const record = await recordPropagation(deps.sql, {
    surface: input.surface,
    subjectId: input.subjectId,
    idempotencyKey: key,
    changedUrls,
    indexnowOutcome,
    indexnowError,
    purgeOutcome,
    purgeError,
    cacheTags: input.cacheTags,
  })

  await new AuditWriter(deps.sql, deps.actor).record({
    action: 'publication.propagate',
    entityType: 'publish_propagation',
    entityId: record.id,
    operation: 'create',
    after: {
      surface: input.surface,
      subjectId: input.subjectId,
      urlCount: changedUrls.length,
      indexnowOutcome,
      purgeOutcome,
      cacheTags: [...input.cacheTags],
      alreadyRecorded: record.alreadyRecorded,
    },
  })

  await writeHeartbeat(deps.sql, indexnowError ?? purgeError)

  return { record, revalidated: paths, changedUrls, deduplicated: record.alreadyRecorded }
}

/**
 * The heartbeat, written on every run including a refused one.
 *
 * Written here rather than by the job wrapper, because what has to reach `last_error` is the OUTBOUND
 * call's rejection — and the run itself succeeded, so a wrapper that recorded only thrown errors would
 * leave the console showing a healthy agent beside a site nothing is re-crawling. `consecutive_failures`
 * is not incremented: the run did not fail, and inflating it would make the alert ladder page somebody
 * for a missing IndexNow key.
 */
async function writeHeartbeat(sql: Sql, error: string | null): Promise<void> {
  await sql`
    update agent_heartbeat
       set last_run_at = now(),
           last_success_at = now(),
           last_outcome = ${error === null ? 'succeeded' : 'succeeded_with_rejection'},
           last_error = ${error},
           next_run_at = now() + make_interval(secs => (
             select expected_interval_seconds from agent_definition
              where agent_key = ${PUBLISH_PROPAGATE_AGENT}
           )),
           updated_at = now()
     where agent_key = ${PUBLISH_PROPAGATE_AGENT}
  `
}

/** The purge port a run uses when the caller supplies none. There is no CDN; see the port's header. */
export function defaultPurge(now: () => string): PurgePort {
  return createFakePurge({ now })
}

/**
 * The payload a publish enqueues.
 *
 * Paths and tags rather than "the thing that changed", and the reason is the boundary: `apps/worker` may
 * not import `apps/web` (`nothing-imports-an-app`), and the paths a change touches are decided by
 * `src/revalidate/catalogue.ts` and its siblings, which live there. So the caller — the publish endpoint,
 * which already knows what it published — computes them and hands them over. The alternative was a copy of
 * the path rules in this package, which is the second answer to "what does this change invalidate".
 */
export interface PublishPropagateData {
  readonly surface: PropagationSurface
  readonly subjectId: string | null
  readonly origin: string
  readonly paths: readonly string[]
  readonly cacheTags: readonly string[]
  readonly reason: string
}

/**
 * The dependencies a RUN needs, supplied once by `run.ts` rather than carried in the payload.
 *
 * A port cannot be serialised into a pg-boss payload, and a job that constructed its own would be a job
 * that decides which provider it talks to — ADR 0022 puts that decision in configuration. `setPropagation
 * Deps` is the same arrangement `setMediaStorage` uses for the derivative job, and for the same reason:
 * the handler fails loudly when it was never called rather than silently doing nothing.
 */
let runtime: Omit<PropagateDeps, 'actor'> | undefined

export function setPropagationDeps(deps: Omit<PropagateDeps, 'actor'>): void {
  runtime = deps
}

async function propagateHandler(data: PublishPropagateData, context: JobContext): Promise<void> {
  if (runtime === undefined) {
    throw new Error(
      'publish.propagate ran before setPropagationDeps() supplied a connection, a revalidator and the ' +
        'two ports. run.ts calls it before startWorkers(); a handler that invented them would be a job ' +
        'deciding which provider it talks to, which ADR 0022 puts in configuration.',
    )
  }
  const report = await propagatePublish(data, {
    ...runtime,
    actor: { kind: 'system', label: 'publish propagation' },
  })
  console.log(
    `publish.propagate ${data.surface} ${data.subjectId ?? '-'}: ${report.changedUrls.length} URL(s), ` +
      `indexnow ${report.record.indexnowOutcome}, purge ${report.record.purgeOutcome}` +
      `${report.deduplicated ? ' (already recorded)' : ''} at ${context.now()}`,
  )
}

/**
 * The queue definition. No cron: a publish ANNOUNCES the work.
 *
 * `assertRegistry` demands an `agent_definition` only for a job with a cron, because what G-AGT-01 watches
 * is a schedule nobody is looking at. This job declares one anyway — `agent: PUBLISH_PROPAGATE_AGENT`,
 * whose row 0158 brings with it — and the reason is the opposite of a schedule: what has to be visible
 * here is not whether the job ran but whether the two OUTBOUND CALLS were accepted, and
 * `agent_heartbeat.last_error` is the one place docs/09 §5's console reads that from. A job with no agent
 * would mean a rejected ping had nowhere to surface.
 */
export const PUBLISH_PROPAGATE_JOB_DEFINITION: JobDefinition<PublishPropagateData> = {
  name: PUBLISH_PROPAGATE_JOB,
  purpose:
    'Runs once per publish: revalidates the paths the change touches, pings IndexNow with exactly the ' +
    'changed URLs, purges those paths at the CDN and writes an audit row, recording all of it in ' +
    'publish_propagation. Announced by a publish, so it has no schedule. A rejection from either ' +
    'outbound call is recorded and does not fail the run: a ping is a notification, not a precondition.',
  agent: PUBLISH_PROPAGATE_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // Two outbound calls and three statements. A minute is generous; a run still going past it is blocked
  // on a provider that is not answering, and reclaiming it is right — the idempotency key makes the retry
  // send nothing twice.
  expireInSeconds: 60,
  handler: propagateHandler,
}

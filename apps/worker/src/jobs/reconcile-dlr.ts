/**
 * B-MSG-04 — the delivery-receipt pass: drain what the vendors reported, and move the rows.
 *
 * ## Why it is a drain and not a webhook handler
 *
 * SMSala and Resend both report delivery by webhook, and a webhook handler is two jobs in one costume:
 * parsing one vendor's HTTP body, and deciding what a status *means*. Keeping them apart is what makes
 * the meaning testable — every assertion in `reconcile-dlr.test.ts` runs without inventing a request —
 * and it is what makes a vendor change a change to a mapping. So a `ReceiptSource` yields receipts that
 * are already in our vocabulary, and this pass decides nothing about vendors at all.
 *
 * With the fakes, the source is the transport's own queue: a fake accepts a send and queues the receipt
 * it will report, so the whole path is walkable with no vendor and no HTTP. With the real vendors the
 * source becomes the stored webhook rows, and this file does not change.
 *
 * ## Why the sources are injected and not constructed here
 *
 * A fake's receipt queue lives in the instance that accepted the send. A handler that built a fresh
 * transport per invocation would drain a queue nothing had ever sent to and report a tidy zero — the
 * shape of a stub that looks like it worked, which docs/12 §1 forbids. So `setReceiptSources` hands this
 * job the same transports the sends went through, exactly as `setMediaStorage` hands the derivative
 * build its bucket, and for the same stated reason: `JOB_REGISTRY` is a module constant that `pnpm jobs`
 * enumerates without a database, so a handler's dependencies cannot be constructor arguments.
 *
 * ## Why there is no cron
 *
 * A receipt is announced: in production by the vendor's POST, which enqueues this. A cron here would be
 * a poller looking for work an enqueue already announced, and `assertRegistry` demands an
 * `agent_definition` for a cron precisely because a schedule with nobody watching it is the failure
 * G-AGT-01 exists to remove. The caller is the request that accepted the webhook, and the caller is what
 * is watched.
 */
import type {
  MessageLifecycleStore,
  MessageVendor,
  ReceiptApplication,
  ReceiptSource,
} from '@berelax/messaging'
import { AppError, type ReceiptIgnoredReason } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

export interface ReconcileDeps {
  readonly store: MessageLifecycleStore
  /** One per vendor. A vendor with no source is not drained, and the result says which ones were. */
  readonly sources: readonly ReceiptSource[]
}

/** What one pass did. Counted per outcome, because the ignored ones are the interesting ones. */
export interface ReconcileResult {
  readonly vendors: readonly MessageVendor[]
  readonly drained: number
  readonly applied: number
  /** Receipts recorded and not applied, by reason. An empty object is a healthy pass. */
  readonly ignored: Readonly<Partial<Record<ReceiptIgnoredReason, number>>>
  /** Duplicate webhook bodies. Expected, and not an error: both vendors retry a delivery they missed. */
  readonly replayed: number
  /**
   * Receipts for a provider id this system never issued.
   *
   * Counted rather than thrown. One is a vendor's test console; a rising count means the vendor and this
   * system disagree about what was sent, which is a thing to look at rather than a thing to crash on.
   */
  readonly unknown: number
  /** The statuses the applied receipts produced, so a caller can log what actually moved. */
  readonly applications: readonly ReceiptApplication[]
}

export async function reconcileDeliveryReceipts(deps: ReconcileDeps): Promise<ReconcileResult> {
  if (deps.sources.length === 0) {
    // Refusing rather than reporting a pass over nothing: "0 receipts drained" from a run with no
    // source configured is indistinguishable from a quiet night, and that is how a broken DLR path
    // stays broken for a month (ADR 0002's failure mode, one layer up).
    throw new AppError(
      'invariant_violated',
      'reconcileDeliveryReceipts was given no receipt source. A pass over no sources would report ' +
        'zero receipts, which reads exactly like a quiet night.',
    )
  }

  const ignored: Partial<Record<ReceiptIgnoredReason, number>> = {}
  const applications: ReceiptApplication[] = []
  let drained = 0
  let applied = 0
  let replayed = 0
  let unknown = 0

  for (const source of deps.sources) {
    for (const receipt of await source.drain()) {
      drained += 1
      // Sequentially, not with Promise.all: two receipts for one message inside one pass are exactly
      // the out-of-order case, and the ordering guarantee the row lock gives is easier to reason about
      // than the interleaving a parallel map produces.
      const application = await deps.store.applyReceipt(receipt)
      applications.push(application)
      if (application.kind === 'applied') applied += 1
      else if (application.kind === 'replayed') replayed += 1
      else if (application.kind === 'unknown_message') unknown += 1
      else ignored[application.reason] = (ignored[application.reason] ?? 0) + 1
    }
  }

  return {
    vendors: deps.sources.map((source) => source.vendor),
    drained,
    applied,
    ignored,
    replayed,
    unknown,
    applications,
  }
}

/**
 * The sources and the store, supplied at boot.
 *
 * Module-level bindings for the reason `setMediaStorage` and `setMaintenanceSql` are: the registry has
 * to stay a module constant that a static gate can enumerate.
 */
let configured: ReconcileDeps | undefined

export function setReceiptSources(deps: ReconcileDeps): void {
  configured = deps
}

async function handler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      'messaging.reconcile-dlr ran before setReceiptSources() supplied the transports and the store. ' +
        'run.ts calls it before startWorkers().',
    )
  }
  const result = await reconcileDeliveryReceipts(configured)
  const ignoredSummary = Object.entries(result.ignored)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(' ')
  // Logged even at zero, with the vendors named: the evidence is the line, and "nothing to do" from a
  // pass that drained no source is the outcome this job refuses to produce silently.
  console.log(
    `messaging.reconcile-dlr ${context.now()}: ${result.drained} receipt(s) from ` +
      `${result.vendors.join(', ')} — ${result.applied} applied, ${result.replayed} replayed, ` +
      `${result.unknown} for unknown messages${ignoredSummary === '' ? '' : `, ignored: ${ignoredSummary}`}`,
  )
}

export const RECONCILE_DLR_JOB: JobDefinition<never> = {
  name: 'messaging.reconcile-dlr',
  purpose:
    'Applies the delivery receipts SMSala and Resend have reported to the message rows they belong ' +
    'to: out of order, duplicated and unrecognised ones included, each recorded with what it did. ' +
    'Announced by the vendor webhook that accepted them, so it has no schedule.',
  retryLimit: 3,
  retryDelaySeconds: 30,
  retryBackoff: true,
  // A drain is a handful of small transactions. Two minutes is generous; a pass still running past it
  // is blocked on a row lock, and reclaiming it is the right answer — the pass is idempotent, because
  // a receipt already recorded conflicts on the replay guard rather than applying twice.
  expireInSeconds: 120,
  handler,
}

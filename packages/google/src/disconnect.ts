import type { Kek } from '@berelax/clinical'
import type { Clock } from '@berelax/core'
import { AppError } from '@berelax/shared'
import type { ConnectionEventInput, GoogleDisconnectStore } from './connection-store.ts'
import { revokeStoredGrant, type TokenLifecycleDeps } from './lifecycle.ts'
import {
  type DisconnectStatusReason,
  type RevokeVerdict,
  revokeDetail,
  statusReasonFor,
  zeroisationIsSafe,
} from './oauth/revoke.ts'

/**
 * Disconnect: revoke at Google, then erase — and never the other way round.
 *
 * ## The order, and why it is not a preference
 *
 * docs/10 §5 states the first offboarding step in one clause: *"disconnect in admin (revokes at Google
 * and zeroises the stored token)"*. Both halves can fail independently, and the two orderings fail
 * asymmetrically:
 *
 *   - **Zeroise, then the revocation fails.** The grant is still live at Google and the only credential
 *     that could kill it has been destroyed. There is no recovery *from this system*: a new consent mints
 *     a different grant, and the old one keeps full authority over the business's Google presence — the
 *     `business.manage` scope has no read-only variant, so the token that reads reviews also rewrites the
 *     address and the opening hours (docs/10 §3). The only remedy left is a human signing in to
 *     `myaccount.google.com/permissions`, which is precisely the state an offboarding is supposed to make
 *     unnecessary.
 *   - **Revoke, then the zeroisation fails.** A dead token sits encrypted at rest. Still a secret we said
 *     we had deleted, and still the lesser evil by a wide margin: the plaintext is worthless, the whole
 *     operation is safely repeatable (Google answers a second revoke with `invalid_token`, which reads as
 *     *already dead*), and running the disconnect again finishes the job.
 *
 * So the revocation goes first and the erasure is **conditional on a confirmed verdict**. That condition
 * is `zeroisationIsSafe` in `oauth/revoke.ts` — one function, no I/O — and it is backed by a constraint
 * rather than by this comment: migration 0040's `google_connections_revoke_retry_keeps_its_token` refuses
 * a row parked in `revoke_failed` whose ciphertext has been erased. The unrecoverable half-failure is not
 * merely avoided in code; it is unrepresentable in the database.
 *
 * ## Why an unconfirmed revocation still marks the row disconnected
 *
 * Because the operator asked. Leaving the row `active` because Google's revocation endpoint returned a 500
 * would keep every consumer resolving a connection somebody has just offboarded, and the failure would
 * present as *"we disconnected it and it kept replying to reviews"*. So the status moves, the consumers
 * degrade (`resolveTarget` skips a disconnected connection), and the retained ciphertext is the retry's
 * credential — with `status_reason = 'revoke_failed'` naming exactly that state for anyone reading the row.
 *
 * ## What is inside the transaction, and what is deliberately outside it
 *
 * The HTTPS call is outside. Inside it, a revocation that hung would hold a pooled connection and a row
 * lock for its duration, and a revocation that *threw* would roll back the disconnect it had just achieved
 * — which is the defect G-CONN-06 fixed one module over, where `accessTokenUnderLock` let a refresh
 * failure propagate out of `sql.begin` and the rollback destroyed the very rows recording a dead grant.
 *
 * The status, the erased columns and the events go in together, as one `store.disconnect` call. Those
 * events are not merely evidence here: they are the **only** record that a credential existed and was
 * destroyed, because the credential itself is gone. A zeroised row with no `disconnected` event beside it
 * is a connection that stopped working with nothing anywhere to say why, for ever.
 *
 * And the retry announcement is outside and *after* the commit, wrapped so it cannot throw through. A
 * failed enqueue must not roll back a completed disconnect and must not be reported to the caller as a
 * failed disconnect — the row already says `revoke_failed`, which is the durable record the connection
 * panel renders and the retry sweep reads.
 *
 * ## Why it does not go through `withGoogle`
 *
 * `withGoogle` resolves a connection *from a capability* and refuses anything that is not `active`, so it
 * would refuse exactly the connections a disconnect exists to handle: one whose grant already looks dead,
 * and one parked in `revoke_failed` by a previous attempt. It would also classify anything thrown inside
 * its body through the Google taxonomy and write a `health_check_failed` row — reporting a broken
 * capability for a connection being taken out of service on purpose (G-CONN-05's laundering note). The
 * token is opened in `lifecycle.ts`, which is already one of the five modules allowed to hold a plaintext
 * token, so the chokepoint allow-list did not have to grow for this unit.
 */

/**
 * Who asked for the disconnect.
 *
 * Required, not optional, and not defaulted to `system`. An offboarding is the one operation that destroys
 * a credential, and *"a system disconnected it"* is not an answer to the question an audit asks. `label`
 * is a role or an account address — never an invented person's name (the brief's rule 10).
 */
export interface DisconnectActor {
  readonly kind: 'staff' | 'system' | 'agent'
  readonly label: string
}

/**
 * What the retry announcement did.
 *
 * `failed` is a real outcome rather than a thrown error, because it happens *after* the disconnect has
 * committed: the operation succeeded and only the promptness of the retry was lost. The sweep over
 * `pendingRevocations` is what makes that survivable.
 *
 * `not_wired` is distinct from `failed` on purpose. It is what the sweep itself passes down — a retry that
 * enqueued another retry per failed row would fan out — and conflating the two would make a deliberate
 * wiring read as an error in every log line the sweep writes.
 */
export type RetryAnnouncement = 'queued' | 'not_needed' | 'not_wired' | 'failed'

export type DisconnectOutcomeKind =
  /** We revoked it, now. */
  | 'revoked'
  /** Google did not recognise the token: somebody or something had already revoked it. */
  | 'already_dead'
  /** Google did not answer for the revocation. The ciphertext is retained for the retry. */
  | 'revoke_failed'
  /** Already disconnected and already zeroised. No second revocation, no second event. */
  | 'already_disconnected'

export interface DisconnectOutcome {
  readonly kind: DisconnectOutcomeKind
  readonly connectionId: string
  readonly statusReason: DisconnectStatusReason | null
  /** True when the five refresh-token columns are now NULL. False is the retained-credential path. */
  readonly zeroised: boolean
  /** Null only for `already_disconnected`, where nothing was asked of Google. */
  readonly verdict: RevokeVerdict | null
  readonly retryAnnouncement: RetryAnnouncement
}

export interface DisconnectDeps {
  readonly store: GoogleDisconnectStore
  readonly oauth: TokenLifecycleDeps['oauth']
  readonly kek: Kek
  readonly clock: Clock
  /**
   * Announces the retry for an unconfirmed revocation.
   *
   * Optional, and its absence is a legitimate wiring rather than an oversight: the retry job itself calls
   * this function, and a retry that enqueued another retry on every failed attempt would fan out. When it
   * is absent, or when it throws, the durable record is still the row — `status_reason = 'revoke_failed'`
   * — which `pendingRevocations` sweeps and the connection panel shows.
   *
   * It takes a connection id and **nothing else**. A pg-boss payload is a row, and rows reach query logs,
   * `pg_stat_statements`, backups and the job table itself, so docs/10 §4 names a job payload as one of
   * the six places a token must never appear.
   */
  readonly enqueueRevokeRetry?: (connectionId: string) => Promise<void>
}

/** The event detail every disconnect carries, whatever the verdict. A closed set of values. */
function baseDetail(actor: DisconnectActor): Readonly<Record<string, unknown>> {
  return { source: 'disconnect', actor: actor.label }
}

/**
 * Revokes the grant at Google and then erases the stored credential, or says why it did not.
 *
 * Idempotent on a completed disconnect, and that matters more than it looks: the retry job, an operator
 * clicking twice, and a re-run after a half-failure all land here. A second call on an already-zeroised
 * row makes no request to Google and appends no event, because a second `disconnected` event would make
 * the append-only log say the connection was disconnected twice.
 */
export async function disconnectGoogleConnection(
  deps: DisconnectDeps,
  args: { readonly connectionId: string; readonly actor: DisconnectActor },
): Promise<DisconnectOutcome> {
  const connection = await deps.store.load(args.connectionId)
  if (connection === null) {
    throw new AppError('not_found', `No Google connection with id ${args.connectionId}`)
  }

  if (connection.refreshToken === null) {
    // Nothing to revoke and nothing to erase. `google_connections_live_grant_has_a_refresh_token` means
    // this can only be a terminal row, so the work is already done — and doing it again would append a
    // second `disconnected` event to an append-only log, which is the one correction it cannot take back.
    return {
      kind: 'already_disconnected',
      connectionId: connection.id,
      statusReason: null,
      zeroised: true,
      verdict: null,
      retryAnnouncement: 'not_needed',
    }
  }

  // STEP 1 — the revocation, outside every transaction. `revokeStoredGrant` returns a verdict rather than
  // throwing, so the branch below is a decision over a value instead of a `catch` somebody later widens.
  const verdict = await revokeStoredGrant(deps, connection)
  const zeroise = zeroisationIsSafe(verdict)
  const statusReason = statusReasonFor(verdict)

  // STEP 2 — one indivisible write: the status, the erased columns and the record of both.
  const events: ConnectionEventInput[] = []
  if (verdict.kind === 'revoked') {
    // Only when we actually revoked it. `already_dead` means somebody else got there first, and claiming
    // `revoked` for that would put our name on an act we did not perform — which is the thing an
    // offboarding audit is trying to establish.
    events.push({
      connectionId: connection.id,
      googleSub: connection.googleSub,
      event: 'revoked',
      actorKind: args.actor.kind,
      actorLabel: args.actor.label,
      detail: { ...baseDetail(args.actor), ...revokeDetail(verdict) },
    })
  }
  events.push({
    connectionId: connection.id,
    googleSub: connection.googleSub,
    event: 'disconnected',
    actorKind: args.actor.kind,
    actorLabel: args.actor.label,
    detail: {
      ...baseDetail(args.actor),
      ...revokeDetail(verdict),
      statusReason,
      // Stated in the row, not inferred from the presence of a ciphertext later. Whether the credential
      // was erased is the fact an operator needs, and reading it back off the token columns would answer
      // "is it gone now" rather than "did this disconnect erase it".
      zeroised: zeroise,
    },
  })

  await deps.store.disconnect({
    connectionId: connection.id,
    statusReason,
    zeroise,
    at: deps.clock.now(),
    events,
  })

  // STEP 3 — after the commit, and unable to undo it.
  const retryAnnouncement = zeroise ? 'not_needed' : await announceRetry(deps, connection.id)

  return {
    kind: zeroise ? (verdict.kind === 'revoked' ? 'revoked' : 'already_dead') : 'revoke_failed',
    connectionId: connection.id,
    statusReason,
    zeroised: zeroise,
    verdict,
    retryAnnouncement,
  }
}

/**
 * Announces the retry, swallowing its failure **on purpose**.
 *
 * The disconnect is committed by the time this runs. A throw here would be reported to the caller as a
 * failed disconnect — an operator told the offboarding did not happen, about a connection that is already
 * disconnected — and, in a caller that wrapped the whole operation in a transaction, would roll the
 * committed rows back. The rows are the only record that a credential was destroyed, so nothing may be
 * allowed to take them with it.
 *
 * What is lost when this fails is promptness, not the retry: `pendingRevocations` sweeps every row still
 * carrying `revoke_failed`, and the runbook's step 1 names the manual revocation as the operator's
 * backstop for a grant that stays unconfirmed.
 */
async function announceRetry(
  deps: DisconnectDeps,
  connectionId: string,
): Promise<RetryAnnouncement> {
  if (deps.enqueueRevokeRetry === undefined) return 'not_wired'
  try {
    await deps.enqueueRevokeRetry(connectionId)
    return 'queued'
  } catch {
    return 'failed'
  }
}

export interface RevokeRetryReport {
  readonly attempted: number
  readonly revoked: number
  readonly stillUnconfirmed: number
  /** Connection ids still carrying `revoke_failed` after the pass, so a caller can say which. */
  readonly unconfirmed: readonly string[]
}

/**
 * Finishes every disconnect whose revocation Google never confirmed.
 *
 * A **sweep**, not a single-row retry, and that is what makes the mechanism durable. The queue is not the
 * source of truth here — the row is: `status_reason = 'revoke_failed'` with a retained ciphertext is
 * itself the work item, guaranteed to be a coherent pair by
 * `google_connections_revoke_retry_keeps_its_token`. So a lost enqueue, an exhausted job or a worker that
 * died mid-retry all cost time and none of them loses the work, and a pass that finds nothing is the
 * healthy case rather than a job that failed to be scheduled.
 *
 * `disconnectGoogleConnection` is reused rather than reimplemented: the retry is the same operation, and a
 * second copy of "revoke, and only then erase" is a second place for the order to be got wrong. Note the
 * deliberate absence of `enqueueRevokeRetry` in the deps it passes down — a retry that enqueued another
 * retry per failed row would fan out, and the sweep's own next run is the retry.
 */
export async function retryPendingRevocations(
  deps: DisconnectDeps,
  actor: DisconnectActor,
): Promise<RevokeRetryReport> {
  const pending = await deps.store.pendingRevocations()
  const unconfirmed: string[] = []
  let revoked = 0
  for (const connection of pending) {
    const outcome = await disconnectGoogleConnection(
      { store: deps.store, oauth: deps.oauth, kek: deps.kek, clock: deps.clock },
      { connectionId: connection.id, actor },
    )
    if (outcome.zeroised) revoked += 1
    else unconfirmed.push(connection.id)
  }
  return {
    attempted: pending.length,
    revoked,
    stillUnconfirmed: unconfirmed.length,
    unconfirmed,
  }
}

import type { Kek } from '@berelax/clinical'
import {
  type Clock,
  capabilityHealthAtConsent,
  GOOGLE_CAPABILITIES,
  type GoogleCapability,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type {
  GoogleCapabilityRecord,
  GoogleConnectionRecord,
  GoogleConsentStore,
} from '../connection-store.ts'
import { createPostgresConnectionStore } from '../postgres-store.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import type { PendingConsent } from './consent.ts'
import {
  type ConsentCallback,
  type ConsentGrant,
  consentCodeReplayed,
  type ExchangeDeps,
  exchangeConsentCode,
} from './exchange.ts'

/**
 * What a completed consent does to the database, and the one question that decides it: **the sub.**
 *
 * `google_sub` is the identity key (migration 0016, UNIQUE). A consent that comes back with a sub we
 * already hold is the same Google account re-authorising, and it must land on the same row — because
 * that row's capabilities carry the `placeId` the owner confirmed, and a new row would send the next
 * review reply to a listing nobody selected. A consent that comes back with a **different** sub is a
 * different Google account, and the only safe thing to do is add a row and say so loudly.
 *
 * The temptation is to treat the second case as "the owner reconnected, update the connection". docs/10
 * §5 is the reason not to: starting on a personal Gmail and migrating to a business account is the
 * *expected* path, so a second sub arriving is ordinary, and during the migration BOTH accounts are
 * legitimate — one owns the listing, the other is verified on the Search Console property. Overwriting
 * either one silently loses an access nobody can get back without Google's promotion waiting period.
 *
 * Everything here is one transaction. The `google_capabilities` write and the token write are the
 * atomic pair docs/10 §4 names: *"Scope change on re-consent — replace the stored token atomically in
 * the same transaction as the capability update."* A token replaced without its capabilities means the
 * system believes it has an access the new grant did not include.
 */

export type ConsentOutcomeKind =
  /** No connection for this sub, and none for any other. The first connection. */
  | 'connected'
  /** Same sub as an existing connection. Updated in place; capabilities and history preserved. */
  | 'reconnected'
  /** A different Google account. A second row, and a warning. */
  | 'additional_account'

/**
 * The warning a second Google account produces.
 *
 * It names both email addresses because that is the only thing the owner can act on: they recognise
 * "you connected `x@gmail.com`, but this business is set up under `google-admin@berelax.ae`" and they
 * recognise nothing at all about two 21-digit subs. The subs are here too, for the support case where
 * the addresses are the same and only the account is different — a renamed Google account looks exactly
 * like this.
 */
export interface GoogleAccountMismatch {
  readonly reason: 'google_account_differs'
  readonly existingConnectionId: string
  readonly existingEmail: string
  readonly existingSub: string
  readonly newConnectionId: string
  readonly newEmail: string
  readonly newSub: string
  /** Ready to render. Names both addresses, in English, with no scope strings. */
  readonly message: string
}

export interface ConsentOutcome {
  readonly kind: ConsentOutcomeKind
  readonly connectionId: string
  readonly googleSub: string
  readonly googleEmail: string
  readonly grantedScopes: readonly string[]
  readonly capabilities: readonly GoogleCapabilityRecord[]
  /** Scopes the previous grant had that this one does not. Empty on a first connection. */
  readonly removedScopes: readonly string[]
  readonly warning: GoogleAccountMismatch | null
}

export interface ApplyConsentDeps {
  readonly kek: Kek
  readonly clock: Clock
}

function mismatchWarning(args: {
  readonly existing: GoogleConnectionRecord
  readonly newConnectionId: string
  readonly identity: { readonly googleSub: string; readonly googleEmail: string }
}): GoogleAccountMismatch {
  return {
    reason: 'google_account_differs',
    existingConnectionId: args.existing.id,
    existingEmail: args.existing.googleEmail,
    existingSub: args.existing.googleSub,
    newConnectionId: args.newConnectionId,
    newEmail: args.identity.googleEmail,
    newSub: args.identity.googleSub,
    message:
      `You signed in as ${args.identity.googleEmail}, which is a different Google account from ` +
      `${args.existing.googleEmail}. Both are now connected and nothing was removed — but the ` +
      'listing and website data each account can reach may differ, so check which one this business ' +
      'is meant to use before disconnecting either.',
  }
}

/**
 * Applies a grant to the store. Must be called inside a transaction — see `completeGoogleConsent`.
 *
 * The replay check is here rather than only in the caller because here is inside the transaction: a
 * check performed before `begin` can be overtaken by a concurrent exchange of the same code, and two
 * connections from one code is exactly the state that makes "which account is this" unanswerable. It is
 * the same double-checked shape G-CONN-04 applies to the refresh race, for the same reason.
 */
export async function applyConsent(
  store: GoogleConsentStore,
  deps: ApplyConsentDeps,
  grant: ConsentGrant,
  options: { readonly reconnectingConnectionId?: string | null } = {},
): Promise<ConsentOutcome> {
  if (await store.authorizationCodeSeen(grant.authorizationCodeFingerprint)) {
    throw consentCodeReplayed()
  }

  const { identity, grantedScopes } = grant
  const consentAt = deps.clock.now()
  const existing = await store.loadBySub(identity.googleSub)

  if (existing !== null) {
    // The same Google account. One row, updated in place: the id, the capability rows and every event
    // ever recorded against it survive, which is what makes "preserves the location selection on
    // matching sub" (docs/10 §4) true rather than aspirational.
    const binding = connectionBinding({
      connectionId: existing.id,
      googleSub: existing.googleSub,
    })
    await store.recordConsent({
      connectionId: existing.id,
      googleEmail: identity.googleEmail,
      grantedScopes,
      refreshToken: sealToken(deps.kek, binding, grant.refreshToken),
      consentAt,
    })

    const before = await store.capabilitiesFor(existing.id)
    const capabilities = await reconcileCapabilities(store, existing.id, before, grantedScopes)
    const removedScopes = existing.grantedScopes.filter((s) => !grantedScopes.includes(s))

    await store.appendEvent({
      connectionId: existing.id,
      googleSub: existing.googleSub,
      event: 'reconnected',
      // The fingerprint is what makes a later replay recognisable; the scope COUNT rather than the
      // scopes, because the list is on the row this event points at and an append-only log is never
      // redacted.
      detail: {
        authorizationCodeFingerprint: grant.authorizationCodeFingerprint,
        grantedScopeCount: grantedScopes.length,
        removedScopeCount: removedScopes.length,
      },
    })
    if (removedScopes.length > 0 || existing.grantedScopes.length !== grantedScopes.length) {
      await store.appendEvent({
        connectionId: existing.id,
        googleSub: existing.googleSub,
        event: 'scopes_changed',
        detail: {
          removedScopeCount: removedScopes.length,
          grantedScopeCount: grantedScopes.length,
        },
      })
    }

    return {
      kind: 'reconnected',
      connectionId: existing.id,
      googleSub: existing.googleSub,
      googleEmail: identity.googleEmail,
      grantedScopes,
      capabilities,
      removedScopes,
      warning: null,
    }
  }

  // A sub nobody holds. Which of the two new-row cases this is depends on whether anything was here
  // before — and, when the owner clicked Reconnect on a specific connection, on that connection.
  const incumbent = await incumbentFor(store, options.reconnectingConnectionId ?? null)

  const id = await store.allocateId()
  const binding = connectionBinding({ connectionId: id, googleSub: identity.googleSub })
  await store.insert({
    id,
    googleSub: identity.googleSub,
    googleEmail: identity.googleEmail,
    grantedScopes,
    refreshToken: sealToken(deps.kek, binding, grant.refreshToken),
    consentAt,
  })

  const capabilities = await reconcileCapabilities(store, id, [], grantedScopes)

  await store.appendEvent({
    connectionId: id,
    googleSub: identity.googleSub,
    event: 'connected',
    detail: {
      authorizationCodeFingerprint: grant.authorizationCodeFingerprint,
      grantedScopeCount: grantedScopes.length,
      // Ids, not addresses: whoever investigates this can read both rows, and duplicating an email
      // into an append-only log buys nothing that a join does not already give.
      ...(incumbent === null
        ? {}
        : { accountDiffersFrom: incumbent.id, warning: 'google_account_differs' }),
    },
  })

  return {
    kind: incumbent === null ? 'connected' : 'additional_account',
    connectionId: id,
    googleSub: identity.googleSub,
    googleEmail: identity.googleEmail,
    grantedScopes,
    capabilities,
    removedScopes: [],
    warning:
      incumbent === null
        ? null
        : mismatchWarning({ existing: incumbent, newConnectionId: id, identity }),
  }
}

/**
 * The connection a new sub did not replace, if there is one.
 *
 * When the owner clicked *Reconnect* on a connection, that one — anything else would warn about a row
 * they were not looking at. Otherwise the oldest connection, which is deterministic because ids are
 * UUIDv7 and therefore time-ordered.
 */
async function incumbentFor(
  store: GoogleConsentStore,
  reconnectingConnectionId: string | null,
): Promise<GoogleConnectionRecord | null> {
  const all = await store.listAll()
  if (reconnectingConnectionId !== null) {
    return all.find((connection) => connection.id === reconnectingConnectionId) ?? null
  }
  return all[0] ?? null
}

/**
 * Brings capability rows into line with what Google granted, without touching their resources.
 *
 * Existing rows are updated, never replaced. `resource_ref` holds the `placeId` and the `siteUrl` the
 * owner confirmed, and a consent knows nothing about either — deleting and re-inserting would lose the
 * selection on every re-auth, which is the failure docs/10 §4 calls out by name. A capability with no
 * row at all gets one, so a grant that adds a product is visible without waiting for a health check.
 */
async function reconcileCapabilities(
  store: GoogleConsentStore,
  connectionId: string,
  existing: readonly GoogleCapabilityRecord[],
  grantedScopes: readonly string[],
): Promise<readonly GoogleCapabilityRecord[]> {
  for (const row of existing) {
    await store.updateCapabilityHealth({
      connectionId,
      capability: row.capability,
      resourceRef: row.resourceRef,
      health: capabilityHealthAtConsent({
        capability: row.capability,
        grantedScopes,
        existingHealth: row.health,
      }),
    })
  }

  const covered = new Set<GoogleCapability>(existing.map((row) => row.capability))
  for (const capability of GOOGLE_CAPABILITIES) {
    if (covered.has(capability)) continue
    await store.upsertCapability({
      connectionId,
      capability,
      // No resource yet. Which listing and which Search Console property is a separate choice the owner
      // makes against Google's own lists, and inventing one here would be a guess stored as a fact.
      resourceRef: null,
      health: capabilityHealthAtConsent({ capability, grantedScopes, existingHealth: null }),
      // The row a consumer gets when it asks for the capability without naming a resource. There is
      // exactly one per capability at this point, so it is unambiguously the primary.
      isPrimary: true,
    })
  }

  return store.capabilitiesFor(connectionId)
}

export interface CompleteConsentDeps extends ExchangeDeps {
  readonly sql: Sql
  /**
   * The sealing key, resolved lazily — **after** the callback has been validated.
   *
   * A thunk rather than a `Kek`, because obtaining the key can fail: it comes from a secret store, or
   * from an environment variable that is not set. Resolving it while building the dependencies made a
   * forged callback report *"the key is missing"* instead of *"the state does not match"*, which is both
   * the wrong answer for whoever is debugging and a detail about the deployment that a prober should not
   * be handed. Nothing before the exchange needs a key, so nothing before the exchange asks for one.
   */
  readonly kek: () => Kek
  /**
   * How the transactional store is built. Injected for exactly one reason.
   *
   * The atomicity claim in this unit is that a fault between the token write and the capability write
   * rolls back both. Proving it requires the fault to occur **inside the transaction this function
   * opens** — a failure injected around it would roll back nothing and the test would pass while
   * demonstrating the opposite. A factory is the only seam that reaches inside `sql.begin` without the
   * production path carrying a test hook.
   */
  readonly consentStoreFor?: (tx: Sql) => GoogleConsentStore
}

/**
 * The whole callback: validate, exchange, then write once inside one transaction.
 *
 * The exchange happens **outside** the transaction on purpose. It is a network call to Google that can
 * take seconds or hang; holding a transaction open across it would pin a connection from a pool sized
 * for PgBouncer and, on the pathological path, hold row locks while waiting on a third party.
 */
export async function completeGoogleConsent(
  deps: CompleteConsentDeps,
  pending: PendingConsent,
  callback: ConsentCallback,
  options: { readonly redirectUri?: string } = {},
): Promise<ConsentOutcome> {
  const grant = await exchangeConsentCode(
    { oauth: deps.oauth, clock: deps.clock },
    pending,
    callback,
    options,
  )
  const storeFor = deps.consentStoreFor ?? ((tx: Sql) => createPostgresConnectionStore(tx))
  const kek = deps.kek()

  // Not `withUnitOfWork`: the audit row is written by 0016's mirror trigger on the event insert, in this
  // same transaction. A second AuditWriter row would double-count the one thing that happened.
  const outcome = await deps.sql.begin(async (tx) =>
    applyConsent(storeFor(tx as unknown as Sql), { kek, clock: deps.clock }, grant, {
      reconnectingConnectionId: pending.reconnectingConnectionId,
    }),
  )
  if (outcome === undefined) {
    throw new AppError('invariant_violated', 'The consent transaction returned no outcome.')
  }
  return outcome as ConsentOutcome
}

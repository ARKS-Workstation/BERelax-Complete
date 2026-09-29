import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The rows behind a gateway payment intent: claim a key, record a movement, move the header.
 *
 * **Rows only.** The lifecycle table, the amount fold and the projection from events to transaction rows are
 * all `packages/core/src/payments/` — `packages/db` must never import `packages/core` (brief rule 4) — so
 * every function here takes figures that have already been computed and returns rows. `packages/payments/src/intent.ts`
 * is where the two halves meet, for the reason `packages/hr/src/payroll-run.ts` gives, and
 * `packages/fixtures/src/payment-intent.itest.ts` is where the pair is asserted against a real PostgreSQL.
 *
 * ## The one ordering decision in this module
 *
 * {@link claimPaymentIntent} INSERTs the row, and therefore claims the idempotency key, **before** anything
 * calls the gateway. That order is the acceptance line — *"a repeated idempotency key returns the original
 * intent and the adapter records zero additional calls"* — and the alternative fails in a way that is worth
 * stating because it looks harmless: call the gateway first and deduplicate on its answer, and the adapter's
 * own idempotency (`answered` in the fake, a real acquirer's `Idempotency-Key` header) does return the first
 * snapshot, so nothing visibly breaks. What breaks is the call log. A replay reaches the adapter, the adapter
 * records a suppressed-duplicate movement, and the payments screen shows two rows for one authorisation — so
 * the assertion *zero additional calls* is unprovable and the operator-visible record of what we asked the
 * gateway to do stops being a record of what we asked it to do.
 *
 * `on conflict do nothing` plus a read is how the claim is made, rather than a SELECT followed by an INSERT:
 * the double tap lands in the gap between those two, and `payment_intent_one_intent_per_key` is what closes
 * it. {@link claimPaymentIntent} therefore reports WHICH of the two happened, because the caller's next step
 * differs completely.
 *
 * ## What the database refuses without help from here
 *
 *   1. **A transaction row is append-only** — ZY161, every UPDATE and DELETE, for every role.
 *   2. **An intent moves only with a NEW transaction row of its own** — ZY162, which is ADR 0056 and the
 *      reason {@link applyPaymentIntentMovement} is the only UPDATE in this module that touches the state or
 *      the figures.
 *   3. **The header equals its rows at COMMIT** — ZY163. Nothing here recomputes it defensively, because a
 *      caller that passed a wrong figure must fail rather than be corrected: a silently-fixed figure is a
 *      caller whose arithmetic is wrong and nobody knows.
 *   4. **One row per gateway event** — ZY164, so a redelivery is a named refusal a webhook handler can
 *      answer 200 to rather than a bare unique violation it cannot tell from anything else.
 *   5. **The instrument is one a gateway serves** — ZY165.
 */

/** The SQLSTATEs `0106_payment_intent.sql` raises. Subclass range ZY161-ZY165 of the shared 'ZY' class. */
export const PAYMENT_INTENT_SQLSTATE = {
  /** A `payment_intent_transaction` row was UPDATEd or DELETEd. */
  transactionAppendOnly: 'ZY161',
  /** An intent's state or a figure changed without advancing to a new transaction row of its own. */
  movedWithoutATransaction: 'ZY162',
  /** The intent's three figures disagree with the sum of its rows, at COMMIT. */
  headerDisagreesWithTransactions: 'ZY163',
  /** A second row for one (intent, gateway event id) — a redelivery. */
  eventAlreadyRecorded: 'ZY164',
  /** The instrument's `tender_type.adapter` is not `gateway`. */
  instrumentIsNotAGatewayKind: 'ZY165',
} as const

export type PaymentIntentRule = keyof typeof PAYMENT_INTENT_SQLSTATE

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * A payment-intent refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message and never on the class: the class no
 * longer identifies a file (ADR 0043), so `startsWith('ZY')` would claim seven other units' refusals as this
 * one's — which is exactly the failure the registry was built to end.
 *
 * `eventAlreadyRecorded` is `conflict` rather than `invariant_violated` because it is the ONE refusal here
 * that a correct caller meets on a correct day: a webhook stream is at-least-once, and a redelivery is not a
 * defect. Y-PAY-04's handler answers 200 to it.
 */
export function paymentIntentError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = (Object.entries(PAYMENT_INTENT_SQLSTATE) as [PaymentIntentRule, string][]).find(
    ([, code]) => code === state,
  )
  if (known === undefined) return null
  const [rule] = known
  return new AppError(
    rule === 'eventAlreadyRecorded' ? 'conflict' : 'invariant_violated',
    error instanceof Error ? error.message : `Payment intent rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

/** Is this error the named payment-intent refusal? For a caller that branches on one rule. */
export function isPaymentIntentRule(error: unknown, rule: PaymentIntentRule): boolean {
  return sqlStateOf(error) === PAYMENT_INTENT_SQLSTATE[rule]
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** One intent, as stored. Figures are numbers because they are fils and fils are integers (ADR 0007). */
export interface PaymentIntentRow {
  readonly id: string
  readonly idempotencyKey: string
  readonly gateway: string
  readonly gatewayIntentId: string | null
  readonly state: string
  readonly instrument: string
  readonly postingAccountCode: string
  readonly requestedFils: number
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
  readonly reference: string
  readonly lastTransactionId: string | null
}

/** One append-only movement, as stored. */
export interface PaymentIntentTransactionRow {
  readonly id: string
  readonly paymentIntentId: string
  readonly gatewayEventId: string
  readonly gatewayEventType: string
  readonly amountFils: number
  readonly occurredAt: Date
  readonly idempotencyKey: string
}

/**
 * The columns every read of an intent selects, aliased to the row shape.
 *
 * One fragment rather than the list repeated in four functions: `noPropertyAccessFromIndexSignature` makes a
 * renamed column a type error only where the alias is written, so four copies of the list are four places for
 * one of them to stop matching {@link PaymentIntentRow} (brief rule 28).
 */
const intentColumns = (sql: Sql) => sql`
  id, idempotency_key as "idempotencyKey", gateway, gateway_intent_id as "gatewayIntentId",
  state, instrument, posting_account_code as "postingAccountCode",
  requested_fils::int as "requestedFils", authorised_fils::int as "authorisedFils",
  captured_fils::int as "capturedFils", refunded_fils::int as "refundedFils",
  reference, last_transaction_id as "lastTransactionId"
`

/** What a caller asks for when it claims a key. Every figure integer fils. */
export interface PaymentIntentClaim {
  readonly idempotencyKey: string
  readonly gateway: string
  readonly instrument: string
  readonly postingAccountCode: string
  readonly requestedFils: number
  readonly reference: string
}

/**
 * The answer to a claim: the intent, and whether this caller is the one that created it.
 *
 * `claimed: false` means the key was already held, so the caller must NOT call the gateway — it already
 * happened, or it is happening in another transaction. The flag exists because the two cases look identical
 * from the row and the caller's next step is opposite, and because the acceptance assertion is about the
 * adapter NOT being reached: a caller that could not tell would have to ask the gateway to find out.
 */
export interface PaymentIntentClaimResult {
  readonly intent: PaymentIntentRow
  readonly claimed: boolean
}

/**
 * Claims an idempotency key, or reports that it was already held.
 *
 * `on conflict (idempotency_key) do nothing` and then a read, rather than a read and then an insert: two
 * concurrent callers both pass a SELECT and both INSERT, and the double tap lands in that gap.
 * `payment_intent_one_intent_per_key` is what actually closes it, exactly as 0063's
 * `checkout_finalisation` closes the same race on a checkout.
 *
 * Deliberately NOT a comparison of the claim against the stored row. `checkout_finalisation` carries a
 * `request_fingerprint` because replaying a checkout key with a different basket is a caller bug that must
 * not be answered with the first invoice — and the same argument does NOT apply here, because the port's own
 * `IdempotencyKeyReusedAcrossIntents` already refuses a key offered for a second intent at the adapter, and
 * a second answer to that here would be a second place for the rule to be written differently. What this
 * returns for a held key is the intent the key answered for, which is what the acceptance line asks for.
 */
export async function claimPaymentIntent(
  sql: Sql,
  claim: PaymentIntentClaim,
): Promise<PaymentIntentClaimResult> {
  const inserted = await sql<{ id: string }[]>`
    insert into payment_intent (
      idempotency_key, gateway, instrument, posting_account_code, requested_fils, reference
    ) values (
      ${claim.idempotencyKey}, ${claim.gateway}, ${claim.instrument}, ${claim.postingAccountCode},
      ${claim.requestedFils}, ${claim.reference}
    )
    on conflict (idempotency_key) do nothing
    returning id
  `
  const intent = await readPaymentIntentByKey(sql, claim.idempotencyKey)
  if (intent === null) {
    // Unreachable through the unique constraint: the INSERT either wrote the row or a row was already
    // there. Raised rather than returned so that a future schema change which made the key non-unique
    // fails loudly here instead of returning a claim nobody holds.
    throw new AppError(
      'invariant_violated',
      `claimPaymentIntent: the key ${JSON.stringify(claim.idempotencyKey)} was neither inserted nor ` +
        'found. That combination is impossible while payment_intent_one_intent_per_key exists, so the ' +
        'constraint has been dropped or renamed.',
      { details: { idempotencyKey: claim.idempotencyKey } },
    )
  }
  return { intent, claimed: inserted.length === 1 }
}

export async function readPaymentIntentByKey(
  sql: Sql,
  idempotencyKey: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await sql<PaymentIntentRow[]>`
    select ${intentColumns(sql)} from payment_intent where idempotency_key = ${idempotencyKey}
  `
  return row ?? null
}

export async function readPaymentIntent(
  sql: Sql,
  id: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await sql<PaymentIntentRow[]>`
    select ${intentColumns(sql)} from payment_intent where id = ${id}::uuid
  `
  return row ?? null
}

/** Every movement against an intent, in the gateway's own order. What the figures are derived from. */
export async function readPaymentIntentTransactions(
  sql: Sql,
  paymentIntentId: string,
): Promise<readonly PaymentIntentTransactionRow[]> {
  return await sql<PaymentIntentTransactionRow[]>`
    select id, payment_intent_id as "paymentIntentId", gateway_event_id as "gatewayEventId",
           gateway_event_type as "gatewayEventType", amount_fils::int as "amountFils",
           occurred_at as "occurredAt", idempotency_key as "idempotencyKey"
      from payment_intent_transaction
     where payment_intent_id = ${paymentIntentId}::uuid
     order by occurred_at, gateway_event_id
  `
}

/**
 * The figures an intent's rows add up to, computed in SQL.
 *
 * A SECOND derivation of the same answer as `sumIntentTransactions` in `@berelax/core`, and the duplication
 * is the point: the acceptance line is *"the intent's derived balance equals the sum of its append-only
 * transaction rows"*, which is a claim about two derivations agreeing, and one of them has to be over the
 * stored rows. It is the same arithmetic ZY163 uses — MAX over `authorised`, SUM over the other two — and
 * `payment-intent.itest.ts` holds it equal to the pure fold with a control that must fail.
 *
 * Counted in SQL rather than by reading rows and adding them up in JavaScript, for
 * `settings-store.itest.ts`'s reason: a reader with a limit makes both sides of a subtraction pin at the
 * limit, and three recorded changes read as zero.
 */
export interface DerivedIntentFigures {
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
  readonly rowCount: number
}

export async function deriveFiguresFromTransactions(
  sql: Sql,
  paymentIntentId: string,
): Promise<DerivedIntentFigures> {
  const [row] = await sql<DerivedIntentFigures[]>`
    select
      coalesce(max(case when gateway_event_type = 'authorised' then amount_fils end), 0)::int
        as "authorisedFils",
      coalesce(sum(case when gateway_event_type = 'captured' then amount_fils else 0 end), 0)::int
        as "capturedFils",
      coalesce(sum(case when gateway_event_type = 'refunded' then amount_fils else 0 end), 0)::int
        as "refundedFils",
      count(*)::int as "rowCount"
      from payment_intent_transaction
     where payment_intent_id = ${paymentIntentId}::uuid
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'an aggregate over one intent returned no row')
  }
  return row
}

/** One movement to record, with the figures the intent will then hold. */
export interface PaymentIntentMovement {
  readonly paymentIntentId: string
  readonly gatewayEventId: string
  readonly gatewayEventType: string
  readonly amountFils: number
  readonly occurredAt: Date
  readonly idempotencyKey: string
  /** The state the lifecycle table in `@berelax/core` says the intent is in after this event. */
  readonly state: string
  /** The figures the rows now add up to, computed by `storedFiguresOf` in `@berelax/core`. */
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
  /** The gateway's own id, set on the first movement that carries one. */
  readonly gatewayIntentId?: string
}

/**
 * Records one movement and moves the intent to match, in one round trip each.
 *
 * The two statements are in this order because the second names the first's row — ZY162 requires it — and
 * both must be in ONE transaction: the row without the header is an intent whose figures lie until the next
 * write, and the header without the row is refused. The caller supplies a `UnitOfWork`, so that is a given
 * rather than a hope.
 *
 * Nothing here checks the figures against the rows. ZY163 does, at COMMIT, and a defensive recomputation
 * here would mean a caller with wrong arithmetic silently got the right answer — which is the worst of the
 * three outcomes, because the arithmetic is `@berelax/core`'s and the whole point of the deferred check is
 * that the two derivations are independent.
 */
export async function applyPaymentIntentMovement(
  uow: UnitOfWork,
  movement: PaymentIntentMovement,
): Promise<PaymentIntentTransactionRow> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into payment_intent_transaction (
      payment_intent_id, gateway_event_id, gateway_event_type, amount_fils, occurred_at,
      idempotency_key
    ) values (
      ${movement.paymentIntentId}::uuid, ${movement.gatewayEventId}, ${movement.gatewayEventType},
      ${movement.amountFils}, ${movement.occurredAt}, ${movement.idempotencyKey}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'a movement insert returned no id')
  }

  await uow.sql`
    update payment_intent
       set state = ${movement.state},
           authorised_fils = ${movement.authorisedFils},
           captured_fils = ${movement.capturedFils},
           refunded_fils = ${movement.refundedFils},
           gateway_intent_id = coalesce(${movement.gatewayIntentId ?? null}, gateway_intent_id),
           last_transaction_id = ${row.id}::uuid
     where id = ${movement.paymentIntentId}::uuid
  `

  const stored = await readPaymentIntentTransactions(uow.sql, movement.paymentIntentId)
  const written = stored.find((candidate) => candidate.id === row.id)
  if (written === undefined) {
    throw new AppError('invariant_violated', 'the movement just written cannot be read back')
  }
  return written
}

/**
 * Records the gateway's id on an intent that has not moved yet.
 *
 * The one UPDATE that is not a movement, and it is separate for a reason ZY162 makes structural: a gateway
 * answering with its id is the same authorisation being recorded, not a second thing happening, so requiring
 * a transaction row for it would force a row to exist before the event that justifies it. It touches neither
 * the state nor a figure, so the trigger returns early.
 */
export async function recordGatewayIntentId(
  sql: Sql,
  paymentIntentId: string,
  gatewayIntentId: string,
): Promise<void> {
  await sql`
    update payment_intent set gateway_intent_id = ${gatewayIntentId}
     where id = ${paymentIntentId}::uuid
  `
}

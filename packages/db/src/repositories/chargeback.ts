import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The rows behind a card dispute: record an event, read the position.
 *
 * **Rows only.** The entries — which account a received dispute debits, what a won one reverses, what a
 * lost one writes off — are `packages/core/src/ledger/chargeback.ts`, and what remains refundable is
 * `packages/core/src/payments/refund.ts`, because `packages/db` must never import `packages/core` (brief
 * rule 4). `packages/fixtures/src/chargeback.itest.ts` is where the pair is asserted.
 *
 * ## There is no update path, and no write to `payment_intent` anywhere in this file
 *
 * Both absences are the module. `chargeback` is append-only (ZY431) because each row is a dated event
 * with a journal entry behind it; and a dispute is never applied by reducing `captured_fils`, because
 * that column is a projection of the append-only transaction rows (ZY163) and the capture HAPPENED.
 * Reducing it would leave the sale's own entry explaining money the header says was never taken, and
 * nothing in the database would say which of the two had been edited.
 *
 * ## The event and its entry go in ONE transaction, and the function takes a UnitOfWork to say so
 *
 * `chargeback.journal_entry_id` is a real key and `ZY436` compares the lines of two entries at COMMIT, so
 * a caller that posted the entry in one transaction and the row in another would get a refusal from the
 * second with the first already committed — an entry on `1045` with nothing saying what it was about.
 */

/** Every rule `0135_chargeback.sql` refuses by, as the code it raises. */
export const CHARGEBACK_SQLSTATE = {
  /** A `chargeback` row was UPDATEd or DELETEd. */
  eventIsAppendOnly: 'ZY431',
  /** The row's `trading_date` is not the business day containing `received_at`. */
  tradingDateDisagrees: 'ZY432',
  /** Refunded plus charged-back-net would exceed captured. */
  captureIsOverReversed: 'ZY433',
  /** A resolution with no received event before it, or a second resolution of one dispute. */
  sequenceIsWrong: 'ZY434',
  /** A dispute against an intent that captured nothing. */
  nothingWasCaptured: 'ZY435',
  /** A won dispute's entry does not reverse its received entry, or the pair does not net to zero. */
  wonDoesNotNetToZero: 'ZY436',
} as const

export type ChargebackRule = keyof typeof CHARGEBACK_SQLSTATE

/** `23505`: a second notice about one dispute with the same kind — a webhook redelivery. */
const UNIQUE_VIOLATION = '23505'

/** The constraint a redelivered notice trips, by name. The name is the contract. */
export const CHARGEBACK_CONSTRAINT = {
  oneRowPerDisputeEvent: 'chargeback_one_row_per_dispute_event',
} as const

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const carried = (error as { details?: { sqlState?: unknown } }).details?.sqlState
  return typeof carried === 'string' ? carried : null
}

const constraintOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const name = (error as { constraint_name?: unknown }).constraint_name
  return typeof name === 'string' ? name : null
}

/**
 * A chargeback refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message and never on the class: the class no
 * longer identifies a file (ADR 0043).
 *
 * `captureIsOverReversed` is `validation` — an operator asked to refund more than remains and will be
 * told the figure — and the rest are `invariant_violated`, because they are states a correct caller
 * cannot produce. `tradingDateDisagrees` is deliberately in the second group: a caller that resolved the
 * date with `resolveTradingDate` cannot get it wrong, so a disagreement means two derivations have
 * drifted rather than that somebody typed a date.
 */
export function chargebackError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = (Object.entries(CHARGEBACK_SQLSTATE) as [ChargebackRule, string][]).find(
    ([, code]) => code === state,
  )
  if (known === undefined) return null
  const [rule] = known
  const kind = rule === 'captureIsOverReversed' ? 'validation' : 'invariant_violated'
  return new AppError(
    kind,
    error instanceof Error ? error.message : `Chargeback rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

/** Is this error the named chargeback refusal? For a caller that branches on one rule. */
export function isChargebackRule(error: unknown, rule: ChargebackRule): boolean {
  return sqlStateOf(error) === CHARGEBACK_SQLSTATE[rule]
}

/**
 * Is this the same dispute notice arriving twice?
 *
 * The property Y-PAY-04's webhook handler needs: a redelivery is answered 200 with no second posting, and
 * a bare `23505` cannot be told apart from any other unique violation in the same statement — including
 * the intent's own idempotency key, which means something completely different.
 */
export function isChargebackRedelivery(error: unknown): boolean {
  return (
    sqlStateOf(error) === UNIQUE_VIOLATION &&
    constraintOf(error) === CHARGEBACK_CONSTRAINT.oneRowPerDisputeEvent
  )
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export interface ChargebackRow {
  readonly id: string
  readonly paymentIntentId: string
  readonly disputeRef: string
  readonly kind: string
  readonly amountFils: number
  readonly receivedAtMs: number
  readonly tradingDate: string
  readonly journalEntryId: string
}

export interface RecordChargebackInput {
  readonly paymentIntentId: string
  readonly disputeRef: string
  readonly kind: 'received' | 'won' | 'lost'
  readonly amountFils: number
  readonly receivedAtIso: string
  /**
   * The business day, resolved by the CALLER with `resolveTradingDate`.
   *
   * Passed in rather than computed here, which is the arrangement every money write in this build uses:
   * a trading date computed inside a write is a second opinion about which business day the event belongs
   * to, and 01:30 belongs to the previous one. `ZY432` then checks the caller's answer against
   * `business_day`, so the two derivations cannot drift silently.
   */
  readonly tradingDate: string
  /** The entry this event posts. Must already exist in the SAME transaction. */
  readonly journalEntryId: string
}

/**
 * Records one dispute event. Returns its id.
 *
 * Takes a `UnitOfWork` and not a bare `Sql`, because the entry, its lines and this row have to be one
 * transaction: `ZY436` compares two entries' lines at COMMIT, so a row committed without its entry is a
 * refusal that arrives after the damage.
 */
export async function recordChargebackEvent(
  uow: UnitOfWork,
  input: RecordChargebackInput,
): Promise<string> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into chargeback (
      payment_intent_id, dispute_ref, kind, amount_fils, received_at, trading_date, journal_entry_id
    ) values (
      ${input.paymentIntentId}::uuid, ${input.disputeRef}, ${input.kind}, ${input.amountFils},
      ${input.receivedAtIso}::timestamptz, ${input.tradingDate}::date, ${input.journalEntryId}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'recordChargebackEvent inserted no row and did not raise.',
    )
  }
  return row.id
}

/** Every event of one dispute, oldest first. */
export async function readDisputeEvents(
  sql: Sql,
  disputeRef: string,
): Promise<readonly ChargebackRow[]> {
  return await sql<ChargebackRow[]>`
    select id,
           payment_intent_id                              as "paymentIntentId",
           dispute_ref                                    as "disputeRef",
           kind,
           amount_fils::bigint                            as "amountFils",
           (extract(epoch from received_at) * 1000)::bigint as "receivedAtMs",
           trading_date::text                             as "tradingDate",
           journal_entry_id                               as "journalEntryId"
      from chargeback
     where dispute_ref = ${disputeRef}
     order by received_at, kind
  `
}

export interface RefundablePositionRow {
  readonly capturedFils: number
  readonly refundedFils: number
  readonly chargedBackFils: number
  readonly state: string
}

/**
 * The three figures `assertRefundable` needs, read as one row.
 *
 * One query and not three, because the three have to be consistent with each other: read separately, a
 * dispute landing between the second and the third produces a position that was never true, and the
 * refund it authorises would be exactly the one `ZY433` exists to refuse.
 *
 * The charged-back figure comes from the VIEW and is not a stored column (ADR 0057), and the `left join`
 * is what makes "never disputed" read as nought rather than as an absent row — which is the one place
 * this build does substitute a zero, and legitimately: the view's absence means there are no dispute
 * rows at all, which is a measured nothing rather than an unknown.
 */
export async function readRefundablePosition(
  sql: Sql,
  paymentIntentId: string,
): Promise<RefundablePositionRow | null> {
  const [row] = await sql<RefundablePositionRow[]>`
    select pi.captured_fils::bigint                      as "capturedFils",
           pi.refunded_fils::bigint                      as "refundedFils",
           coalesce(p.charged_back_net_fils, 0)::bigint  as "chargedBackFils",
           pi.state
      from payment_intent pi
      left join chargeback_position p on p.payment_intent_id = pi.id
     where pi.id = ${paymentIntentId}::uuid
  `
  return row ?? null
}

/**
 * How many UPDATE or DELETE privileges the application role holds on `journal_line`.
 *
 * Here rather than in a suite because the acceptance line is "with zero UPDATE or DELETE statements
 * against journal_line, asserted by the append-only rule test", and the strongest form of that claim is
 * about the GRANT rather than about the statements a particular suite happened to issue. A scan of the
 * source answers "nobody wrote one"; this answers "nobody could".
 */
export async function journalLineMutationGrants(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ privilege: string }[]>`
    select privilege_type as privilege
      from information_schema.table_privileges
     where table_schema = 'public'
       and table_name = 'journal_line'
       and grantee = 'berelax_app'
       and privilege_type in ('UPDATE', 'DELETE')
  `
  return rows.map((row) => row.privilege)
}

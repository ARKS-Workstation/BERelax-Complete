import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The rows behind an appointment's deposit: read the balance, append a movement.
 *
 * **Rows only.** The arithmetic — what a deposit settles, what a cancellation refunds, which targets are
 * refused — is `packages/core/src/payments/deposit.ts`, because `packages/db` must never import
 * `packages/core` (brief rule 4). So every function here takes a balance that has already been computed
 * and returns a row, and `packages/fixtures/src/deposit.itest.ts` is where the pair is asserted against a
 * real PostgreSQL.
 *
 * ## There is no update path, and that is the module
 *
 * `deposit_movement` is append-only (ZY301, every UPDATE and DELETE, for every role including the owner).
 * A balance that is wrong is corrected by a NEW movement, which is ADR 0017's rule for the journal applied
 * to the liability the journal explains — and it has to be, because each movement NAMES the journal entry
 * that moved it. Editing a movement would restate a balance the ledger has already accounted for; deleting
 * one would leave an entry with nothing it moved.
 *
 * ## Why the opening balance is passed in rather than read here
 *
 * {@link appendDepositMovement} takes `heldBeforeFils` from the caller. A read inside the write would be a
 * read followed by a write, and two concurrent movements both land in the gap: both read 5,000, both write
 * a row claiming to open at 5,000, and the liability is 5,000 when 10,000 was taken. What closes it is
 * `deposit_movement_one_row_per_position` — the unique `(appointment_id, seq)` — so the second INSERT
 * blocks on the index and is then refused by name, and `ZY304` additionally refuses a row whose opening
 * balance is not the previous row's closing balance. The caller therefore reads the balance, computes, and
 * is told to re-read if it lost the race. `booking_idempotency` (0024) and `checkout_finalisation` (0063)
 * are the same mechanism on their own subjects: a double tap blocks rather than races.
 */

/**
 * Every private SQLSTATE raised against `deposit_movement` and the entries that move its account.
 *
 * Grouped by TABLE and not by migration, which is `PAYMENT_INTENT_SQLSTATE`'s decision and ADR 0043's
 * subject: a caller branches on a RULE, and two homes for "the rules this table refuses by" is the
 * arrangement in which a caller checks one list and misses the other.
 */
export const DEPOSIT_SQLSTATE = {
  /** A `deposit_movement` row was UPDATEd or DELETEd. */
  movementAppendOnly: 'ZY301',
  /** The named entry does not move 2045 by exactly this movement, in its direction, on its day. */
  entryIsNotTheMovement: 'ZY302',
  /** A deposit receipt or refund recognised revenue or charged output VAT. */
  depositRecognisedRevenue: 'ZY303',
  /** A movement's opening balance is not the previous movement's closing balance. */
  chainIsBroken: 'ZY304',
  /** An applied movement names a document that does not bill its appointment. */
  appliedToAnotherAppointment: 'ZY305',
  /** An entry moved the deposit account against package or voucher deferred revenue. */
  wouldBecomeAPrepaidProduct: 'ZY306',
} as const

export type DepositRule = keyof typeof DEPOSIT_SQLSTATE

/** `23505`: two movements claimed one position in an appointment's sequence. */
const UNIQUE_VIOLATION = '23505'

/** The constraint a concurrent second movement trips, by name. The name is the contract. */
export const DEPOSIT_CONSTRAINT = {
  onePerPosition: 'deposit_movement_one_row_per_position',
  oneMovementPerEntry: 'deposit_movement_one_row_per_entry',
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
 * A deposit refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message and never on the class: the class no
 * longer identifies a file (ADR 0043), so `startsWith('ZY')` would claim eight other units' refusals as
 * this one's.
 *
 * `appliedToAnotherAppointment` and `wouldBecomeAPrepaidProduct` are `validation` and the other four are
 * `invariant_violated`, and the split is the honest one: the first two are things an operator asked for
 * and can ask differently, and the rest are states a correct caller cannot produce.
 */
export function depositError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = (Object.entries(DEPOSIT_SQLSTATE) as [DepositRule, string][]).find(
    ([, code]) => code === state,
  )
  if (known === undefined) return null
  const [rule] = known
  const kind =
    rule === 'appliedToAnotherAppointment' || rule === 'wouldBecomeAPrepaidProduct'
      ? 'validation'
      : 'invariant_violated'
  return new AppError(
    kind,
    error instanceof Error ? error.message : `Deposit rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

/** Is this error the named deposit refusal? For a caller that branches on one rule. */
export function isDepositRule(error: unknown, rule: DepositRule): boolean {
  return sqlStateOf(error) === DEPOSIT_SQLSTATE[rule]
}

/**
 * Is this two movements racing for one position in an appointment's sequence?
 *
 * A bare `23505` on this table cannot be told from the one-movement-per-entry index, which means the
 * opposite thing — a caller reusing a journal entry — so the constraint name is what makes a retry
 * distinguishable from a bug. 0063's argument for `isCheckoutAlreadyFinalised`, one table along.
 */
export function isDepositMovementRace(error: unknown): boolean {
  return (
    sqlStateOf(error) === UNIQUE_VIOLATION &&
    constraintOf(error) === DEPOSIT_CONSTRAINT.onePerPosition
  )
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** One movement, as stored. Fils are numbers because fils are integers (ADR 0007). */
export interface DepositMovementRow {
  readonly id: string
  readonly appointmentId: string
  readonly seq: number
  readonly kind: string
  readonly heldBeforeFils: number
  readonly heldAfterFils: number
  readonly amountFils: number
  readonly journalEntryId: string
  readonly invoiceId: string | null
  readonly tenderKind: string | null
  readonly paymentIntentId: string | null
  readonly tradingDate: string
  readonly insideWindow: boolean | null
  readonly windowHours: number | null
  readonly occurredAt: Date
}

/**
 * The columns every read selects, aliased to the row shape.
 *
 * One fragment rather than the list repeated in three functions: `noPropertyAccessFromIndexSignature`
 * makes a renamed column a type error only where the alias is written, so three copies of the list are
 * three places for one of them to stop matching {@link DepositMovementRow} (brief rule 28).
 */
const movementColumns = (sql: Sql) => sql`
  id, appointment_id as "appointmentId", seq, kind,
  held_before_fils::int as "heldBeforeFils", held_after_fils::int as "heldAfterFils",
  amount_fils::int as "amountFils", journal_entry_id as "journalEntryId",
  invoice_id as "invoiceId", tender_kind as "tenderKind",
  payment_intent_id as "paymentIntentId", trading_date::text as "tradingDate",
  inside_window as "insideWindow", window_hours as "windowHours", occurred_at as "occurredAt"
`

/** The liability held against one appointment, from `appointment_deposit_balance`. */
export interface DepositBalanceRow {
  readonly appointmentId: string
  readonly heldFils: number
  readonly movements: number
  readonly lastMovement: string
  readonly asOf: Date
}

/**
 * The deposit held against one appointment, or `null` when no deposit was ever taken.
 *
 * `null` and not zero, deliberately, which is the view's own note: *"an appointment with no movement is
 * ABSENT rather than zero"*. "No deposit was ever taken" and "a deposit was taken and returned" are
 * different facts and the second one has rows — and a caller deciding whether to offer a release at the
 * till needs to tell them apart.
 */
export async function readDepositBalance(
  sql: Sql,
  appointmentId: string,
): Promise<DepositBalanceRow | null> {
  const rows = await sql<DepositBalanceRow[]>`
    select appointment_id as "appointmentId", held_fils::int as "heldFils",
           movements, last_movement as "lastMovement", as_of as "asOf"
      from appointment_deposit_balance
     where appointment_id = ${appointmentId}::uuid
  `
  return rows[0] ?? null
}

/** Every movement against one appointment, oldest first. The history a dispute is answered from. */
export async function readDepositMovements(
  sql: Sql,
  appointmentId: string,
): Promise<readonly DepositMovementRow[]> {
  return await sql<DepositMovementRow[]>`
    select ${movementColumns(sql)} from deposit_movement
     where appointment_id = ${appointmentId}::uuid
     order by seq
  `
}

export interface AppendDepositMovementInput {
  readonly appointmentId: string
  /** 1 for the first movement. The caller's read of the balance says which. */
  readonly seq: number
  /** `DEPOSIT_MOVEMENT_KINDS` in `@berelax/core`. */
  readonly kind: 'received' | 'applied' | 'refunded'
  /** The balance BEFORE this movement, from {@link readDepositBalance}. Zero for the first. */
  readonly heldBeforeFils: number
  /** The magnitude. Strictly positive; direction is the kind, never the sign (0018's argument). */
  readonly amountFils: number
  /** The entry that moved the money, already posted in this transaction. */
  readonly journalEntryId: string
  /** The document this settled. Required for `applied` and refused for the other two. */
  readonly invoiceId?: string | null
  /** How the money arrived or left. Required for `received` and `refunded`, refused for `applied`. */
  readonly tenderKind?: string | null
  readonly paymentIntentId?: string | null
  /** The business day, `YYYY-MM-DD`, resolved with `resolveTradingDate`. Never a calendar date. */
  readonly tradingDate: string
  /** The cancellation verdict. Required for `refunded` and refused for the other two. */
  readonly insideWindow?: boolean | null
  readonly windowHours?: number | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Appends one movement, and writes the `audit_event` beside it.
 *
 * `held_after_fils` is computed HERE from `heldBeforeFils` and the kind rather than taken from the caller,
 * and that is the one derivation this module makes. The reason is that it is not a second opinion:
 * `deposit_movement_balance_moves_by_its_amount` states the identity in the database and would refuse any
 * other value, so a caller-supplied closing balance would be a field whose only possible legal value is
 * the one computed from the other two — which is a field that exists to be got wrong.
 */
export async function appendDepositMovement(
  uow: UnitOfWork,
  input: AppendDepositMovementInput,
): Promise<DepositMovementRow> {
  if (!Number.isInteger(input.amountFils) || input.amountFils <= 0) {
    // The `fils_nonneg` domain is bigint, so PostgreSQL would ROUND a fractional value rather than refuse
    // it, and half a fils of a customer's deposit cannot be explained by anyone (0063's measurement).
    throw new AppError(
      'validation',
      `appendDepositMovement: a ${input.kind} movement of ${input.amountFils} fils is not a movement. ` +
        'Money is integer fils (ADR 0007) and direction is the kind, not the sign.',
      { details: { appointmentId: input.appointmentId, kind: input.kind } },
    )
  }
  if (!ISO_DATE.test(input.tradingDate)) {
    throw new AppError(
      'validation',
      `appendDepositMovement: tradingDate must be an ISO business day (YYYY-MM-DD), received ` +
        `"${input.tradingDate}"`,
      { details: { appointmentId: input.appointmentId, tradingDate: input.tradingDate } },
    )
  }
  const heldAfter =
    input.kind === 'received'
      ? input.heldBeforeFils + input.amountFils
      : input.heldBeforeFils - input.amountFils

  const [row] = await uow.sql<DepositMovementRow[]>`
    insert into deposit_movement
      (appointment_id, seq, kind, held_before_fils, held_after_fils, amount_fils, journal_entry_id,
       invoice_id, tender_kind, payment_intent_id, trading_date, inside_window, window_hours)
    values (${input.appointmentId}::uuid, ${input.seq}, ${input.kind}, ${input.heldBeforeFils},
            ${heldAfter}, ${input.amountFils}, ${input.journalEntryId},
            ${input.invoiceId ?? null}, ${input.tenderKind ?? null},
            ${input.paymentIntentId ?? null}, ${input.tradingDate}::date,
            ${input.insideWindow ?? null}, ${input.windowHours ?? null})
    returning ${movementColumns(uow.sql)}
  `
  const movement = row as DepositMovementRow

  await uow.audit.record({
    action: `deposit.${input.kind}`,
    entityType: 'deposit_movement',
    entityId: movement.id,
    operation: 'create',
    after: {
      appointmentId: movement.appointmentId,
      seq: movement.seq,
      kind: movement.kind,
      amountFils: movement.amountFils,
      heldAfterFils: movement.heldAfterFils,
      journalEntryId: movement.journalEntryId,
      invoiceId: movement.invoiceId,
      tradingDate: movement.tradingDate,
    },
  })

  return movement
}

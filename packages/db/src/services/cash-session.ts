import { AppError } from '@berelax/shared'
import type { ActorKind } from '../audit.ts'
import type { Sql } from '../connection.ts'
import { type JournalEntryInput, postJournalEntry } from '../repositories/journal.ts'
import type { UnitOfWork } from '../tx.ts'
import { periodStatusOn } from './period-close.ts'

/**
 * The cash-session service: open a shift, drop cash out of it, count it, and correct a closed one.
 *
 * ## There is no reopen, and there is no writer for a closed session
 *
 * The export surface of this module is asserted by `cash-session.itest.ts` and by
 * `scripts/test-no-invoice-mutation.mjs`'s sibling assertion over the money modules: no exported
 * identifier carries `reopen`, `unlock`, `edit`, `void` or `delete`. The database says it again —
 * `cash_session_close_is_terminal` (ZU002) refuses EVERY update to a closed row for every role including
 * the owner, and `berelax_app` holds no DELETE on the table and UPDATE on only the ten columns a close
 * writes. The remedy is {@link postCashSessionAdjustment}: a new row on its own business day with its own
 * entry.
 *
 * ## Why the postings arrive already computed
 *
 * `packages/db` must never import `packages/core` — the dependency runs the other way — so this module
 * decides no account and rounds nothing. The caller builds each entry with `cashUpPosting`,
 * `cashDropPosting` or `cashSessionCorrection` from `@berelax/core` and maps it field for field;
 * `packages/fixtures/src/cash-up.ts` is that mapping and `packages/fixtures/src/cash-up.itest.ts`
 * exercises the pair. The database checks the same facts again at COMMIT (ZU004), because this module is
 * not the only thing that can reach a psql prompt.
 *
 * ## Why the close does not compute its own expected float
 *
 * It does not compute it at all. The caller passes the four snapshot figures; `expected_float_fils` and
 * `discrepancy_fils` are GENERATED columns, so the arithmetic happens once, in SQL, in
 * `cash_session_expected_float_fils()`. A TypeScript subtraction here would be a third statement of the
 * formula (core's `expectedFloat` is the first, the generation expression the second) and the one a
 * caller would trust. What this module does instead is READ the generated figures back and return them —
 * {@link readCashSession} and the row `closeCashSession` returns both carry the database's answer.
 *
 * The four snapshot figures are read from the rows by {@link readDrawerTakings}, which is the same
 * arithmetic `ZU005` re-does at COMMIT. Two readers of one rule rather than two statements of it: the
 * trigger is the authority and this is the reader a screen uses, exactly as `period_close_blocker()` is
 * the authority for `periodCloseBlockers` (0073).
 *
 * ## The period check goes through `periodStatusOn`
 *
 * "Is this business day inside a closed accounting period?" is `periodStatusOn(sql, date)` from
 * `./period-close.ts`, which reads `period_lock_for()` and `earliest_open_date_from()` in one round trip.
 * No second reader is written here. `ZU003` calls the same two SQL functions, so a screen cannot answer
 * differently from the refusal a close would get.
 */

/**
 * The SQLSTATEs `0076_cash_session.sql` raises.
 *
 * Class 'ZU'. Every other Z-class mnemonic near this domain is taken — 'ZT' is 0068's (tenders) and
 * 0069's, 'ZD' is 0072's, 'ZC' is 0029's — and one class with two meanings is how a caller comes to
 * handle a tender defect as a cash-up defect.
 */
export const CASH_SESSION_SQLSTATE = {
  /** A close arrived with no counted float. The reconciliation has no measurement in it. */
  countRequired: 'ZU001',
  /** A closed session was updated or deleted, or a drop was recorded into one. Includes reopening. */
  alreadyClosed: 'ZU002',
  /** The business day is inside a locked accounting period. The message names the earliest OPEN date. */
  periodLocked: 'ZU003',
  /** A non-zero discrepancy was not carried to 6140, or a balanced drawer claimed an entry. At COMMIT. */
  varianceNotPosted: 'ZU004',
  /** The snapshotted cash figures disagree with the payment, refund and drop rows. At COMMIT. */
  snapshotDisagrees: 'ZU005',
  /** Cash was recorded on a business day whose drawer had already been counted. */
  cashAfterTheCount: 'ZU006',
  /** An adjustment named no session, a session still open, or a day before the shift. */
  adjustmentNotPostable: 'ZU007',
} as const

/** `23514`: a CHECK refused the row — the half-counted close and the missing reason live here. */
const CHECK_VIOLATION = '23514'
/** `23505`: a second OPEN session for one drawer and business day, or a repeated shift number. */
const UNIQUE_VIOLATION = '23505'
/** `23503`: the session names a drawer, a business day or an entry the database does not have. */
const FOREIGN_KEY_VIOLATION = '23503'
/** `42501`: the application role holds no such privilege. This is the grant layer refusing. */
const INSUFFICIENT_PRIVILEGE = '42501'

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a PostgreSQL error raised by the cash-session schema into an `AppError`, or `null` if it is
 * not one of ours.
 *
 * Idempotent, for `journalError`'s reason: ZU004 and ZU005 are DEFERRED and arrive from `COMMIT`, which
 * no function in this module executes, so they are translated at a different layer from the one that
 * issued the statement. A translation that re-classified an already-translated error as "not one of ours"
 * would turn an unposted variance back into an unknown failure at the outermost layer, which is where it
 * gets retried.
 */
export function cashSessionError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case CASH_SESSION_SQLSTATE.countRequired:
    case CASH_SESSION_SQLSTATE.adjustmentNotPostable:
      return new AppError('validation', message, { details: { sqlState: code } })
    case CASH_SESSION_SQLSTATE.alreadyClosed:
      // `forbidden` and not `conflict`: the request is well formed and the answer is that this is not a
      // thing anybody may do. A `conflict` invites a retry, and every retry gets the same refusal.
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case CASH_SESSION_SQLSTATE.periodLocked:
      // `forbidden`: well formed, and the period is shut. The message carries the earliest open date,
      // which is the one thing the caller can act on. 0072's classification for ZD003.
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case CASH_SESSION_SQLSTATE.cashAfterTheCount:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case CASH_SESSION_SQLSTATE.varianceNotPosted:
    case CASH_SESSION_SQLSTATE.snapshotDisagrees:
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case CHECK_VIOLATION:
      return new AppError('validation', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case FOREIGN_KEY_VIOLATION:
      return new AppError('validation', message, { details: { sqlState: code } })
    case INSUFFICIENT_PRIVILEGE:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    default:
      return null
  }
}

/** True when `err` is the terminal-close refusal. Includes every attempt to reopen a session. */
export function isCashSessionClosed(err: unknown): boolean {
  return sqlState(err) === CASH_SESSION_SQLSTATE.alreadyClosed
}

/** True when `err` is the unposted-variance refusal. It arrives from COMMIT, never from an UPDATE. */
export function isVarianceNotPosted(err: unknown): boolean {
  return sqlState(err) === CASH_SESSION_SQLSTATE.varianceNotPosted
}

/** True when `err` is `CountRequired`: a close with no counted float. */
export function isCountRequired(err: unknown): boolean {
  return sqlState(err) === CASH_SESSION_SQLSTATE.countRequired
}

/** True when `err` is the locked-period refusal. Its message names the earliest OPEN date. */
export function isCashSessionPeriodLocked(err: unknown): boolean {
  return sqlState(err) === CASH_SESSION_SQLSTATE.periodLocked
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertBusinessDay(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${label} must be an ISO business day (YYYY-MM-DD), received "${value}". Trading runs ` +
        '11:00-02:00, so it is resolved with resolveTradingDate and never truncated from an instant.',
      { details: { label, value } },
    )
  }
}

// --- reading -------------------------------------------------------------------------------------

/** A drawer as the registry holds it. */
export interface RegisteredCashDrawer {
  readonly code: string
  readonly label: string
  /** The asset account this drawer's cash sits in. The cash-up posting reads it rather than assuming. */
  readonly postingAccountCode: string
  readonly retiredAt: Date | null
}

/** Every drawer, retired ones included, in code order. */
export async function readCashDrawers(sql: Sql): Promise<readonly RegisteredCashDrawer[]> {
  const rows = await sql<
    { code: string; label: string; posting_account_code: string; retired_at: Date | null }[]
  >`
    select code, label, posting_account_code, retired_at from cash_drawer order by code
  `
  return rows.map((row) => ({
    code: row.code,
    label: row.label,
    postingAccountCode: row.posting_account_code,
    retiredAt: row.retired_at,
  }))
}

/**
 * The five figures a drawer is reconciled from, read out of the rows.
 *
 * Deliberately shaped to be mapped field for field onto core's `DrawerTakings`, which this package may
 * not import.
 */
export interface DrawerTakingsRow {
  readonly openingFloatFils: number
  readonly cashReceivedFils: number
  readonly changeGivenFils: number
  readonly cashRefundedFils: number
  readonly dropsFils: number
}

export interface CashSessionRowShape {
  readonly id: string
  readonly drawerCode: string
  /** The BUSINESS DAY. Trading runs 11:00–02:00, so a 23:00-to-02:00 shift is one row on one date. */
  readonly tradingDate: string
  readonly shiftNo: number
  readonly status: 'open' | 'closed'
  readonly openingFloatFils: number
  readonly openedAt: Date
  readonly openedByActorKind: string
  readonly cashReceivedFils: number | null
  readonly changeGivenFils: number | null
  readonly cashRefundedFils: number | null
  readonly dropsFils: number
  readonly countedFloatFils: number | null
  /** Generated in SQL. NULL while the session is open. */
  readonly expectedFloatFils: number | null
  /** Generated in SQL, SIGNED: negative is short, positive is over. NULL while the session is open. */
  readonly discrepancyFils: number | null
  readonly closedAt: Date | null
  readonly closedByActorKind: string | null
  readonly countNote: string | null
  readonly journalEntryId: string | null
}

interface RawSessionRow {
  readonly id: string
  readonly drawer_code: string
  readonly trading_date: string
  readonly shift_no: number
  readonly status: string
  readonly opening_float_fils: string
  readonly opened_at: Date
  readonly opened_by_actor_kind: string
  readonly cash_received_fils: string | null
  readonly change_given_fils: string | null
  readonly cash_refunded_fils: string | null
  readonly drops_fils: string
  readonly counted_float_fils: string | null
  readonly expected_float_fils: string | null
  readonly discrepancy_fils: string | null
  readonly closed_at: Date | null
  readonly closed_by_actor_kind: string | null
  readonly count_note: string | null
  readonly journal_entry_id: string | null
}

const SESSION_COLUMNS = (sql: Sql) => sql`
  id, drawer_code, trading_date::text as trading_date, shift_no, status,
  opening_float_fils, opened_at, opened_by_actor_kind,
  cash_received_fils, change_given_fils, cash_refunded_fils, drops_fils, counted_float_fils,
  expected_float_fils, discrepancy_fils,
  closed_at, closed_by_actor_kind, count_note, journal_entry_id
`

/**
 * A `bigint` column as a number, or `null`.
 *
 * The driver returns `bigint` as a string so nothing rounds a money figure, and `Number(row.x)` at the
 * consumer would put the rounding straight back. The round trip is checked rather than assumed: a value
 * that does not survive `String(Number(v))` means somebody has reformatted a column on the way here.
 */
function filsOrNull(value: string | null, label: string): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new AppError(
      'invariant_violated',
      `${label} '${value}' does not survive a round trip through a JavaScript number, so it cannot be ` +
        'reconciled against a counted drawer. Money is integer fils (ADR 0007).',
    )
  }
  return parsed
}

function fils(value: string, label: string): number {
  const parsed = filsOrNull(value, label)
  if (parsed === null) {
    throw new AppError('invariant_violated', `${label} is null where a figure is required`)
  }
  return parsed
}

function toSession(row: RawSessionRow): CashSessionRowShape {
  if (row.status !== 'open' && row.status !== 'closed') {
    throw new AppError(
      'invariant_violated',
      `cash_session ${row.id} has status "${row.status}", which cash_session_status_known forbids`,
    )
  }
  return {
    id: row.id,
    drawerCode: row.drawer_code,
    tradingDate: row.trading_date,
    shiftNo: row.shift_no,
    status: row.status,
    openingFloatFils: fils(row.opening_float_fils, 'opening_float_fils'),
    openedAt: row.opened_at,
    openedByActorKind: row.opened_by_actor_kind,
    cashReceivedFils: filsOrNull(row.cash_received_fils, 'cash_received_fils'),
    changeGivenFils: filsOrNull(row.change_given_fils, 'change_given_fils'),
    cashRefundedFils: filsOrNull(row.cash_refunded_fils, 'cash_refunded_fils'),
    dropsFils: fils(row.drops_fils, 'drops_fils'),
    countedFloatFils: filsOrNull(row.counted_float_fils, 'counted_float_fils'),
    expectedFloatFils: filsOrNull(row.expected_float_fils, 'expected_float_fils'),
    discrepancyFils: filsOrNull(row.discrepancy_fils, 'discrepancy_fils'),
    closedAt: row.closed_at,
    closedByActorKind: row.closed_by_actor_kind,
    countNote: row.count_note,
    journalEntryId: row.journal_entry_id,
  }
}

/** One session by id, or `null`. */
export async function readCashSession(sql: Sql, id: string): Promise<CashSessionRowShape | null> {
  const [row] = await sql<RawSessionRow[]>`
    select ${SESSION_COLUMNS(sql)} from cash_session where id = ${id}::uuid
  `
  return row ? toSession(row) : null
}

/**
 * The OPEN session for a drawer, or `null`.
 *
 * At most one exists per business day by `cash_session_one_open_per_drawer_per_day`, and in practice at
 * most one at all — the caller closes a shift before opening the next. Ordered by business day so a
 * forgotten open session from a previous day is found rather than skipped.
 */
export async function readOpenCashSession(
  sql: Sql,
  drawerCode: string,
): Promise<CashSessionRowShape | null> {
  const [row] = await sql<RawSessionRow[]>`
    select ${SESSION_COLUMNS(sql)} from cash_session
     where drawer_code = ${drawerCode} and status = 'open'
     order by trading_date, shift_no
     limit 1
  `
  return row ? toSession(row) : null
}

/** Every session for one business day, in shift order. What a daily cash-up report reads. */
export async function readCashSessionsForBusinessDay(
  sql: Sql,
  tradingDate: string,
): Promise<readonly CashSessionRowShape[]> {
  assertBusinessDay(tradingDate, 'tradingDate')
  const rows = await sql<RawSessionRow[]>`
    select ${SESSION_COLUMNS(sql)} from cash_session
     where trading_date = ${tradingDate}::date
     order by drawer_code, shift_no
  `
  return rows.map(toSession)
}

/**
 * The takings a drawer should be counted against, summed over the rows for its BUSINESS DAY.
 *
 * `tender_type.gives_change` selects the cash tenders rather than the literal `'cash'`, so the registry
 * (0068) stays the one definition of which tenders are physical money and a fourth cash-like type added
 * later is included without editing this query.
 *
 * The same arithmetic `ZU005` re-does at COMMIT. Two readers of one rule, not two statements of it: the
 * trigger is the authority and this is what a cash-up screen shows before anybody counts.
 */
export async function readDrawerTakings(
  sql: Sql,
  sessionId: string,
): Promise<DrawerTakingsRow | null> {
  const [row] = await sql<
    {
      opening_float_fils: string
      received_fils: string
      change_fils: string
      refunded_fils: string
      drops_fils: string
    }[]
  >`
    select s.opening_float_fils,
           coalesce(live.received_fils, 0)::text as received_fils,
           coalesce(live.change_fils, 0)::text   as change_fils,
           coalesce(back.refunded_fils, 0)::text as refunded_fils,
           coalesce(drops.fils, 0)::text         as drops_fils
      from cash_session s
      left join (
        select p.trading_date,
               sum(p.amount_fils)::bigint       as received_fils,
               sum(p.change_given_fils)::bigint as change_fils
          from payment p join tender_type t on t.code = p.tender_kind
         where t.gives_change
         group by p.trading_date
      ) live on live.trading_date = s.trading_date
      left join (
        select r.trading_date, sum(r.amount_fils)::bigint as refunded_fils
          from refund r join tender_type t on t.code = r.tender_kind
         where t.gives_change
         group by r.trading_date
      ) back on back.trading_date = s.trading_date
      left join (
        select d.cash_session_id, sum(d.amount_fils)::bigint as fils
          from cash_drop d group by d.cash_session_id
      ) drops on drops.cash_session_id = s.id
     where s.id = ${sessionId}::uuid
  `
  if (!row) return null
  return {
    openingFloatFils: fils(row.opening_float_fils, 'opening_float_fils'),
    cashReceivedFils: fils(row.received_fils, 'cash received'),
    changeGivenFils: fils(row.change_fils, 'change given'),
    cashRefundedFils: fils(row.refunded_fils, 'cash refunded'),
    dropsFils: fils(row.drops_fils, 'drops'),
  }
}

// --- opening -------------------------------------------------------------------------------------

export interface OpenCashSessionInput {
  readonly drawerCode: string
  /**
   * The BUSINESS DAY the shift belongs to, `YYYY-MM-DD`, already resolved with `resolveTradingDate`.
   *
   * Trading runs 11:00–02:00, so a shift opened at 23:00 and a shift opened at 01:00 the next calendar
   * morning are the SAME business day and therefore the same session. Truncating a date from an instant
   * here would open a second session at midnight, each with its own opening float, and neither would
   * balance.
   */
  readonly tradingDate: string
  /** Which shift of that day. Defaults to one more than the highest already recorded. */
  readonly shiftNo?: number
  readonly openingFloatFils: number
}

/**
 * Opens a shift on a drawer for a business day, inside `uow`'s transaction.
 *
 * The period check is made HERE as well as by `ZU003`, and the reason is the message: reading
 * `periodStatusOn` first lets the refusal carry the earliest open date as DATA rather than as text
 * somebody has to parse out of an exception. `periodCloseBlockers` has the same arrangement (0073).
 */
export async function openCashSession(
  uow: UnitOfWork,
  input: OpenCashSessionInput,
  actorKind: ActorKind,
): Promise<CashSessionRowShape> {
  assertBusinessDay(input.tradingDate, 'tradingDate')
  if (!Number.isInteger(input.openingFloatFils) || input.openingFloatFils < 0) {
    throw new AppError(
      'validation',
      `An opening float of ${input.openingFloatFils} fils is not a float. Money is integer fils ` +
        '(ADR 0007) and a drawer holds no negative cash.',
    )
  }

  const status = await periodStatusOn(uow.sql, input.tradingDate)
  if (status.closed) {
    throw new AppError(
      'forbidden',
      `CashSessionPeriodLocked: cannot open a session for drawer "${input.drawerCode}" on business ` +
        `day ${input.tradingDate}; accounting period "${String(status.periodId)}" is locked. The ` +
        `earliest open date is ${status.earliestOpenDate}.`,
      {
        details: {
          sqlState: CASH_SESSION_SQLSTATE.periodLocked,
          periodId: status.periodId,
          earliestOpenDate: status.earliestOpenDate,
        },
      },
    )
  }

  // The next shift number for this drawer and business day, when the caller does not name one. A
  // COUNT would be wrong here: the second shift of a day whose first was counted is shift 2 whether or
  // not the first row is still there, and `cash_session_one_row_per_shift` is what a reference to "the
  // second shift on the 3rd" resolves through.
  const [next] = await uow.sql<{ next_shift: number }[]>`
    select coalesce(max(shift_no), 0) + 1 as next_shift from cash_session
     where drawer_code = ${input.drawerCode} and trading_date = ${input.tradingDate}::date
  `
  const shiftNo = input.shiftNo ?? next?.next_shift ?? 1

  const [row] = await uow.sql<RawSessionRow[]>`
    insert into cash_session (
      drawer_code, trading_date, shift_no, opening_float_fils, opened_by_actor_kind
    ) values (
      ${input.drawerCode}, ${input.tradingDate}::date, ${shiftNo}, ${input.openingFloatFils},
      ${actorKind}
    )
    returning ${SESSION_COLUMNS(uow.sql)}
  `
  if (!row) throw new AppError('invariant_violated', 'insert into cash_session returned no row')
  const session = toSession(row)

  await uow.audit.record({
    action: 'till.cash_session.open',
    entityType: 'cash_session',
    entityId: session.id,
    operation: 'create',
    after: session,
  })
  await uow.publish({
    eventType: 'till.cash_session.opened',
    aggregateType: 'cash_session',
    aggregateId: session.id,
    payload: {
      drawerCode: session.drawerCode,
      tradingDate: session.tradingDate,
      shiftNo: session.shiftNo,
      openingFloatFils: session.openingFloatFils,
    },
    // Derived from the business fact — one open session per drawer, day and shift — so a retry of the
    // same open cannot enqueue twice.
    idempotencyKey: `till.cash_session.opened:${session.drawerCode}:${session.tradingDate}:${session.shiftNo}`,
  })
  return session
}

// --- dropping ------------------------------------------------------------------------------------

export interface RecordCashDropInput {
  readonly cashSessionId: string
  readonly amountFils: number
  /** `1020 Bank current` for a banking, `1015 Petty cash float` for the safe. */
  readonly destinationAccountCode: string
  readonly reason: string
  readonly reference?: string
  /** The entry `cashDropPosting` built: `Dr destination / Cr <drawer account>`, source `payout`. */
  readonly posting: JournalEntryInput
}

export interface RecordedCashDrop {
  readonly id: string
  readonly cashSessionId: string
  readonly dropNo: number
  readonly amountFils: number
  readonly destinationAccountCode: string
  readonly reference: string | null
  readonly reason: string
  readonly journalEntryId: string
}

/**
 * Records cash out of an open drawer and posts the entry that moved it, in `uow`'s transaction.
 *
 * The entry is posted BEFORE the row, which is the opposite of `issueCreditNote`'s order and for the
 * opposite reason: `cash_drop.journal_entry_id` is a real, IMMEDIATE foreign key — nothing truncates the
 * journal, so the key costs nothing — and the refusal a caller most needs here is about the drop, so
 * `cash_drop_into_an_open_session` (ZU002) has to run against a row that can be inserted at all.
 */
export async function recordCashDrop(
  uow: UnitOfWork,
  input: RecordCashDropInput,
): Promise<RecordedCashDrop> {
  if (!Number.isInteger(input.amountFils) || input.amountFils <= 0) {
    throw new AppError(
      'validation',
      `A drop of ${input.amountFils} fils moves nothing out of the drawer. Money is integer fils ` +
        '(ADR 0007), and direction is the side of an entry, never the sign of an amount.',
    )
  }
  if (input.posting.source !== 'payout') {
    // A drop classified `cash_up` would satisfy ZU004's search for the session's own variance entry,
    // which is the one way a real discrepancy could be made to look posted when it was not.
    throw new AppError(
      'validation',
      `A cash drop's entry must have source "payout" and this one has "${input.posting.source}". ` +
        'A drop is not a discrepancy, and ZU004 matches the session\'s variance entry on "cash_up".',
    )
  }
  await postJournalEntry(uow, input.posting)

  const [row] = await uow.sql<
    {
      id: string
      cash_session_id: string
      drop_no: number
      amount_fils: string
      destination_account_code: string
      reference: string | null
      reason: string
      journal_entry_id: string
    }[]
  >`
    insert into cash_drop (
      cash_session_id, drop_no, amount_fils, destination_account_code, reference, reason,
      journal_entry_id
    ) values (
      ${input.cashSessionId}::uuid,
      (select coalesce(max(drop_no), 0) + 1 from cash_drop
        where cash_session_id = ${input.cashSessionId}::uuid),
      ${input.amountFils}, ${input.destinationAccountCode}, ${input.reference ?? null},
      ${input.reason}, ${input.posting.entryId}
    )
    returning id, cash_session_id, drop_no, amount_fils, destination_account_code, reference, reason,
              journal_entry_id
  `
  if (!row) throw new AppError('invariant_violated', 'insert into cash_drop returned no row')
  const drop: RecordedCashDrop = {
    id: row.id,
    cashSessionId: row.cash_session_id,
    dropNo: row.drop_no,
    amountFils: fils(row.amount_fils, 'amount_fils'),
    destinationAccountCode: row.destination_account_code,
    reference: row.reference,
    reason: row.reason,
    journalEntryId: row.journal_entry_id,
  }
  await uow.audit.record({
    action: 'till.cash_drop.record',
    entityType: 'cash_drop',
    entityId: drop.id,
    operation: 'create',
    after: drop,
  })
  return drop
}

// --- closing -------------------------------------------------------------------------------------

export interface CloseCashSessionInput {
  readonly cashSessionId: string
  /**
   * What was physically counted. `undefined` is the {@link CASH_SESSION_SQLSTATE.countRequired} case and
   * is refused here before a statement is issued — a zero count is an empty drawer, which is a fact, and
   * no count at all is the absence of one.
   */
  readonly countedFloatFils: number | undefined
  /** The four snapshot figures, as {@link readDrawerTakings} returned them. ZU005 re-checks them. */
  readonly takings: DrawerTakingsRow
  /** Why the drawer is out. Required when the discrepancy is non-zero; ignored when it is zero. */
  readonly countNote?: string
  /**
   * The entry `cashUpPosting` built, or `undefined` when the drawer balanced.
   *
   * Not derived from the count here: whether one is needed is the DATABASE's answer, because
   * `discrepancy_fils` is a generated column. Passing one for a balanced drawer, or none for a drawer
   * that is out, is refused by ZU004 at COMMIT — and by this function first, so the caller gets a
   * sentence rather than a deferred trigger.
   */
  readonly posting?: JournalEntryInput
}

/**
 * Counts a drawer and closes its shift, in `uow`'s transaction.
 *
 * ## What the UPDATE does and does not touch
 *
 * The ten columns a close writes, and nothing else. `berelax_app` holds UPDATE on exactly those, so a
 * statement that tried to move `trading_date`, `drawer_code`, `shift_no` or `opening_float_fils` — and so
 * re-point a counted drawer at another business day — is refused by the grant before a trigger is
 * reached.
 *
 * ## Why `where status = 'open'` is in the statement as well as in the trigger
 *
 * `cash_session_close_is_terminal` (ZU002) refuses an update to a closed row, which is the authority. The
 * predicate here makes the SECOND close of one session a zero-row update rather than a refusal, and the
 * zero rows are then reported as `CashSessionAlreadyClosed` with the session's own figures read back —
 * because "this drawer was counted at 02:14 and was out by 300 fils" is what the operator needs, and the
 * trigger's sentence cannot include what the session held before, having been handed only `old`.
 */
export async function closeCashSession(
  uow: UnitOfWork,
  input: CloseCashSessionInput,
  actorKind: ActorKind,
): Promise<CashSessionRowShape> {
  const existing = await readCashSession(uow.sql, input.cashSessionId)
  if (!existing) {
    throw new AppError(
      'not_found',
      `No cash session ${input.cashSessionId}. A count against a session that does not exist is a ` +
        'figure about nothing.',
    )
  }
  if (input.countedFloatFils === undefined) {
    throw new AppError(
      'validation',
      `CountRequired: cash session ${existing.id} for drawer "${existing.drawerCode}" on business day ` +
        `${existing.tradingDate} cannot be closed with no counted amount. The counted float minus the ` +
        'expected float IS the reconciliation; a close without one records an expectation and no ' +
        'measurement.',
      { details: { sqlState: CASH_SESSION_SQLSTATE.countRequired, cashSessionId: existing.id } },
    )
  }
  if (existing.status === 'closed') {
    throw new AppError(
      'forbidden',
      `CashSessionAlreadyClosed: cash session ${existing.id} for drawer "${existing.drawerCode}" was ` +
        `counted and closed on ${String(existing.closedAt?.toISOString())} with a discrepancy of ` +
        `${String(existing.discrepancyFils)} fils. A closed session is corrected by a new dated ` +
        'cash_session_adjustment, never by counting it again.',
      { details: { sqlState: CASH_SESSION_SQLSTATE.alreadyClosed, cashSessionId: existing.id } },
    )
  }

  // The expected float and the discrepancy are the DATABASE's arithmetic (generated columns through
  // `cash_session_expected_float_fils`). What is checked here is only whether a posting was supplied
  // when one was needed, which needs the sign — so it is computed from the same five figures the
  // generation expression will use, and then the generated answer is read back and returned.
  const expected =
    input.takings.openingFloatFils +
    input.takings.cashReceivedFils -
    input.takings.changeGivenFils -
    input.takings.cashRefundedFils -
    input.takings.dropsFils
  const discrepancy = input.countedFloatFils - expected

  if (discrepancy !== 0 && input.posting === undefined) {
    throw new AppError(
      'invariant_violated',
      `Cash session ${existing.id} is out by ${discrepancy} fils (counted ${input.countedFloatFils}, ` +
        `expected ${expected}) and no cash-up posting was supplied. A reconciliation that can absorb ` +
        'a variance is not a reconciliation: build the entry with cashUpPosting and pass it, so the ' +
        'difference reaches 6140 Cash over and short in this transaction.',
      { details: { sqlState: CASH_SESSION_SQLSTATE.varianceNotPosted, discrepancy } },
    )
  }
  if (discrepancy === 0 && input.posting !== undefined) {
    throw new AppError(
      'invariant_violated',
      `Cash session ${existing.id} balanced exactly and a cash-up posting was supplied. A balanced ` +
        'drawer posts nothing: a zero-value line is refused, so that entry moves some other figure.',
      { details: { sqlState: CASH_SESSION_SQLSTATE.varianceNotPosted } },
    )
  }
  if (discrepancy !== 0 && (input.countNote ?? '').trim().length === 0) {
    throw new AppError(
      'validation',
      `Cash session ${existing.id} is out by ${discrepancy} fils and carries no reason. The close is ` +
        'recorded rather than refused — the count is the measurement and the expectation is the ' +
        'derivation — but a discrepancy nobody explained is a discrepancy nobody investigated.',
      { details: { cashSessionId: existing.id, discrepancy } },
    )
  }

  // The entry FIRST, so `journal_entry_id` can be set by the same UPDATE that closes the session and the
  // period guard on `journal_entry` (ZL002) is reached before ZU004's deferred check has anything to
  // disagree with. ZU003 has already refused a locked business day at the open.
  if (input.posting !== undefined) {
    if (input.posting.source !== 'cash_up') {
      throw new AppError(
        'validation',
        `A cash-up entry must have source "cash_up" and this one has "${input.posting.source}". ` +
          'ZU004 matches on it, because a refund and a cash-up can produce identical lines and the ' +
          'classification is the only thing that tells them apart when somebody asks.',
      )
    }
    if (input.posting.entryDate !== existing.tradingDate) {
      throw new AppError(
        'validation',
        `A cash-up entry for business day ${existing.tradingDate} is dated ` +
          `${input.posting.entryDate}. The discrepancy is a fact about that shift, so it posts on ` +
          'that business day; dating it elsewhere files the loss in a period the shift never reached.',
      )
    }
    await postJournalEntry(uow, input.posting)
  }

  const [row] = await uow.sql<RawSessionRow[]>`
    update cash_session set
      status               = 'closed',
      cash_received_fils   = ${input.takings.cashReceivedFils},
      change_given_fils    = ${input.takings.changeGivenFils},
      cash_refunded_fils   = ${input.takings.cashRefundedFils},
      drops_fils           = ${input.takings.dropsFils},
      counted_float_fils   = ${input.countedFloatFils},
      closed_at            = now(),
      closed_by_actor_kind = ${actorKind},
      count_note           = ${input.countNote ?? null},
      journal_entry_id     = ${input.posting?.entryId ?? null}
    where id = ${input.cashSessionId}::uuid and status = 'open'
    returning ${SESSION_COLUMNS(uow.sql)}
  `
  if (!row) {
    throw new AppError(
      'forbidden',
      `CashSessionAlreadyClosed: cash session ${input.cashSessionId} was closed by another ` +
        'transaction between the read and the update. A closed session is corrected by a new dated ' +
        'cash_session_adjustment, never by counting it again.',
      { details: { sqlState: CASH_SESSION_SQLSTATE.alreadyClosed } },
    )
  }
  const session = toSession(row)

  // The `before` here is REAL, unlike a fresh insert's: the open session, read inside this transaction.
  // That pair — what the drawer was expected to hold, and what it was counted at — is the whole content
  // of the row an investigation reads.
  await uow.audit.record({
    action: 'till.cash_session.close',
    entityType: 'cash_session',
    entityId: session.id,
    operation: 'update',
    before: existing,
    after: session,
  })
  await uow.publish({
    eventType: 'till.cash_session.closed',
    aggregateType: 'cash_session',
    aggregateId: session.id,
    payload: {
      drawerCode: session.drawerCode,
      tradingDate: session.tradingDate,
      shiftNo: session.shiftNo,
      countedFloatFils: session.countedFloatFils,
      expectedFloatFils: session.expectedFloatFils,
      // Signed. The figure a report sums over a month to tell a process problem from a person problem.
      discrepancyFils: session.discrepancyFils,
      journalEntryId: session.journalEntryId,
    },
    idempotencyKey: `till.cash_session.closed:${session.id}`,
  })
  return session
}

// --- correcting a closed session -----------------------------------------------------------------

export interface PostCashSessionAdjustmentInput {
  readonly cashSessionId: string
  /**
   * The business day the CORRECTION posts on. Not the session's: a discrepancy found on Tuesday against
   * Saturday's drawer is Tuesday's entry, because Saturday may be filed.
   *
   * `earliestOpenDateFrom` from `./period-close.ts` is where a caller gets this when the obvious date is
   * shut. No mirror of that walk is written here.
   */
  readonly tradingDate: string
  /** Signed. Positive means the drawer held MORE than the close recorded. */
  readonly amountFils: number
  readonly reason: string
  /** The entry `cashSessionCorrection` built, dated on `tradingDate`, source `adjustment`. */
  readonly posting: JournalEntryInput
}

export interface PostedCashSessionAdjustment {
  readonly id: string
  readonly cashSessionId: string
  readonly adjustmentNo: number
  readonly tradingDate: string
  readonly amountFils: number
  readonly reason: string
  readonly journalEntryId: string
}

/**
 * Posts a dated correction against a CLOSED session, in `uow`'s transaction.
 *
 * This is the whole of "reopening a closed session is impossible: a correction is a new dated adjustment
 * entry". Nothing about the original row changes — `cash_session_close_is_terminal` would refuse it — so
 * the count that was taken stays readable beside the correction that followed it.
 */
export async function postCashSessionAdjustment(
  uow: UnitOfWork,
  input: PostCashSessionAdjustmentInput,
): Promise<PostedCashSessionAdjustment> {
  assertBusinessDay(input.tradingDate, 'tradingDate')
  if (!Number.isInteger(input.amountFils) || input.amountFils === 0) {
    throw new AppError(
      'validation',
      `A correction of ${input.amountFils} fils moves nothing. Money is integer fils (ADR 0007), and ` +
        'a zero adjustment is a record somebody started and did not finish.',
    )
  }
  if (input.posting.source !== 'adjustment') {
    throw new AppError(
      'validation',
      `A cash-session correction's entry must have source "adjustment" and this one has ` +
        `"${input.posting.source}". A correction is not a count, and ZU004 matches a session's ` +
        'variance entry on "cash_up".',
    )
  }
  if (input.posting.entryDate !== input.tradingDate) {
    throw new AppError(
      'validation',
      `A correction dated ${input.tradingDate} carries an entry dated ${input.posting.entryDate}. ` +
        'The row and its posting state one date or they state two different corrections.',
    )
  }

  const status = await periodStatusOn(uow.sql, input.tradingDate)
  if (status.closed) {
    throw new AppError(
      'forbidden',
      `CashSessionPeriodLocked: a correction dated ${input.tradingDate} cannot be posted; accounting ` +
        `period "${String(status.periodId)}" is locked. The earliest open date is ` +
        `${status.earliestOpenDate}.`,
      {
        details: {
          sqlState: CASH_SESSION_SQLSTATE.periodLocked,
          periodId: status.periodId,
          earliestOpenDate: status.earliestOpenDate,
        },
      },
    )
  }

  await postJournalEntry(uow, input.posting)

  const [row] = await uow.sql<
    {
      id: string
      cash_session_id: string
      adjustment_no: number
      trading_date: string
      amount_fils: string
      reason: string
      journal_entry_id: string
    }[]
  >`
    insert into cash_session_adjustment (
      cash_session_id, adjustment_no, trading_date, amount_fils, reason, journal_entry_id
    ) values (
      ${input.cashSessionId}::uuid,
      (select coalesce(max(adjustment_no), 0) + 1 from cash_session_adjustment
        where cash_session_id = ${input.cashSessionId}::uuid),
      ${input.tradingDate}::date, ${input.amountFils}, ${input.reason}, ${input.posting.entryId}
    )
    returning id, cash_session_id, adjustment_no, trading_date::text as trading_date, amount_fils,
              reason, journal_entry_id
  `
  if (!row) {
    throw new AppError('invariant_violated', 'insert into cash_session_adjustment returned no row')
  }
  const adjustment: PostedCashSessionAdjustment = {
    id: row.id,
    cashSessionId: row.cash_session_id,
    adjustmentNo: row.adjustment_no,
    tradingDate: row.trading_date,
    amountFils: fils(row.amount_fils, 'amount_fils'),
    reason: row.reason,
    journalEntryId: row.journal_entry_id,
  }

  // The `before` is the session the correction is ABOUT, read inside this transaction. It is unchanged
  // by this write and that is the point: the audit row holds the count that was taken and the correction
  // that followed it, which is the pair an investigation reads.
  // The `before` is the session the correction is ABOUT, read inside this transaction. It is unchanged
  // by this write, and that is the point: the audit row holds the count that was taken and the
  // correction that followed it, which is the pair an investigation reads.
  const corrected = await readCashSession(uow.sql, input.cashSessionId)
  await uow.audit.record({
    action: 'till.cash_session.adjust',
    entityType: 'cash_session_adjustment',
    entityId: adjustment.id,
    operation: 'create',
    ...(corrected === null ? {} : { before: corrected }),
    after: adjustment,
  })
  await uow.publish({
    eventType: 'till.cash_session.adjusted',
    aggregateType: 'cash_session',
    aggregateId: adjustment.cashSessionId,
    payload: {
      adjustmentId: adjustment.id,
      adjustmentNo: adjustment.adjustmentNo,
      tradingDate: adjustment.tradingDate,
      amountFils: adjustment.amountFils,
      journalEntryId: adjustment.journalEntryId,
    },
    idempotencyKey: `till.cash_session.adjusted:${adjustment.cashSessionId}:${adjustment.adjustmentNo}`,
  })
  return adjustment
}

/** Every correction against one session, oldest first. */
export async function readCashSessionAdjustments(
  sql: Sql,
  cashSessionId: string,
): Promise<readonly PostedCashSessionAdjustment[]> {
  const rows = await sql<
    {
      id: string
      cash_session_id: string
      adjustment_no: number
      trading_date: string
      amount_fils: string
      reason: string
      journal_entry_id: string
    }[]
  >`
    select id, cash_session_id, adjustment_no, trading_date::text as trading_date, amount_fils,
           reason, journal_entry_id
      from cash_session_adjustment
     where cash_session_id = ${cashSessionId}::uuid
     order by adjustment_no
  `
  return rows.map((row) => ({
    id: row.id,
    cashSessionId: row.cash_session_id,
    adjustmentNo: row.adjustment_no,
    tradingDate: row.trading_date,
    amountFils: fils(row.amount_fils, 'amount_fils'),
    reason: row.reason,
    journalEntryId: row.journal_entry_id,
  }))
}

/** Every drop against one session, oldest first. */
export async function readCashDrops(
  sql: Sql,
  cashSessionId: string,
): Promise<readonly RecordedCashDrop[]> {
  const rows = await sql<
    {
      id: string
      cash_session_id: string
      drop_no: number
      amount_fils: string
      destination_account_code: string
      reference: string | null
      reason: string
      journal_entry_id: string
    }[]
  >`
    select id, cash_session_id, drop_no, amount_fils, destination_account_code, reference, reason,
           journal_entry_id
      from cash_drop where cash_session_id = ${cashSessionId}::uuid order by drop_no
  `
  return rows.map((row) => ({
    id: row.id,
    cashSessionId: row.cash_session_id,
    dropNo: row.drop_no,
    amountFils: fils(row.amount_fils, 'amount_fils'),
    destinationAccountCode: row.destination_account_code,
    reference: row.reference,
    reason: row.reason,
    journalEntryId: row.journal_entry_id,
  }))
}

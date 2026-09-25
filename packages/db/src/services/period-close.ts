import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import {
  type JournalLineInput,
  lockAccountingPeriod,
  type PeriodLockRow,
  type PostedJournalEntry,
  postJournalEntry,
  readJournalEntry,
} from '../repositories/journal.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Closing a period, and posting a correction into the next open one (M-VAT-06).
 *
 * ## The two questions a later unit asks this module
 *
 * **"Is this period closed?"** — {@link periodStatusOn}. One call, three answers: whether the date is
 * inside a lock, which period that is, and the earliest date that is open. A caller that needs only the
 * first should still use this one, because the second and third are what it needs the moment the answer
 * is yes, and reading them separately is how two callers come to disagree about which period a date is
 * in. It delegates to `period_lock_for()` and `earliest_open_date_from()`, which is what every guard in
 * the database calls, so a screen cannot answer differently from the trigger that refuses the posting.
 *
 * **"How do I correct something in a closed period?"** — {@link postDatedCorrection}. Never by editing:
 * `journal_entry` and `journal_line` refuse UPDATE and DELETE for every role including the owner
 * (ZL001), and `invoice` and `credit_note` do the same (ZI003, ZD009). A correction is a new entry that
 * undoes the old one on a date in the next OPEN period, and that function is the one that knows which
 * date that is.
 *
 * ## Why the close preconditions live in the database, and what is left here
 *
 * `0073_period_close.sql` gives `period_lock` a BEFORE INSERT trigger raising ZE001 when the trial
 * balance does not balance and ZE002 when a document dated in the period is not in the ledger. The
 * trigger is the authority, for the reason the migration states at length: a close that only this
 * module checks is a close that `psql` performs, and `lockAccountingPeriod` is not the only caller of
 * that table.
 *
 * What {@link closeAccountingPeriod} adds is the part a trigger cannot give a caller. ZE002's message
 * names ten documents and counts the rest, because an error string has to be bounded; this reads
 * {@link periodCloseBlockers} first and puts the whole list in the `AppError`'s details as DATA, so a
 * screen can render it and a caller can act on it without parsing a sentence. It is not a second
 * statement of the rule — it calls the same `period_close_blocker()` function the trigger calls — which
 * is the distinction `packages/db/src/repositories/journal.ts` draws when it refuses to pre-check the
 * balance invariant in TypeScript.
 */

/** The SQLSTATEs `0073_period_close.sql` raises. Class 'ZE'; 'ZP' is 0056's (consent). */
export const PERIOD_CLOSE_SQLSTATE = {
  /** The trial balance as at the period end does not balance. */
  willNotBalance: 'ZE001',
  /** A document dated inside the period is not in the ledger. */
  hasUnpostedDocuments: 'ZE002',
} as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const sqlState = (err: unknown): string | null => {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

const assertIsoDate = (value: string, what: string): void => {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${what} must be an ISO business day (YYYY-MM-DD), got "${value}"`,
    )
  }
}

/**
 * Translates a period-close failure into an `AppError`, or `null` if it is not one of ours.
 *
 * Both refusals are `conflict` and not `validation`: the request is well formed and the books are not
 * ready. A caller that treated them as validation would present them as "you typed something wrong",
 * and the person reading that would change the dates rather than post the missing document.
 */
export function periodCloseError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case PERIOD_CLOSE_SQLSTATE.willNotBalance:
    case PERIOD_CLOSE_SQLSTATE.hasUnpostedDocuments:
      return new AppError('conflict', message, { details: { sqlState: code } })
    default:
      return null
  }
}

// --- reading the state of a period ---------------------------------------------------------------

export interface PeriodLockStatus {
  readonly on: string
  readonly closed: boolean
  /** The `period_id` of the lock covering `on`, or `null` when it is open. */
  readonly periodId: string | null
  /**
   * The first date on or after `on` that no lock covers.
   *
   * Equal to `on` when the date is open. A DATE and not a period identifier, because `period_lock`
   * holds the CLOSED periods — an open period is the absence of a row and has no id (0072's argument).
   */
  readonly earliestOpenDate: string
}

/**
 * Whether `on` is inside a closed period, which one, and where a posting may go instead.
 *
 * One round trip and one statement of the answer. Both figures come from the SQL functions the BEFORE
 * INSERT guards on `journal_entry` and `journal_line` call, so this cannot disagree with the refusal a
 * posting would get.
 */
export async function periodStatusOn(sql: Sql, on: string): Promise<PeriodLockStatus> {
  assertIsoDate(on, 'on')
  const [row] = await sql<{ period_id: string | null; earliest_open: string }[]>`
    select period_lock_for(${on}::date)                as period_id,
           earliest_open_date_from(${on}::date)::text  as earliest_open
  `
  if (!row) {
    throw new AppError('invariant_violated', `period status query returned no row for ${on}`)
  }
  return {
    on,
    closed: row.period_id !== null,
    periodId: row.period_id,
    earliestOpenDate: row.earliest_open,
  }
}

/** The first date on or after `from` that no lock covers. `earliest_open_date_from()` in 0072. */
export async function earliestOpenDateFrom(sql: Sql, from: string): Promise<string> {
  return (await periodStatusOn(sql, from)).earliestOpenDate
}

// --- can this period be closed? ------------------------------------------------------------------

export interface UnpostedDocument {
  readonly documentKind: string
  readonly documentId: string
  /** The number printed on the document: `TI-2026-00001`, `CN-2026-00004`. */
  readonly documentLabel: string
  readonly documentDate: string
}

export interface PeriodCloseReadiness {
  readonly startsOn: string
  readonly endsOn: string
  /**
   * `debits - credits` as at `endsOn`, in integer fils. A `bigint` for `trial-balance.ts`'s recorded
   * reason: a ledger holding 2^53 + 1 fils on each side reported a difference of -4 fils out of
   * nothing when the two sides were rounded independently, and this is the figure a close is refused
   * on.
   */
  readonly differenceFils: bigint
  /** Every document dated in the range that the ledger does not account for. */
  readonly unpostedDocuments: readonly UnpostedDocument[]
  readonly closeable: boolean
}

/**
 * Everything that stands between this period and a close, read in one round trip.
 *
 * The whole list of stragglers, not the ten ZE002's message can carry. A caller that wants to offer
 * "post these first" needs all of them.
 */
export async function periodCloseBlockers(
  sql: Sql,
  range: { readonly startsOn: string; readonly endsOn: string },
): Promise<PeriodCloseReadiness> {
  assertIsoDate(range.startsOn, 'startsOn')
  assertIsoDate(range.endsOn, 'endsOn')
  if (range.endsOn < range.startsOn) {
    throw new AppError(
      'validation',
      `A period ends (${range.endsOn}) before it starts (${range.startsOn})`,
    )
  }

  const [difference] = await sql<{ difference_fils: string }[]>`
    select period_trial_balance_difference_fils(${range.endsOn}::date)::text as difference_fils
  `
  const unposted = await sql<
    {
      document_kind: string
      document_id: string
      document_label: string
      document_date: string
    }[]
  >`
    select document_kind, document_id, document_label, document_date::text as document_date
    from period_close_blocker(${range.startsOn}::date, ${range.endsOn}::date)
  `

  // BigInt and not Number: `period_trial_balance_difference_fils` returns bigint, the driver hands it
  // back as a string precisely so nothing rounds it, and rounding it here would put the defect the
  // function was written with back.
  const differenceFils = BigInt(difference?.difference_fils ?? '0')
  const unpostedDocuments = unposted.map((row) => ({
    documentKind: row.document_kind,
    documentId: row.document_id,
    documentLabel: row.document_label,
    documentDate: row.document_date,
  }))

  return {
    startsOn: range.startsOn,
    endsOn: range.endsOn,
    differenceFils,
    unpostedDocuments,
    closeable: differenceFils === 0n && unpostedDocuments.length === 0,
  }
}

/**
 * The content hash of the trial balance as at `asAt`.
 *
 * `period_trial_balance_hash()` in 0073, not a hash computed here. The acceptance is that recomputing
 * the period's trial balance later reproduces the hash byte for byte, and evidence only one program can
 * reproduce is evidence about the program: this way a `psql` session and a report written in five years
 * by something that is not this codebase both get the same answer.
 */
export async function trialBalanceHashAsAt(sql: Sql, asAt: string): Promise<string> {
  assertIsoDate(asAt, 'asAt')
  const [row] = await sql<{ hash: string }[]>`
    select period_trial_balance_hash(${asAt}::date) as hash
  `
  if (!row) {
    throw new AppError('invariant_violated', `trial balance hash query returned no row for ${asAt}`)
  }
  return row.hash
}

// --- closing ------------------------------------------------------------------------------------

export interface PeriodCloseInput {
  /** The identifier an accountant recognises: '2026-08', '2026-Q3'. It appears in every refusal. */
  readonly periodId: string
  readonly startsOn: string
  /** The last day **of** the period, not the first day after it. */
  readonly endsOn: string
  readonly reason: string
  readonly closedByActorKind: 'staff' | 'system'
  readonly closedByActorId?: string | null
}

export interface ClosedPeriod {
  readonly lock: PeriodLockRow
  /** The hash `period_trial_balance_hash(endsOn)` returned at the moment of the close. */
  readonly trialBalanceHash: string
  readonly readiness: PeriodCloseReadiness
}

/**
 * Closes a period: refuses it unless the books balance and every document in it is posted, then locks
 * it and records the evidence.
 *
 * ## Why the readiness is read before the INSERT, when the trigger checks it anyway
 *
 * For the error, and only for the error. ZE002 names up to ten documents because an unbounded list in
 * an error string is a message nothing can read and a log line nothing can store; this reads the whole
 * list first and hands it back in `details.unpostedDocuments` as rows. The rule is stated once — in
 * `period_close_blocker()` — and read twice, which is different from being expressed twice.
 *
 * The INSERT still runs against a database that re-checks, so a document posted by another transaction
 * between the read and the write cannot slip a stale answer through: whichever of the two is later
 * meets the trigger.
 *
 * ## Why there are two audit rows and not one
 *
 * `lockAccountingPeriod` writes `ledger.period.lock`, which says a lock row was inserted. This writes
 * `ledger.period.closed` as well, which says a period was CLOSED and carries the content hash of the
 * trial balance it was closed on. Two different facts: the first is a row's provenance, the second is
 * the evidence a return was filed against. Folding the hash into the first would put this unit's
 * evidence on every lock ever taken, including the ones no close produced — a migration correcting a
 * range, for instance — and an evidence hash that is sometimes about nothing is worse than none.
 *
 * The closer is named by the `AuditWriter` itself, from the `Actor` the unit of work was opened with:
 * `actor_kind`, `actor_id` and `actor_label` are columns on `audit_event`, so nothing here re-states
 * who it was.
 */
export async function closeAccountingPeriod(
  uow: UnitOfWork,
  input: PeriodCloseInput,
): Promise<ClosedPeriod> {
  const readiness = await periodCloseBlockers(uow.sql, input)

  if (readiness.differenceFils !== 0n) {
    throw new AppError(
      'conflict',
      `Cannot close accounting period "${input.periodId}" (${input.startsOn} to ${input.endsOn}); ` +
        `the trial balance as at ${input.endsOn} is out by ${readiness.differenceFils} fils. ` +
        'A period is filed on books that balance.',
      { details: { periodId: input.periodId, differenceFils: String(readiness.differenceFils) } },
    )
  }
  if (readiness.unpostedDocuments.length > 0) {
    throw new AppError(
      'conflict',
      `Cannot close accounting period "${input.periodId}" (${input.startsOn} to ${input.endsOn}); ` +
        `${readiness.unpostedDocuments.length} document(s) dated in it are not in the ledger: ` +
        `${readiness.unpostedDocuments.map((d) => `${d.documentKind} ${d.documentLabel}`).join(', ')}` +
        '. Post them or re-date them; a closed period cannot take them afterwards.',
      {
        details: {
          periodId: input.periodId,
          // The ids as DATA, which is the whole reason this function reads the blockers itself.
          unpostedDocuments: readiness.unpostedDocuments,
        },
      },
    )
  }

  // Taken BEFORE the lock and inside the same transaction, so it describes the ledger the close was
  // decided on. After the INSERT it would be the same figure — nothing in this transaction posts —
  // but the order says which of the two facts is the evidence for the other.
  const trialBalanceHash = await trialBalanceHashAsAt(uow.sql, input.endsOn)

  let lock: PeriodLockRow
  try {
    lock = await lockAccountingPeriod(uow, {
      periodId: input.periodId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      reason: input.reason,
      lockedByActorKind: input.closedByActorKind,
      lockedByActorId: input.closedByActorId ?? null,
    })
  } catch (err) {
    // `lockAccountingPeriod` already translates 23P01 into a `conflict` naming the overlap. ZE001 and
    // ZE002 reach here only when the trigger saw something the read above did not — a concurrent
    // posting, or a caller that reached this function with a stale transaction — so they are
    // translated rather than dropped, and the message is the trigger's own.
    throw periodCloseError(err) ?? err
  }

  await uow.audit.record({
    action: 'ledger.period.closed',
    entityType: 'period_lock',
    entityId: input.periodId,
    operation: 'create',
    after: {
      periodId: input.periodId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      reason: input.reason,
      trialBalanceAsAt: input.endsOn,
      trialBalanceHash,
      // Zero by the time we get here, and recorded anyway: a reader five years from now wants to see
      // that it was checked, not to infer it from the close having happened.
      trialBalanceDifferenceFils: String(readiness.differenceFils),
    },
  })

  await uow.publish({
    eventType: 'ledger.period.closed',
    aggregateType: 'period_lock',
    aggregateId: input.periodId,
    payload: {
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      trialBalanceHash,
    },
    idempotencyKey: `ledger.period.closed:${input.periodId}`,
  })

  return { lock, trialBalanceHash, readiness }
}

// --- correcting ---------------------------------------------------------------------------------

export interface DatedCorrectionInput {
  /** The entry being corrected. It is read back here, so a caller cannot misreport its date. */
  readonly reversesEntryId: string
  /** The id for the reversing entry. Allocated by the caller; core's `reversalEntryId` is one way. */
  readonly entryId: string
  readonly narrative: string
  /**
   * The reversing lines: `reverseEntry` from `@berelax/core`, mapped field for field.
   *
   * Built by the caller and not here, because `packages/db` may not import `packages/core` and the
   * swap is core's `reverseEntry` — the one place that knows a reversal's amounts are the original's
   * and never re-derived. A reversal whose figures were recomputed here could round differently from
   * the entry it undoes and leave a residue nothing can trace to a transaction.
   */
  readonly lines: readonly JournalLineInput[]
  /**
   * The earliest date the correction may carry, normally the trading date the correction was decided
   * on. The posting date is the first OPEN date on or after both this and the original's own date.
   *
   * Omitted, the correction goes as early as it may: the original's own date if that period is still
   * open, otherwise the first open date after it.
   */
  readonly notBefore?: string | null
}

export interface PostedCorrection {
  readonly entry: PostedJournalEntry
  /** The entry it corrects, as it was read back — unchanged, because nothing can change it. */
  readonly corrects: PostedJournalEntry
  /**
   * The period that pushed the correction forward, or `null` when it went in on the date asked for.
   * A caller shows this: "August is filed, so this correction is dated 1 October".
   */
  readonly deferredFromPeriodId: string | null
}

/**
 * Posts a dated reversal into the first open period at or after the entry it corrects.
 *
 * The date is computed here and not accepted from the caller, and that is the point of the function.
 * Two cases decide it, and they are the same computation:
 *
 *   - **the original's period has since closed.** `earliest_open_date_from(original.entry_date)` walks
 *     past the lock, and past any lock adjacent to it, to the first open day. Walking past ADJACENT
 *     locks is what makes the answer usable: a business that filed August and September must be told
 *     October, not September.
 *   - **the correction's own intended date has closed.** Same walk, from the later of the two dates.
 *     A correction decided in November for an August entry, with November filed, goes into December.
 *
 * A caller that passed a date itself would eventually pass one inside a lock, and `journal_entry`'s
 * BEFORE INSERT guard would refuse it with ZL002 — correct, and a refusal where a correct posting was
 * available. So the one thing a correction must not get wrong is not left to the caller.
 */
export async function postDatedCorrection(
  uow: UnitOfWork,
  input: DatedCorrectionInput,
): Promise<PostedCorrection> {
  const corrects = await readJournalEntry(uow.sql, input.reversesEntryId)
  if (!corrects) {
    throw new AppError(
      'not_found',
      `Cannot correct entry "${input.reversesEntryId}": no such journal entry.`,
      { details: { reversesEntryId: input.reversesEntryId } },
    )
  }
  if (input.notBefore != null) assertIsoDate(input.notBefore, 'notBefore')

  // `YYYY-MM-DD` compares and sorts as a string, which is why there is no date arithmetic here.
  const from =
    input.notBefore != null && input.notBefore > corrects.entryDate
      ? input.notBefore
      : corrects.entryDate

  const status = await periodStatusOn(uow.sql, from)
  const on = status.earliestOpenDate

  const entry = await postJournalEntry(uow, {
    entryId: input.entryId,
    entryDate: on,
    narrative: input.narrative,
    source: 'reversal',
    reverses: input.reversesEntryId,
    lines: input.lines,
  })

  return { entry, corrects, deferredFromPeriodId: status.closed ? status.periodId : null }
}

import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The posting repository: the only write path into the journal.
 *
 * ## Why every write takes a UnitOfWork
 *
 * `postJournalEntry` and `lockAccountingPeriod` take a {@link UnitOfWork}, never a pool. Three things
 * have to be durable together or not at all — the rows, the `audit_event` row that says who posted
 * them, and the outbox event that tells the rest of the system. An audit row for a posting that rolled
 * back is as bad as a posting with no audit row, and the second one is what an investigation cannot
 * recover from. There is no overload that accepts a connection, because the compiling-but-wrong call
 * is the one worth making impossible.
 *
 * ## What before/after means for an append-only table
 *
 * Every write here records an `audit_event` in the same transaction (F06). For a fresh posting the
 * `before` state is **absent**, because there was none — a fabricated one would be a record of
 * something that never existed. For a **reversal** the prior state is real: the entry being corrected,
 * read back inside the same transaction, so the audit row holds the pair an investigation needs.
 *
 * ## Why there is no update, no delete and no void
 *
 * The journal is append-only (ADR 0017). A wrong entry is answered by a **dated reversal** — build it
 * with `reverseEntry` from @berelax/core, post it through this same function with `reverses` set, and
 * then post the correct entry. The export surface of this module is asserted by `journal.itest.ts`: a
 * function named `updateJournalEntry` would fail the build, which is the point of asserting it.
 *
 * ## Why the balance invariant is not checked here
 *
 * It is checked by a **deferred constraint trigger** in `0018_ledger.sql`, at COMMIT. A TypeScript
 * pre-check would be a third statement of the same rule (core's `postEntry` is the first, the trigger
 * the second), and three statements of one rule is two opportunities to disagree. It also could not be
 * the authority: this repository is not the only thing that can reach a `psql` prompt.
 *
 * The practical consequence is that an unbalanced posting fails at COMMIT — *outside* any function in
 * this module, because the COMMIT belongs to `withUnitOfWork`. So the SQLSTATE translation is exported
 * as {@link journalError} for a caller to apply around its own transaction, rather than hidden in a
 * catch block that can never see the error.
 *
 * ## Why these types do not use @berelax/core's
 *
 * `packages/db` must never import `packages/core` — the dependency runs the other way. So the inputs
 * here are structural mirrors of core's `JournalEntry`: `Money` becomes integer `debitFils`/
 * `creditFils`, `LocalDate` becomes an ISO `YYYY-MM-DD` string, and the branded `EntryId` becomes a
 * string. A caller that holds a core `JournalEntry` maps it field for field; the pair is exercised
 * together in `packages/fixtures`, which is the package allowed to depend on both.
 */

/**
 * The SQLSTATEs `0018_ledger.sql` raises.
 *
 * Custom codes rather than repurposed standard ones, because a caller has to tell these three apart
 * and the alternative is matching on message text — which stops working silently the first time
 * somebody improves the wording, and the code that then treats a locked period as an unknown failure
 * is the code that retries it. Class 'ZL' is unused by PostgreSQL and reserved by the standard for
 * user-defined conditions.
 */
export const JOURNAL_SQLSTATE = {
  /** A journal row was UPDATEd or DELETEd. */
  appendOnly: 'ZL001',
  /** The entry date falls inside a locked accounting period. */
  periodLocked: 'ZL002',
  /** Debits and credits do not agree, or the entry has fewer than two lines. Raised at COMMIT. */
  unbalancedEntry: 'ZL003',
} as const

/** `23P01`: two period locks would overlap, so "which period locks this date" would be ambiguous. */
const EXCLUSION_VIOLATION = '23P01'
/** `23503`: an entry referenced an account code the chart does not contain. */
const FOREIGN_KEY_VIOLATION = '23503'
/** `42501`: the application role holds no such privilege. This is the grant layer refusing. */
const INSUFFICIENT_PRIVILEGE = '42501'

/**
 * The SQLSTATE an error carries.
 *
 * Read from the driver's `code`, and failing that from a `details.sqlState` an earlier translation
 * already put there. That second branch makes {@link journalError} idempotent, which matters because
 * these errors are translated twice on the one path that counts: `postJournalEntry` translates what it
 * can see, and the caller wraps the whole transaction to catch the deferred failure from COMMIT. A
 * translation that re-classified an already-translated error as "not one of ours" would turn a locked
 * period back into an unknown failure at the outermost layer, which is where it gets retried.
 */
const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a PostgreSQL error raised by the ledger schema into an `AppError`, or returns `null` if
 * it is not one of ours.
 *
 * Exported because the failure a caller most needs to recognise — an unbalanced entry — arrives from
 * `COMMIT`, which no function in this module executes. A caller wraps its `withUnitOfWork` call:
 *
 * ```ts
 * try {
 *   await withUnitOfWork(sql, actor, (uow) => postJournalEntry(uow, entry))
 * } catch (err) {
 *   throw journalError(err) ?? err
 * }
 * ```
 *
 * The match is on SQLSTATE only. Matching on the message would make the translation depend on
 * wording, and this is precisely the code path where an unrecognised failure gets retried.
 */
export function journalError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case JOURNAL_SQLSTATE.appendOnly:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case JOURNAL_SQLSTATE.periodLocked:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case JOURNAL_SQLSTATE.unbalancedEntry:
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case EXCLUSION_VIOLATION:
      return new AppError('conflict', `Overlapping accounting period lock: ${message}`, {
        details: { sqlState: code },
      })
    case INSUFFICIENT_PRIVILEGE:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    default:
      return null
  }
}

/** True when `err` is the append-only refusal. Used by callers that offer to build a reversal. */
export function isAppendOnlyViolation(err: unknown): boolean {
  return sqlState(err) === JOURNAL_SQLSTATE.appendOnly
}

/** True when `err` is a period lock. The only correct response is a reversal in an open period. */
export function isPeriodLocked(err: unknown): boolean {
  return sqlState(err) === JOURNAL_SQLSTATE.periodLocked
}

/** True when `err` is the deferred balance failure. It arrives from COMMIT, never from an INSERT. */
export function isUnbalancedEntry(err: unknown): boolean {
  return sqlState(err) === JOURNAL_SQLSTATE.unbalancedEntry
}

// --- the chart of accounts ---------------------------------------------------------------------

/** The provisional marker, carried as data so a reader of the database can see it. */
export interface StoredProvisionalMarker {
  readonly openQuestionId: string
  readonly note: string
}

export interface StoredAccount {
  readonly code: string
  readonly name: string
  readonly type: string
  readonly normalBalance: string
  readonly contra: boolean
  /** `null` means "feeds no VAT201 grouping", decided. It never means "not yet classified". */
  readonly vatBox: string | null
  readonly inputVatRecoverable: boolean
}

/** Shaped to compare field for field against `ChartOfAccounts` in @berelax/core. */
export interface StoredChartOfAccounts {
  readonly id: string
  readonly provisional: StoredProvisionalMarker | null
  readonly accounts: readonly StoredAccount[]
}

interface AccountRow {
  readonly code: string
  readonly name: string
  readonly type: string
  readonly normal_balance: string
  readonly contra: boolean
  readonly vat_box: string | null
  readonly input_vat_recoverable: boolean
}

/**
 * Reads a whole chart back, in code order.
 *
 * Ordered by code, not by insertion, so the comparison against the core chart and any exported
 * working paper are stable across two runs. `packages/fixtures/src/ledger-chart.itest.ts` feeds the
 * result through core's own `defineAccount`, which is what proves a row read out of Postgres is still
 * a valid account and not merely a shape with the right column names.
 */
export async function readChartOfAccounts(
  sql: Sql,
  chartId: string,
): Promise<StoredChartOfAccounts | null> {
  const [chart] = await sql<
    { id: string; provisional_open_question_id: string | null; provisional_note: string | null }[]
  >`
    select id, provisional_open_question_id, provisional_note
    from chart_of_accounts where id = ${chartId}
  `
  if (!chart) return null

  const rows = await sql<AccountRow[]>`
    select code, name, type, normal_balance, contra, vat_box, input_vat_recoverable
    from account where chart_id = ${chartId} order by code
  `

  return {
    id: chart.id,
    provisional:
      chart.provisional_open_question_id === null || chart.provisional_note === null
        ? null
        : { openQuestionId: chart.provisional_open_question_id, note: chart.provisional_note },
    accounts: rows.map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      normalBalance: r.normal_balance,
      contra: r.contra,
      vatBox: r.vat_box,
      inputVatRecoverable: r.input_vat_recoverable,
    })),
  }
}

// --- posting -----------------------------------------------------------------------------------

export interface JournalLineInput {
  readonly accountCode: string
  /** Integer fils. Exactly one of the two is non-zero: direction is the side, never the sign. */
  readonly debitFils: number
  readonly creditFils: number
  readonly memo?: string | null
}

export interface JournalEntryInput {
  /** Allocated by the caller. @berelax/core never invents one. */
  readonly entryId: string
  /**
   * The **business day**, as `YYYY-MM-DD`, already resolved with `resolveTradingDate`.
   *
   * Trading runs 11:00–02:00, so a 01:30 sale belongs to the previous trading date. Taking this from
   * an ambient clock would file the late sale under tomorrow's takings and, at a period boundary, into
   * a period that has already been filed.
   */
  readonly entryDate: string
  readonly narrative: string
  readonly source: string
  /** The entry this one reverses. Set only for a reversal built by core's `reverseEntry`. */
  readonly reverses?: string | null
  readonly lines: readonly JournalLineInput[]
}

export interface PostedJournalLine {
  readonly lineNo: number
  readonly accountCode: string
  readonly debitFils: number
  readonly creditFils: number
  readonly currency: string
  readonly memo: string | null
}

export interface PostedJournalEntry {
  readonly entryId: string
  readonly entryDate: string
  readonly narrative: string
  readonly source: string
  readonly currency: string
  readonly reverses: string | null
  readonly postedAt: Date
  readonly lines: readonly PostedJournalLine[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertPostable(input: JournalEntryInput): void {
  if (!ISO_DATE.test(input.entryDate)) {
    throw new AppError(
      'validation',
      `entryDate must be an ISO business day (YYYY-MM-DD), received "${input.entryDate}"`,
    )
  }
  if (input.lines.length < 2) {
    // Structural, not arithmetic: the deferred trigger would also catch this, but at COMMIT and after
    // the audit row and the outbox event have been written for a posting that never existed.
    throw new AppError(
      'validation',
      `Entry "${input.entryId}" has ${input.lines.length} line(s). A double entry needs at least two.`,
    )
  }
  for (const [index, line] of input.lines.entries()) {
    const positionalId = `${input.entryId} line ${index + 1}`
    if (!Number.isInteger(line.debitFils) || !Number.isInteger(line.creditFils)) {
      // Half a fils in a journal cannot be reconciled by anyone, and the discrepancy surfaces during
      // a VAT return, by which point it is history. The `fils_nonneg` domain is bigint, so Postgres
      // would round a fractional value rather than refuse it.
      throw new AppError(
        'validation',
        `${positionalId} has a fractional amount (${line.debitFils}/${line.creditFils} fils)`,
      )
    }
    if (line.debitFils < 0 || line.creditFils < 0) {
      throw new AppError(
        'validation',
        `${positionalId} has a negative amount. Direction is expressed by the side, not by the sign.`,
      )
    }
    if ((line.debitFils === 0) === (line.creditFils === 0)) {
      throw new AppError(
        'validation',
        `${positionalId} must carry a non-zero amount on exactly one side, not ` +
          `debit ${line.debitFils} and credit ${line.creditFils}`,
      )
    }
  }
}

/**
 * Appends one entry and its lines, inside `uow`'s transaction, and records both the audit row and the
 * domain event in the same transaction.
 *
 * Lines are inserted one statement at a time on purpose: that is the shape a posting rule produces,
 * and it is the shape the deferred balance trigger exists to allow. Batching them into one INSERT
 * would make an immediate trigger appear to work, and the first caller to loop would then discover
 * otherwise.
 *
 * A period lock and an unknown account code are refused synchronously, so they are translated here. An
 * unbalanced entry is refused at COMMIT — see {@link journalError}.
 */
export async function postJournalEntry(
  uow: UnitOfWork,
  input: JournalEntryInput,
): Promise<PostedJournalEntry> {
  assertPostable(input)

  let postedAt: Date
  try {
    const [entry] = await uow.sql<{ posted_at: Date }[]>`
      insert into journal_entry (entry_id, entry_date, narrative, source, reverses)
      values (
        ${input.entryId},
        ${input.entryDate}::date,
        ${input.narrative},
        ${input.source},
        ${input.reverses ?? null}
      )
      returning posted_at
    `
    if (!entry) {
      throw new AppError(
        'invariant_violated',
        `journal_entry insert returned no row for "${input.entryId}"`,
      )
    }
    postedAt = entry.posted_at

    for (const [index, line] of input.lines.entries()) {
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils, memo)
        values (
          ${input.entryId},
          ${index + 1},
          ${line.accountCode},
          ${line.debitFils},
          ${line.creditFils},
          ${line.memo ?? null}
        )
      `
    }
  } catch (err) {
    if (sqlState(err) === FOREIGN_KEY_VIOLATION) {
      throw new AppError(
        'validation',
        `Entry "${input.entryId}" references an account or entry the database does not have: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { details: { sqlState: FOREIGN_KEY_VIOLATION } },
      )
    }
    throw journalError(err) ?? err
  }

  const posted: PostedJournalEntry = {
    entryId: input.entryId,
    entryDate: input.entryDate,
    narrative: input.narrative,
    source: input.source,
    currency: 'AED',
    reverses: input.reverses ?? null,
    postedAt,
    lines: input.lines.map((line, index) => ({
      lineNo: index + 1,
      accountCode: line.accountCode,
      debitFils: line.debitFils,
      creditFils: line.creditFils,
      currency: 'AED',
      memo: line.memo ?? null,
    })),
  }

  // `before` is the entry being corrected, for a reversal, and absent for a fresh posting.
  //
  // That asymmetry is the honest one. An append-only insert has no prior state, and a fabricated
  // `before` would be a record of something that never existed. A REVERSAL does have one — the entry
  // it undoes — and that pair is the whole content of the audit row an investigation reads: what was
  // posted, and what it corrected. Reading the original inside this transaction rather than trusting
  // the caller to pass it means the recorded `before` is what the journal actually holds.
  const before =
    input.reverses === undefined || input.reverses === null
      ? undefined
      : ((await readJournalEntry(uow.sql, input.reverses)) ?? undefined)

  await uow.audit.record({
    action: 'ledger.entry.post',
    entityType: 'journal_entry',
    entityId: input.entryId,
    operation: 'create',
    ...(before === undefined ? {} : { before }),
    after: posted,
  })

  await uow.publish({
    eventType: 'ledger.entry.posted',
    aggregateType: 'journal_entry',
    aggregateId: input.entryId,
    payload: {
      entryDate: posted.entryDate,
      source: posted.source,
      reverses: posted.reverses,
      lineCount: posted.lines.length,
      debitFils: posted.lines.reduce((total, line) => total + line.debitFils, 0),
    },
    // Derived from the business fact, so a retry of the same posting cannot enqueue twice.
    idempotencyKey: `ledger.entry.posted:${input.entryId}`,
  })

  return posted
}

interface LineRow {
  readonly line_no: number
  readonly account_code: string
  readonly debit_fils: string
  readonly credit_fils: string
  readonly currency: string
  readonly memo: string | null
}

/** Reads one entry with its lines in `line_no` order, or `null`. */
export async function readJournalEntry(
  sql: Sql,
  entryId: string,
): Promise<PostedJournalEntry | null> {
  const [entry] = await sql<
    {
      entry_id: string
      entry_date: string
      narrative: string
      source: string
      currency: string
      reverses: string | null
      posted_at: Date
    }[]
  >`
    select entry_id, entry_date::text as entry_date, narrative, source, currency, reverses, posted_at
    from journal_entry where entry_id = ${entryId}
  `
  if (!entry) return null

  const lines = await sql<LineRow[]>`
    select line_no, account_code, debit_fils, credit_fils, currency, memo
    from journal_line where entry_id = ${entryId} order by line_no
  `

  return {
    entryId: entry.entry_id,
    entryDate: entry.entry_date,
    narrative: entry.narrative,
    source: entry.source,
    currency: entry.currency,
    reverses: entry.reverses,
    postedAt: entry.posted_at,
    // The driver returns bigint as a string so a fils amount cannot lose precision in transit;
    // Number() is applied once, here, where the value re-enters TypeScript.
    lines: lines.map((line) => ({
      lineNo: line.line_no,
      accountCode: line.account_code,
      debitFils: Number(line.debit_fils),
      creditFils: Number(line.credit_fils),
      currency: line.currency,
      memo: line.memo,
    })),
  }
}

export interface AccountBalanceRow {
  readonly accountCode: string
  readonly debitFils: number
  readonly creditFils: number
}

/**
 * Debit and credit totals per account over an inclusive `entry_date` window.
 *
 * The signing — a balance positive in the account's own normal-balance direction — is deliberately
 * *not* done here. That is `trialBalance` in @berelax/core, which this package may not import, and
 * doing it twice is how a balance sheet ends up showing a negative gratuity liability in one report
 * and a positive one in another.
 */
export async function accountTotals(
  sql: Sql,
  window: { readonly from?: string; readonly to?: string } = {},
): Promise<readonly AccountBalanceRow[]> {
  const rows = await sql<{ account_code: string; debit_fils: string; credit_fils: string }[]>`
    select l.account_code,
           coalesce(sum(l.debit_fils), 0)  as debit_fils,
           coalesce(sum(l.credit_fils), 0) as credit_fils
    from journal_line l
    join journal_entry e on e.entry_id = l.entry_id
    where (${window.from ?? null}::date is null or e.entry_date >= ${window.from ?? null}::date)
      and (${window.to ?? null}::date is null or e.entry_date <= ${window.to ?? null}::date)
    group by l.account_code
    order by l.account_code
  `
  return rows.map((r) => ({
    accountCode: r.account_code,
    debitFils: Number(r.debit_fils),
    creditFils: Number(r.credit_fils),
  }))
}

// --- period locks ------------------------------------------------------------------------------

export interface PeriodLockInput {
  /** The identifier an accountant recognises: '2026-08', '2026-Q3'. It appears in the refusal. */
  readonly periodId: string
  readonly startsOn: string
  /** The last day **of** the period, not the first day after it. */
  readonly endsOn: string
  readonly reason: string
  readonly lockedByActorKind: 'staff' | 'system'
  readonly lockedByActorId?: string | null
}

export interface PeriodLockRow {
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  readonly reason: string
  readonly lockedAt: Date
  readonly lockedByActorKind: string
  readonly lockedByActorId: string | null
}

/**
 * Closes a period. Audited and published in the same transaction, like any other write.
 *
 * There is no `unlockAccountingPeriod`, and that is the point: the application role holds no UPDATE or
 * DELETE on `period_lock`. Reopening a period whose return has been filed is a decision somebody makes
 * with an accountant, not something a code path does.
 */
export async function lockAccountingPeriod(
  uow: UnitOfWork,
  input: PeriodLockInput,
): Promise<PeriodLockRow> {
  if (!ISO_DATE.test(input.startsOn) || !ISO_DATE.test(input.endsOn)) {
    throw new AppError(
      'validation',
      `A period lock needs ISO dates (YYYY-MM-DD), received "${input.startsOn}".."${input.endsOn}"`,
    )
  }
  if (input.endsOn < input.startsOn) {
    throw new AppError(
      'validation',
      `Period "${input.periodId}" ends (${input.endsOn}) before it starts (${input.startsOn})`,
    )
  }

  let row: PeriodLockRow
  try {
    const [inserted] = await uow.sql<
      {
        period_id: string
        starts_on: string
        ends_on: string
        reason: string
        locked_at: Date
        locked_by_actor_kind: string
        locked_by_actor_id: string | null
      }[]
    >`
      insert into period_lock (
        period_id, starts_on, ends_on, reason, locked_by_actor_kind, locked_by_actor_id
      ) values (
        ${input.periodId},
        ${input.startsOn}::date,
        ${input.endsOn}::date,
        ${input.reason},
        ${input.lockedByActorKind},
        ${input.lockedByActorId ?? null}
      )
      returning period_id, starts_on::text as starts_on, ends_on::text as ends_on, reason,
                locked_at, locked_by_actor_kind, locked_by_actor_id
    `
    if (!inserted) {
      throw new AppError(
        'invariant_violated',
        `period_lock insert returned no row for "${input.periodId}"`,
      )
    }
    row = {
      periodId: inserted.period_id,
      startsOn: inserted.starts_on,
      endsOn: inserted.ends_on,
      reason: inserted.reason,
      lockedAt: inserted.locked_at,
      lockedByActorKind: inserted.locked_by_actor_kind,
      lockedByActorId: inserted.locked_by_actor_id,
    }
  } catch (err) {
    throw journalError(err) ?? err
  }

  await uow.audit.record({
    action: 'ledger.period.lock',
    entityType: 'period_lock',
    entityId: input.periodId,
    operation: 'create',
    after: row,
  })

  await uow.publish({
    eventType: 'ledger.period.locked',
    aggregateType: 'period_lock',
    aggregateId: input.periodId,
    payload: { startsOn: row.startsOn, endsOn: row.endsOn, reason: row.reason },
    idempotencyKey: `ledger.period.locked:${input.periodId}`,
  })

  return row
}

/**
 * The `period_id` locking `date`, or `null`.
 *
 * Delegates to the `period_lock_for()` SQL function rather than re-expressing the range comparison,
 * so a report that asks "is this closed" cannot answer differently from the trigger that refuses the
 * posting.
 */
export async function periodLockFor(sql: Sql, date: string): Promise<string | null> {
  if (!ISO_DATE.test(date)) {
    throw new AppError('validation', `date must be an ISO business day (YYYY-MM-DD), got "${date}"`)
  }
  const [row] = await sql<{ period_id: string | null }[]>`
    select period_lock_for(${date}::date) as period_id
  `
  return row?.period_id ?? null
}

export async function listPeriodLocks(sql: Sql): Promise<readonly PeriodLockRow[]> {
  const rows = await sql<
    {
      period_id: string
      starts_on: string
      ends_on: string
      reason: string
      locked_at: Date
      locked_by_actor_kind: string
      locked_by_actor_id: string | null
    }[]
  >`
    select period_id, starts_on::text as starts_on, ends_on::text as ends_on, reason,
           locked_at, locked_by_actor_kind, locked_by_actor_id
    from period_lock order by starts_on
  `
  return rows.map((r) => ({
    periodId: r.period_id,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    reason: r.reason,
    lockedAt: r.locked_at,
    lockedByActorKind: r.locked_by_actor_kind,
    lockedByActorId: r.locked_by_actor_id,
  }))
}

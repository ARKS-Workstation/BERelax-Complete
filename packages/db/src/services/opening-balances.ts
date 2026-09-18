import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { type JournalLineInput, postJournalEntry } from '../repositories/journal.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The opening-balance import — the single entry a set of books starts from.
 *
 * This business is already trading, so its books do not start at zero on the day this system goes live.
 * They start at whatever the previous arrangement left behind, and that closing position becomes the
 * opening entry here. Every balance sheet the system ever produces is this entry plus everything since,
 * which is why the import is guarded three ways rather than one.
 */

/** One account's opening position. Exactly one side carries the amount; direction is the side. */
export interface OpeningBalanceLine {
  readonly accountCode: string
  readonly debitFils: number
  readonly creditFils: number
  readonly memo?: string | null
}

export interface OpeningBalanceImport {
  /** Always 1 today: `legal_entity` is a single-row table (0003). */
  readonly legalEntityId?: number
  /** The date the books open, `YYYY-MM-DD`. No posting may be dated earlier. */
  readonly openingDate: string
  readonly entryId: string
  readonly importedBy: string
  readonly lines: readonly OpeningBalanceLine[]
  /**
   * Y8-opening-balances. True while these are the build's assumption rather than the owner's figures,
   * which puts the row in the Unconfirmed Assumptions panel.
   */
  readonly isProvisional?: boolean
  readonly provisionalNote?: string | null
  readonly openQuestionId?: string | null
}

export interface ImportedOpeningBalances {
  readonly importId: string
  readonly entryId: string
  readonly openingDate: string
  readonly totalDebitFils: number
  readonly totalCreditFils: number
  readonly isProvisional: boolean
}

/** SQLSTATE the opening-date trigger in 0027 raises. */
export const OPENING_BALANCE_SQLSTATE = {
  beforeOpeningBalance: 'ZL004',
} as const

export function isBeforeOpeningBalance(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === OPENING_BALANCE_SQLSTATE.beforeOpeningBalance
  )
}

/**
 * Rejects an unbalanced import **before** anything is written, naming the difference in fils.
 *
 * The deferred trigger in 0018 would also catch it, at `COMMIT` — but by then the audit row and the
 * domain event have been written for a posting that never existed, and the error says "the entry does
 * not balance" without saying by how much. An opening balance is transcribed by hand from somebody
 * else's books; the number a person needs is the difference, because that is what they go looking for.
 */
export function openingImbalanceFils(lines: readonly OpeningBalanceLine[]): number {
  const debit = lines.reduce((sum, line) => sum + line.debitFils, 0)
  const credit = lines.reduce((sum, line) => sum + line.creditFils, 0)
  return debit - credit
}

function assertImportable(input: OpeningBalanceImport): void {
  if (input.lines.length === 0) {
    throw new AppError('validation', 'An opening-balance import needs at least one line')
  }
  for (const [index, line] of input.lines.entries()) {
    if (!Number.isInteger(line.debitFils) || !Number.isInteger(line.creditFils)) {
      throw new AppError(
        'validation',
        `Opening line ${index + 1} (${line.accountCode}) has a fractional amount. Fils are integers.`,
      )
    }
    if (line.debitFils < 0 || line.creditFils < 0) {
      throw new AppError(
        'validation',
        `Opening line ${index + 1} (${line.accountCode}) has a negative amount. ` +
          'Direction is expressed by the side, not by the sign.',
      )
    }
  }

  const difference = openingImbalanceFils(input.lines)
  if (difference !== 0) {
    const side = difference > 0 ? 'debits exceed credits' : 'credits exceed debits'
    throw new AppError(
      'invariant_violated',
      `Opening balances do not balance: ${side} by ${Math.abs(difference)} fils. ` +
        'The import was rejected and nothing was written.',
      { details: { differenceFils: difference } },
    )
  }

  if (input.isProvisional === true && (input.openQuestionId ?? '').trim() === '') {
    // Same rule as `app_setting` and `service_variant`: a provisional value names the question it is
    // waiting on, or the Unconfirmed Assumptions panel has a value and nothing to ask about it.
    throw new AppError(
      'validation',
      'A provisional opening-balance import must name its open question (openQuestionId)',
    )
  }
}

/**
 * Imports the opening balances. Once.
 *
 * The second import raises on the unique key rather than doubling every balance, and that ordering
 * matters: the entry is posted first and the import row second, so the guard in 0027 — which reads the
 * import row — cannot refuse the opening entry itself. A `unique_violation` from the second call leaves
 * the whole transaction rolled back, including its entry.
 */
export async function importOpeningBalances(
  uow: UnitOfWork,
  input: OpeningBalanceImport,
): Promise<ImportedOpeningBalances> {
  assertImportable(input)

  const lines: JournalLineInput[] = input.lines.map((line) => ({
    accountCode: line.accountCode,
    debitFils: line.debitFils,
    creditFils: line.creditFils,
    memo: line.memo ?? null,
  }))

  // `source: 'opening_balance'` is not decoration: it is what exempts this entry, and only this entry,
  // from the before-opening-date guard it is about to create.
  const posted = await postJournalEntry(uow, {
    entryId: input.entryId,
    entryDate: input.openingDate,
    narrative: `Opening balances as at ${input.openingDate}`,
    source: 'opening_balance',
    lines,
  })

  const totalDebitFils = lines.reduce((sum, line) => sum + line.debitFils, 0)
  const totalCreditFils = lines.reduce((sum, line) => sum + line.creditFils, 0)

  const [row] = (await uow.sql`
    insert into opening_balance_import (
      legal_entity_id, opening_date, entry_id,
      total_debit_fils, total_credit_fils,
      is_provisional, provisional_note, open_question_id, imported_by
    )
    values (
      ${input.legalEntityId ?? 1}, ${input.openingDate}::date, ${posted.entryId},
      ${totalDebitFils}, ${totalCreditFils},
      ${input.isProvisional ?? false}, ${input.provisionalNote ?? null}, ${input.openQuestionId ?? null},
      ${input.importedBy}
    )
    returning import_id::text
  `) as unknown as { import_id: string }[]
  if (row === undefined)
    throw new AppError('invariant_violated', 'The import insert returned no row')

  await uow.audit.record({
    action: 'opening_balances.imported',
    entityType: 'opening_balance_import',
    entityId: row.import_id,
    operation: 'create',
    after: {
      openingDate: input.openingDate,
      entryId: posted.entryId,
      totalDebitFils,
      lineCount: lines.length,
      isProvisional: input.isProvisional ?? false,
    },
  })

  return {
    importId: row.import_id,
    entryId: posted.entryId,
    openingDate: input.openingDate,
    totalDebitFils,
    totalCreditFils,
    isProvisional: input.isProvisional ?? false,
  }
}

/** The date the books open, or `null` before the import. */
export async function openingDate(sql: Sql, legalEntityId = 1): Promise<string | null> {
  const [row] = (await sql`
    select opening_date::text as opening_date
    from opening_balance_import
    where legal_entity_id = ${legalEntityId}
  `) as unknown as { opening_date: string }[]
  return row?.opening_date ?? null
}

/**
 * Provisional imports, for the Unconfirmed Assumptions panel.
 *
 * Separate from `unconfirmedAssumptions` in `settings-store.ts` because that reads `app_setting` and an
 * opening balance is not a setting — it is a posted journal entry. Both feed the same panel; the panel
 * is the one place an owner sees everything the build assumed, and an assumption that is only visible
 * in a table nobody opens is an assumption nobody will ever confirm.
 */
export async function provisionalOpeningBalances(sql: Sql): Promise<
  readonly {
    importId: string
    openingDate: string
    totalDebitFils: number
    openQuestionId: string | null
    note: string | null
  }[]
> {
  const rows = (await sql`
    select import_id::text, opening_date::text, total_debit_fils::text,
           open_question_id, provisional_note
    from opening_balance_import
    where is_provisional
    order by opening_date
  `) as unknown as {
    import_id: string
    opening_date: string
    total_debit_fils: string
    open_question_id: string | null
    provisional_note: string | null
  }[]
  return rows.map((row) => ({
    importId: row.import_id,
    openingDate: row.opening_date,
    totalDebitFils: Number(row.total_debit_fils),
    openQuestionId: row.open_question_id,
    note: row.provisional_note,
  }))
}

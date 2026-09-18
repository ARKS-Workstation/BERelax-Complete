import { AppError } from '@berelax/shared'
import { importOpeningBalances, type OpeningBalanceLine } from '../services/opening-balances.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The provisional opening balances: zeros, flagged, and visible.
 *
 * Y8-opening-balances is unanswered — nobody has supplied the figures the previous arrangement closed
 * at. The temptation is to seed nothing and let the books start empty, which produces exactly the same
 * database as a confirmed zero opening position and is therefore indistinguishable from a finished task.
 * So the zeros are posted, flagged `is_provisional` with their open question, and appear in the
 * Unconfirmed Assumptions panel until somebody replaces them.
 *
 * The consequence that makes this worth doing rather than skipping: posting the import also establishes
 * the opening **date**, and the opening date is what the before-opening guard in 0027 enforces. Without
 * it there is no date before which nothing may be posted, so a mistyped year on a bill lands in 2025 and
 * nothing objects.
 */

/** The provisional opening date. Flagged, like the figures. */
export const PROVISIONAL_OPENING_DATE = '2026-09-01'
export const OPENING_BALANCES_QUESTION = 'Y8-opening-balances'

/**
 * Two zero lines, not one.
 *
 * `journal_line_exactly_one_side` in 0018 requires exactly one side of a line to be non-zero, and
 * `postJournalEntry` refuses an entry with fewer than two lines — both correct, and together they mean a
 * literally empty opening entry cannot be expressed. A zero opening position is therefore one fils
 * debited to cash and one fils credited to owner's capital... which would not be zero.
 *
 * So the seed posts the smallest *balanced, non-vacuous* entry the ledger permits, and it is honest about
 * what it is: 0 fils is not representable, 1 fils is, and 1 fils of cash against 1 fils of proprietor's
 * equity is a statement that can be replaced wholesale by a dated reversal when the real figures arrive.
 * The alternative — relaxing the one-side-non-zero constraint so a zero line can exist — would let every
 * future posting path write a line somebody forgot to fill in.
 */
export const PROVISIONAL_OPENING_LINES: readonly OpeningBalanceLine[] = [
  {
    accountCode: '1010',
    debitFils: 1,
    creditFils: 0,
    memo: 'Provisional: Y8-opening-balances is unanswered. Replace by dated reversal.',
  },
  {
    accountCode: '3010',
    debitFils: 0,
    creditFils: 1,
    memo: 'Provisional: Y8-opening-balances is unanswered. Replace by dated reversal.',
  },
]

export async function seedProvisionalOpeningBalances(
  uow: UnitOfWork,
  options: { readonly openingDate?: string; readonly entryId?: string } = {},
): Promise<string> {
  const codes = PROVISIONAL_OPENING_LINES.map((line) => line.accountCode)
  const present = (await uow.sql`
    select code from account where code = any(${codes}::text[])
  `) as unknown as { code: string }[]
  if (present.length !== codes.length) {
    // The chart is M-TILL-02's seed. A missing code here means the seeds ran in the wrong order, and
    // failing loudly beats posting to whatever code happens to exist.
    const missing = codes.filter((code) => !present.some((row) => row.code === code))
    throw new AppError(
      'invariant_violated',
      `Opening balances reference account code(s) the chart does not have: ${missing.join(', ')}. ` +
        'Seed the chart of accounts (0018) first.',
    )
  }

  const imported = await importOpeningBalances(uow, {
    openingDate: options.openingDate ?? PROVISIONAL_OPENING_DATE,
    entryId: options.entryId ?? 'JE-OPENING-PROVISIONAL',
    importedBy: 'seed',
    lines: PROVISIONAL_OPENING_LINES,
    isProvisional: true,
    provisionalNote:
      'Zero opening balances. The previous arrangement’s closing position has not been supplied, ' +
      'so every balance sheet this system produces is currently the movement since ' +
      `${options.openingDate ?? PROVISIONAL_OPENING_DATE} and not a position.`,
    openQuestionId: OPENING_BALANCES_QUESTION,
  })
  return imported.importId
}

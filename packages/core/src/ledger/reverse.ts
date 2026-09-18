import { AppError } from '@berelax/shared'
import type { LocalDate } from '../time.ts'
import type { EntryId, JournalEntry, JournalLine } from './entry.ts'
import { creditTotalFils, debitTotalFils, UnbalancedEntry } from './entry.ts'

/**
 * Correction by dated reversal (ADR 0017).
 *
 * The journal is append-only, so there is no edit and no delete. A wrong entry is answered by a
 * second entry that undoes it on a stated date, and then by a fresh correct entry. That is what a
 * paper ledger required and it is required here for the same reason: a record that can be changed is
 * not evidence of what was charged and when.
 *
 * The date is an argument and never "today". A correction found in March for a February entry is
 * dated in February if February is still open and in March if it is closed, and only the caller —
 * which knows the period locks — can decide which. A reversal that silently used the current date
 * would restate a filed period, which is precisely what period locking exists to prevent.
 */

/** Raised when a reversal would be dated before the entry it reverses. */
export class BackdatedReversal extends AppError {
  constructor(entryId: string, entryDate: string, on: string) {
    super(
      'validation',
      `Cannot reverse entry "${entryId}" dated ${entryDate} on ${on}: a reversal may not predate ` +
        'the entry it corrects, or the correction would appear in a period the original never ' +
        'reached.',
      { details: { entryId, entryDate, on } },
    )
    this.name = 'BackdatedReversal'
  }
}

export interface ReversalOptions {
  /** The id for the reversing entry. Defaults to the original's id with `-R` appended. */
  readonly entryId?: EntryId
  readonly narrative?: string
}

/** The default id for the reversal of an entry. Deterministic, because core allocates no ids. */
export function reversalEntryId(original: EntryId): EntryId {
  return `${original}-R` as EntryId
}

function swap(line: JournalLine): JournalLine {
  return Object.freeze({
    account: line.account,
    debitFils: line.creditFils,
    creditFils: line.debitFils,
    currency: line.currency,
    memo: line.memo,
  })
}

/**
 * Builds the entry that undoes `entry`, dated `on`.
 *
 * Debits and credits swap and the absolute fils are untouched: a reversal that re-derived its
 * amounts could round differently from the original and leave a residue that nobody can trace back
 * to a transaction.
 *
 * No chart is taken, and that is deliberate. The accounts came from an entry that was already
 * validated against a chart, so re-checking them here would either duplicate that check or — if the
 * chart had since changed — refuse to correct an entry precisely because the account it used was
 * retired. An append-only journal must always be correctable.
 */
export function reverseEntry(
  entry: JournalEntry,
  on: LocalDate,
  options: ReversalOptions = {},
): JournalEntry {
  // `YYYY-MM-DD` compares correctly as a string, which is why no date arithmetic is needed here.
  if (on < entry.entryDate) {
    throw new BackdatedReversal(entry.entryId as string, entry.entryDate as string, on as string)
  }

  const lines = entry.lines.map(swap)

  // The swap preserves balance by construction, so this fires only for an entry that reached here
  // without passing through `postEntry` — a hand-built object or a row read back from storage. The
  // journal is the one place where trusting the caller costs more than checking.
  const debits = debitTotalFils(lines)
  const credits = creditTotalFils(lines)
  if (debits !== credits) throw new UnbalancedEntry(entry.entryId as string, debits, credits)

  return Object.freeze({
    entryId: options.entryId ?? reversalEntryId(entry.entryId),
    entryDate: on,
    narrative: options.narrative ?? `Reversal of ${entry.entryId}: ${entry.narrative}`,
    source: 'reversal' as const,
    currency: entry.currency,
    lines: Object.freeze(lines),
    reverses: entry.entryId,
  })
}

/** True when `candidate` reverses `original`. Used by the journal report and by M-TILL-02. */
export function reverses(candidate: JournalEntry, original: JournalEntry): boolean {
  return candidate.reverses === original.entryId
}

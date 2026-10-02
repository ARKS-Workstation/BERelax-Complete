import type { LocalDate } from '../time.ts'
import type { AccountCode } from './account.ts'
import type { ChartOfAccounts } from './chart-of-accounts.ts'
import { findAccount } from './chart-of-accounts.ts'
import type { EntrySource } from './entry.ts'

/**
 * The cutover BOUNDARY: the date these books open, and the two conditions an opening position must meet.
 *
 * ## A boundary is not a period lock, and the difference is the whole of this module
 *
 * `./period.ts` is about closing a MONTH that has been reported: a dated range, an `AccountingPeriod`,
 * `closedPeriodContaining`, and a correction planned into an open period. A boundary is a different shape
 * — it is one date with nothing behind it, for ever — and treating it as a period lock needs a start date
 * that does not exist. Every candidate is invented: the earliest journal entry (which moves as history is
 * imported), the start of the financial year (which is a figure the handover does not give), or a magic
 * `0001-01-01`. So the boundary is a single date and the predicate is "before it", which is what
 * `opening_date_for()` and `ZL004` have always done in SQL and what {@link boundaryVerdict} is here.
 *
 * **This module is a SECOND statement of migration 0132's two triggers, and that is deliberate.** The
 * database is the thing that holds, because there are five posting paths; this is what the importer and
 * the admin screens read so that a refusal can be EXPLAINED before it is attempted, rather than arriving
 * as a SQLSTATE from inside a transaction. The two are held equal by
 * `packages/fixtures/src/opening-boundary.itest.ts`, which drives both over the same inputs — the rule
 * this repository states as "if you must write a fact twice, add the check that holds the two equal, in
 * the same commit".
 *
 * ## What this module does NOT hold, having been written with it and reduced
 *
 * There is no trial-balance adder here. `openingImbalanceFils` and `assertImportable` in
 * `packages/db/src/services/opening-balances.ts` already refuse an unbalanced stated balance before
 * anything is written and name the difference in fils, which is H-MIG-07's first acceptance line met by
 * code that predates it; `ZY382` (migration 0132) is the second direction, holding an attestation to the
 * posting it describes. A third adder in `packages/core` would be the statement that drifts.
 *
 * ## The remainder, which is what keeps H-MIG-03 out of the total twice
 *
 * H-MIG-03's reconstructed package liability posts on `journal_entry.source = 'opening_balance'`
 * (ADR 0069) and so does the opening trial balance, so the attested position is a SET of entries. The
 * import therefore posts, per account, the stated figure MINUS what `opening_balance` entries already
 * hold — {@link openingRemainder} — and refuses a stated figure that is SMALLER than what is already
 * there, because that is not a remainder, it is a disagreement about a liability another import attested
 * to. There is no tolerance and no absorption: ADR 0071 settled that a posting from outside the package
 * path is "a named variance rather than one absorbed", and this is the same rule at the opening.
 *
 * Nothing here reads a clock, performs I/O or consults the database. Every figure is an integer number of
 * fils (ADR 0007).
 */

/** The date these books open. Every posting is on or after it, for ever. */
export interface CutoverBoundary {
  readonly opensOn: LocalDate
}

/**
 * Why an entry may not be dated where it is, in the vocabulary the SQLSTATEs carry.
 *
 * `behind_the_boundary` is `ZY381` and `opening_position_is_closed` is `ZY383`. Named rather than
 * numbered here because `packages/core` may not know a SQLSTATE — the codes belong to the migration and
 * the translator, and a core module holding one would be a second place a code lives (ADR 0043).
 */
export type BoundaryRefusal = 'behind_the_boundary' | 'opening_position_is_closed'

export type BoundaryVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly refusal: BoundaryRefusal
      readonly boundary: LocalDate
      readonly attempted: LocalDate
      /** What the person has to go and do. The reason a verdict is not a boolean. */
      readonly remedy: string
    }

/**
 * May an entry dated `entryDate`, with this source, be posted against this boundary?
 *
 * `attested` is whether an opening balance has already been IMPORTED for the boundary, and it is a
 * separate argument from the boundary itself because the two differ for exactly one transaction — the one
 * that posts the opening entry and then records the attestation. 0027 records the same distinction as the
 * reason its guard returns early on a null opening date.
 */
export function boundaryVerdict(args: {
  readonly boundary: CutoverBoundary
  readonly entryDate: LocalDate
  readonly source: EntrySource
  readonly attested: boolean
}): BoundaryVerdict {
  const { boundary, entryDate, source, attested } = args
  if (!attested) return { ok: true }

  if (entryDate < boundary.opensOn) {
    return {
      ok: false,
      refusal: 'behind_the_boundary',
      boundary: boundary.opensOn,
      attempted: entryDate,
      remedy:
        'The period before the boundary is summarised by the opening balance already imported, so a ' +
        'posting into it is counted twice — and the books still balance afterwards. A correction is a ' +
        'dated reversal on or after the boundary plus a fresh import at a new boundary (ADR 0017).',
    }
  }

  if (entryDate === boundary.opensOn && source === 'opening_balance') {
    return {
      ok: false,
      refusal: 'opening_position_is_closed',
      boundary: boundary.opensOn,
      attempted: entryDate,
      remedy:
        'The attested totals are append-only, so an opening_balance entry added now makes them wrong ' +
        'while every balance still ties. Anything belonging in the opening position — the reconstructed ' +
        'package liability among it — is imported BEFORE the trial balance that attests to it.',
    }
  }

  return { ok: true }
}

/**
 * One line of a stated opening trial balance. Exactly one side is non-zero.
 *
 * Deliberately NOT accompanied by an `openingTrialBalance` function here, and the absence is worth a
 * sentence because it was written first and removed. `openingImbalanceFils` and `assertImportable` in
 * `packages/db/src/services/opening-balances.ts` already add a stated trial balance up and refuse an
 * unbalanced one BEFORE anything is written, naming the difference in fils — which is this unit's first
 * acceptance line, satisfied by a function that predates it. A core version would have been a second
 * statement of one sum, and this repository's own rule is that the second statement is the one that
 * drifts. What is here instead is what did not exist: the BOUNDARY predicate and the remainder.
 */
export interface OpeningBalanceStatement {
  readonly accountCode: AccountCode
  readonly debitFils: number
  readonly creditFils: number
}

export type RemainderVerdict =
  | { readonly ok: true; readonly debitFils: number; readonly creditFils: number }
  | {
      readonly ok: false
      readonly refusal: 'stated_below_what_is_already_posted'
      readonly accountCode: AccountCode
      readonly statedFils: number
      readonly postedFils: number
      readonly message: string
    }

/**
 * What this import must post for one account, given what `opening_balance` entries already hold for it.
 *
 * The stated figure MINUS the posted one, on the side the statement is on. A stated figure that equals
 * what is already there posts nothing — zero on both sides — which is the normal case for the package
 * liability H-MIG-03 attested: the trial balance includes it because the attested totals are the whole
 * position's, and the import adds nothing to it.
 *
 * A stated figure BELOW what is posted is refused and never netted the other way. It is not a remainder;
 * it is a disagreement with a liability another import already attested to, and ADR 0071 settled the
 * direction: "a posting from outside the package path is a named variance rather than one absorbed".
 */
export function openingRemainder(args: {
  readonly accountCode: AccountCode
  readonly statedDebitFils: number
  readonly statedCreditFils: number
  /** Signed: debits less credits already posted on `opening_balance` entries for this account. */
  readonly postedNetFils: number
}): RemainderVerdict {
  const { accountCode, statedDebitFils, statedCreditFils, postedNetFils } = args
  const statedNet = statedDebitFils - statedCreditFils

  // The posted amount has to lie BETWEEN zero and the stated figure, on the stated side. Outside that it
  // is not part of this statement at all, which is the variance.
  const beyond =
    statedNet >= 0
      ? postedNetFils < 0 || postedNetFils > statedNet
      : postedNetFils > 0 || postedNetFils < statedNet
  if (beyond) {
    return {
      ok: false,
      refusal: 'stated_below_what_is_already_posted',
      accountCode,
      statedFils: statedNet,
      postedFils: postedNetFils,
      message:
        `Account ${accountCode} is stated at ${statedNet} fils (debits less credits) and ` +
        `opening_balance entries already hold ${postedNetFils} fils for it. The attested position is the ` +
        'WHOLE of the opening balance, so what is already posted has to be part of what is stated — a ' +
        'stated figure on the other side of zero, or smaller than what is there, is a disagreement with ' +
        'an import that has already been attested to and is a named variance rather than one absorbed ' +
        '(ADR 0071).',
    }
  }

  const remainder = statedNet - postedNetFils
  return {
    ok: true,
    debitFils: remainder > 0 ? remainder : 0,
    creditFils: remainder < 0 ? -remainder : 0,
  }
}

/**
 * Which accounts of a stated opening trial balance the chart in force does not hold.
 *
 * An opening position is all-or-nothing by nature: a trial balance missing one account is not a trial
 * balance with a gap, it is a different position that happens to balance. So this answers the SET and the
 * caller refuses the whole file, which is why it returns codes rather than a boolean.
 *
 * It is here and not in `./chart-of-accounts.ts` because the question is about an imported statement
 * rather than about the chart, and `findAccount` is the one lookup both use.
 */
export function accountsOutsideTheChart(
  chart: ChartOfAccounts,
  lines: readonly OpeningBalanceStatement[],
): readonly AccountCode[] {
  const missing: AccountCode[] = []
  for (const line of lines) {
    if (findAccount(chart, line.accountCode) === undefined && !missing.includes(line.accountCode)) {
      missing.push(line.accountCode)
    }
  }
  return Object.freeze(missing)
}

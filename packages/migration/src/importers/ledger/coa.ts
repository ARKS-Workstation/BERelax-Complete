import type { Vat201AccountAttribution } from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The chart the opening balances are posted against, and what makes it COMPLETE.
 *
 * ## This module checks the chart; it does not import one, and that is the decision
 *
 * H-MIG-07's fifth acceptance line is *"the chart of accounts imported carries a vat_box tag on every
 * account that needs one, asserted complete against the VAT201 box list"*. The obvious reading is a
 * second importer that writes `account` rows out of a workbook. It is the wrong one, for a reason the
 * schema states better than prose could:
 *
 * `account_carries_a_vat201_attribution` (migration 0089, `ZY009`) refuses, at COMMIT, an `account` row
 * with no `vat201_box_mapping` behind it — "an account with no row drops out of the return silently,
 * which is the one failure a VAT201 working paper cannot survive". So an importer that created accounts
 * would have to supply those attributions, and **an attribution is a decision about what feeds a VAT
 * return**: which box, measured on net supplies or on tax, contributing credit-less-debit or the other
 * way. That is the owner's and the accountant's to make, not a column in a migration file somebody fills
 * in to get an import to run. `vat201.ts`'s own open questions (`VAT201_OPEN_QUESTIONS`) are the record
 * of which ones are still unanswered.
 *
 * The chart is therefore the migrations' (0018 seeds it, 0089 attributes it) and this module answers the
 * question the acceptance line is actually about: **is it complete, and does the opening balance name
 * anything outside it?** Both answers are refusals the import acts on, so nothing is asserted that is
 * not also enforced.
 *
 * ## Why completeness is MEASURED and not asserted
 *
 * {@link chartAttributionGaps} reads every account and its attribution through a LEFT JOIN
 * (`readVat201Attributions`), so an account with none appears with a null disposition. A query that
 * inner-joined would report completeness by construction — the shape ADR 0002 is about — and this unit's
 * assertion would have been a report about its own query. The gap list is then the measurement, and ZY009
 * is why it is empty.
 *
 * The box list is read from the attributions themselves rather than written down. A literal list of
 * VAT201 boxes here would be a second statement of a form's layout: `vat201.ts` holds the measures, the
 * contributions and the dispositions, `vat201_box_mapping` holds which box each account feeds, and a
 * third copy would be the one that falls behind when a box moves.
 */

/** An account the chart holds with no VAT201 attribution behind it. ZY009's own subject. */
export interface ChartAttributionGap {
  readonly accountCode: string
  readonly reason: 'no_attribution' | 'box_without_a_number' | 'unallocated_without_a_question'
}

/**
 * Every way the chart's VAT201 attribution can be incomplete, measured over the rows as they are.
 *
 * Three reasons and not one, because each is a different thing to go and do:
 *
 *   - `no_attribution` — the account feeds the return or does not and nothing says which. ZY009 refuses
 *     it at COMMIT, so a non-empty answer here means something wrote an account outside that trigger.
 *   - `box_without_a_number` — the disposition says `box` and no box number is given, which
 *     `vat201_box_mapping_shape` refuses; the same reasoning as above applies to a non-empty answer.
 *   - `unallocated_without_a_question` — the attribution says the account is in scope and not yet
 *     allocated, and names no open question. That one is NOT refused by the schema, and it is the gap
 *     this function exists to find: an unallocated account with nothing to ask about it is a figure
 *     nobody will ever come back to, which is the same rule `app_setting` and `service_variant` follow
 *     for a provisional value.
 */
export function chartAttributionGaps(
  attributions: readonly Vat201AccountAttribution[],
): readonly ChartAttributionGap[] {
  const gaps: ChartAttributionGap[] = []
  for (const row of attributions) {
    if (row.disposition === null || row.disposition === undefined) {
      gaps.push({ accountCode: row.accountCode, reason: 'no_attribution' })
      continue
    }
    if (row.disposition === 'box' && (row.boxNo === null || row.boxNo === undefined)) {
      gaps.push({ accountCode: row.accountCode, reason: 'box_without_a_number' })
      continue
    }
    if (
      row.disposition === 'unallocated' &&
      (row.openQuestionId === null ||
        row.openQuestionId === undefined ||
        row.openQuestionId.trim().length === 0)
    ) {
      gaps.push({ accountCode: row.accountCode, reason: 'unallocated_without_a_question' })
    }
  }
  return Object.freeze(gaps)
}

/**
 * The VAT201 boxes the chart actually feeds, ascending.
 *
 * Derived from the attributions and never written down — see the module note. It is what "complete
 * against the VAT201 box list" is measured over: the boxes the chart claims to feed, which a test
 * compares to the boxes the return's own summariser reads.
 */
export function boxesFedByTheChart(
  attributions: readonly Vat201AccountAttribution[],
): readonly number[] {
  const boxes = new Set<number>()
  for (const row of attributions) {
    if (row.disposition === 'box' && typeof row.boxNo === 'number') boxes.add(row.boxNo)
  }
  return Object.freeze([...boxes].sort((a, b) => a - b))
}

/**
 * Refuses an opening trial balance that names an account the chart does not hold, naming every one.
 *
 * The WHOLE file and not the line, which is the one thing about this importer that differs from every
 * other H-MIG importer: there is no quarantine here. A trial balance with one account held back does not
 * balance, so a partial import has nothing to post — and `journal_line_account_code_fkey` would refuse
 * the line anyway, one account at a time, with the run stopping on the first. Naming them all at once is
 * what lets the file be corrected in one pass (ADR 0065).
 */
export function assertAccountsAreInTheChart(
  chartCodes: readonly string[],
  statedCodes: readonly string[],
): void {
  const held = new Set(chartCodes)
  const missing = [...new Set(statedCodes.filter((code) => !held.has(code)))].sort()
  if (missing.length === 0) return
  throw new AppError(
    'validation',
    `The opening trial balance names ${missing.length} account code(s) the chart of accounts does not ` +
      `hold: ${missing.join(', ')}. Refused whole rather than line by line: a trial balance missing an ` +
      'account is not a trial balance with a gap, it is a different position that happens to balance. ' +
      'The chart is seeded by the migrations and extended by one, never by an import — an account needs ' +
      'a VAT201 attribution (ZY009), and which box it feeds is a decision about the return rather than a ' +
      'column somebody fills in to get an import to run.',
    { details: { missing } },
  )
}

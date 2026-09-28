import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { periodStatusOn, trialBalanceHashAsAt } from '../services/period-close.ts'

/**
 * The VAT201 working papers: every box, every figure, and the line-by-line evidence behind it.
 *
 * M-VAT-07. The figures are summed by `0089_vat201_mapping.sql` — `vat201_box_total()` aggregating over
 * `vat201_box_line()` — and this module is the reader. Nothing here re-sums the journal, and that is the
 * whole shape of the unit: a box total and the drill-down a preparer is shown when they click it come from
 * ONE definition, so they cannot disagree by a fils. Two queries would be two `where` clauses that agree
 * until somebody edits one.
 *
 * ## Every box number is [UNVERIFIED], and the paper says so in every row
 *
 * Y11-vat201-boxes is open and Y11-tax-agent records an FTA-registered tax agent's review as **not
 * optional**. Neither stops the working papers being built — an agent cannot review a paper that does not
 * exist — but the paper carries `fileable: false` with the reasons as ROWS, every box carries
 * `isProvisional` and its question id, and `vat201_box.label` is constrained to contain a placeholder
 * marker while the numbering stands (0089, using `is_placeholder_text` from 0026). A paper that printed
 * "Box 1  Standard-rated supplies" as though somebody had confirmed the number would be filed.
 *
 * ## The period must be CLOSED, and `periodStatusOn` is the only thing that knows
 *
 * "Is this date closed?" has exactly one reader in this repository — {@link periodStatusOn} (M-VAT-06),
 * which answers from `period_lock_for()` and `earliest_open_date_from()`, the same two functions the
 * BEFORE INSERT guards on `journal_entry` and `journal_line` call. A second reader here would be a second
 * answer, and the day the two disagreed a working paper would be produced for a period a posting could
 * still reach. So {@link vat201WorkingPapers} refuses an open period and names the earliest open date it
 * was given by that one reader.
 *
 * The refusal is deliberate and not a convenience. Working papers for a period that can still change are
 * working papers somebody will file, and the provisional rule is the strictest safe option (docs/12 §2).
 * A mid-period estimate is a different artefact with a different name, and it is not this unit's.
 *
 * ## Nothing here reads a clock
 *
 * The acceptance line is "regenerating the return for a closed period twice under the frozen clock
 * produces byte-identical working papers", and the paper contains no instant at all — not a frozen one,
 * none. A `generatedAt` would make the bytes differ between two runs a second apart, and the property
 * worth having is that the paper is a function of the ROWS. Every collection is ordered by SQL, every
 * figure is a decimal string of integer fils, and {@link canonicaliseVat201WorkingPapers} sorts keys, so
 * two runs five years apart produce the same bytes and the same `contentHash`.
 *
 * ## Evidence, and what it is evidence OF
 *
 * `trialBalanceHashAsAt` (M-VAT-06) is carried on the paper. It is computed in SQL by
 * `period_trial_balance_hash()`, deliberately excludes the account NAME so a chart tidy-up does not read
 * as a restatement, and is reproducible by a `psql` session or by something that is not this codebase.
 * The paper's own `contentHash` is this module's; the trial-balance hash is the ledger's. Both are on the
 * paper because they answer different questions: "is this the paper I filed" and "is this the ledger it
 * was filed from".
 */

// --- the shape a caller reads -------------------------------------------------------------------

export interface Vat201Period {
  /** The period identifier an accountant recognises: '2026-08', '2026-Q3'. It appears in every refusal. */
  readonly periodId: string
  readonly startsOn: string
  /** The last day **of** the period, not the first day after it. */
  readonly endsOn: string
}

export interface Vat201BoxRow {
  readonly boxNo: number
  readonly label: string
  readonly side: 'output' | 'input'
  readonly displayOrder: number
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  /** The value of the supplies or purchases in the box, in integer fils. */
  readonly netSuppliesFils: bigint
  /** The tax in the box, in integer fils. */
  readonly taxFils: bigint
  readonly lineCount: number
}

export interface Vat201UnboxedRow {
  readonly disposition: 'unallocated' | 'out_of_scope' | 'unattributed'
  readonly accountCode: string
  readonly accountName: string
  readonly openQuestionId: string | null
  readonly netSuppliesFils: bigint
  readonly taxFils: bigint
  /** Debits PLUS credits. Never the net: a credit against a contra account nets to zero and has moved. */
  readonly movementFils: bigint
  readonly lineCount: number
}

export interface Vat201DrillDownRow {
  readonly entryId: string
  readonly lineNo: number
  readonly entryDate: string
  readonly source: string
  readonly narrative: string
  readonly accountCode: string
  readonly accountName: string
  readonly boxNo: number | null
  readonly measure: 'net_supplies' | 'tax' | null
  readonly contribution: 'credit_less_debit' | 'debit_less_credit' | null
  readonly debitFils: bigint
  readonly creditFils: bigint
  readonly signedFils: bigint
  /** `null` when no document names this entry — which the drill-down acceptance line forbids in a box. */
  readonly documentKind: string | null
  readonly documentId: string | null
  /** The printed number, where the document has one. A package sale and a cash session have none. */
  readonly documentNumber: string | null
}

export interface Vat201PartitionCensusRow {
  readonly linesInPeriod: number
  readonly linesEnumerated: number
  readonly linesDistinct: number
  readonly unattributed: number
  readonly boxed: number
  readonly unallocated: number
  readonly outOfScope: number
}

/**
 * A grouping the chart declares and no account carries, reported as a ZERO with the reason.
 *
 * The acceptance line asks the worked example to cover zero-rated supplies. The provisional chart has no
 * zero-rated and no exempt REVENUE account (Y8-coa), so a zero-rated supply cannot be posted at all —
 * and inventing an account, or a box number for one, would be a business fact nobody has stated (brief
 * rule 15). What the paper reports instead is the grouping at zero WITH the reason, which is a different
 * thing from an absent row: "we made no zero-rated supplies" and "nothing in this system can express
 * one" are answers an agent needs to be able to tell apart.
 */
export interface Vat201UnrepresentableGrouping {
  readonly grouping: string
  readonly reason: string
  readonly openQuestionId: string
}

/** Why this return may not be filed. A row each, so a zero-reason return is a decision and not a gap. */
export interface Vat201NotFileableReason {
  readonly reason: string
  readonly openQuestionId: string
  readonly detail: string
}

export interface Vat201Reconciliation {
  readonly identity: string
  readonly ledgerFils: bigint
  readonly documentFils: bigint
  /** `ledgerFils - documentFils`. Zero, or the working paper has found something. */
  readonly differenceFils: bigint
  readonly note: string
}

export interface Vat201MappingDisagreement {
  readonly accountCode: string
  readonly accountName: string
  readonly chartGrouping: string | null
  readonly disposition: string
  readonly boxNo: number | null
}

export interface Vat201WorkingPapers {
  /** The canonical form's version tag. A future canonical form is incomparable rather than unequal. */
  readonly formatVersion: 'vat201-wp1'
  readonly period: Vat201Period
  /** The lock covering the period end, from `periodStatusOn`. Always closed: an open one is refused. */
  readonly closedPeriodId: string
  /** `period_trial_balance_hash(endsOn)`, M-VAT-06's evidence. Reproducible from a psql session. */
  readonly trialBalanceHash: string
  readonly boxes: readonly Vat201BoxRow[]
  readonly unboxed: readonly Vat201UnboxedRow[]
  readonly unrepresentableGroupings: readonly Vat201UnrepresentableGrouping[]
  readonly census: Vat201PartitionCensusRow
  readonly reconciliations: readonly Vat201Reconciliation[]
  /** Accounts whose chart grouping and box attribution no longer agree. Must be empty. */
  readonly mappingDisagreements: readonly Vat201MappingDisagreement[]
  readonly fileable: false
  readonly notFileableReasons: readonly Vat201NotFileableReason[]
  /** sha256 of {@link canonicaliseVat201WorkingPapers} over this paper with the field omitted. */
  readonly contentHash: string
}

// --- validation ---------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Raised when the working papers are asked for over a period that is not closed. */
export class Vat201PeriodNotClosed extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('conflict', message, { details })
    this.name = 'Vat201PeriodNotClosed'
  }
}

function assertPeriod(period: Vat201Period): void {
  for (const [label, value] of [
    ['startsOn', period.startsOn],
    ['endsOn', period.endsOn],
  ] as const) {
    if (!ISO_DATE.test(value)) {
      throw new AppError(
        'validation',
        `${label} must be an ISO business day (YYYY-MM-DD), got "${value}"`,
      )
    }
  }
  if (period.endsOn < period.startsOn) {
    throw new AppError(
      'validation',
      `A VAT period ends ${period.endsOn}, before it starts ${period.startsOn}. Read backwards it ` +
        'returns nothing and looks like a quarter with no trade in it.',
    )
  }
  if (period.periodId.trim() === '') {
    throw new AppError(
      'validation',
      'periodId is the identifier an accountant recognises; it is blank',
    )
  }
}

// --- the reads ----------------------------------------------------------------------------------

/**
 * Every box in the period, always, even at zero.
 *
 * `vat201_box_total()` left-joins `vat201_box`, so a box nobody posted to is a row reading zero rather
 * than an absent one. An absent row is indistinguishable from a box nobody computed, which is the
 * argument `PAYABLES_AGING_BUCKETS` makes about an empty bucket and `INPUT_VAT_NON_RECOVERY_REASONS`
 * makes about a reason nothing was claimed.
 *
 * Every figure comes back as `text` and becomes a `BigInt`. `sum()` over the fils domain returns numeric
 * and the driver hands that back as a string; `queries/trial-balance.ts` records the four-fils difference
 * a `number` produced out of nothing, and these are the figures a return is filed on.
 */
export async function vat201Boxes(
  sql: Sql,
  period: Vat201Period,
): Promise<readonly Vat201BoxRow[]> {
  assertPeriod(period)
  const rows = await sql<
    {
      box_no: number
      label: string
      side: string
      display_order: number
      is_provisional: boolean
      open_question_id: string | null
      net_supplies_fils: string
      tax_fils: string
      line_count: string
    }[]
  >`
    select box_no, label, side, display_order, is_provisional, open_question_id,
           net_supplies_fils::text, tax_fils::text, line_count::text
    from vat201_box_total(${period.startsOn}::date, ${period.endsOn}::date)
    order by display_order
  `
  return rows.map((row) => ({
    boxNo: row.box_no,
    label: row.label,
    side: row.side as 'output' | 'input',
    displayOrder: row.display_order,
    isProvisional: row.is_provisional,
    openQuestionId: row.open_question_id,
    netSuppliesFils: BigInt(row.net_supplies_fils),
    taxFils: BigInt(row.tax_fils),
    lineCount: Number(row.line_count),
  }))
}

/** The unallocated, out-of-scope and unattributed buckets, per account. */
export async function vat201UnboxedTotals(
  sql: Sql,
  period: Vat201Period,
): Promise<readonly Vat201UnboxedRow[]> {
  assertPeriod(period)
  const rows = await sql<
    {
      disposition: string
      account_code: string
      account_name: string
      open_question_id: string | null
      net_supplies_fils: string
      tax_fils: string
      debits_fils: string
      credits_fils: string
      line_count: string
    }[]
  >`
    select disposition, account_code, account_name, open_question_id,
           net_supplies_fils::text, tax_fils::text, debits_fils::text, credits_fils::text,
           line_count::text
    from vat201_unboxed_total(${period.startsOn}::date, ${period.endsOn}::date)
    order by disposition, account_code
  `
  return rows.map((row) => ({
    disposition: row.disposition as Vat201UnboxedRow['disposition'],
    accountCode: row.account_code,
    accountName: row.account_name,
    openQuestionId: row.open_question_id,
    netSuppliesFils: BigInt(row.net_supplies_fils),
    taxFils: BigInt(row.tax_fils),
    movementFils: BigInt(row.debits_fils) + BigInt(row.credits_fils),
    lineCount: Number(row.line_count),
  }))
}

/**
 * Box to journal line to source document, for one box or for the whole period.
 *
 * The drill-down the box totals are an aggregate over. Ordered by entry, then line, then document kind —
 * a total order, because the acceptance line asks for byte-identical regeneration and an unordered read
 * diffs everywhere the moment the planner picks a different scan.
 *
 * `boxNo` omitted walks every line including the out-of-scope bucket, which is what the
 * exhaustive-partition proof needs: a partition proved over two differently-filtered queries is a proof
 * about the two filters.
 */
export async function vat201DrillDown(
  sql: Sql,
  period: Vat201Period,
  boxNo?: number,
): Promise<readonly Vat201DrillDownRow[]> {
  assertPeriod(period)
  const box = boxNo ?? null
  const rows = await sql<
    {
      entry_id: string
      line_no: number
      entry_date: string
      source: string
      narrative: string
      account_code: string
      account_name: string
      box_no: number | null
      measure: string | null
      contribution: string | null
      debit_fils: string
      credit_fils: string
      signed_fils: string
      document_kind: string | null
      document_id: string | null
      document_number: string | null
    }[]
  >`
    select entry_id, line_no, entry_date::text as entry_date, source, narrative,
           account_code, account_name, box_no, measure, contribution,
           debit_fils::text, credit_fils::text, signed_fils::text,
           document_kind, document_id, document_number
    from vat201_box_line(${period.startsOn}::date, ${period.endsOn}::date)
    where (${box}::integer is null or box_no = ${box}::integer)
    order by entry_id, line_no, document_kind nulls first
  `
  return rows.map((row) => ({
    entryId: row.entry_id,
    lineNo: row.line_no,
    entryDate: row.entry_date,
    source: row.source,
    narrative: row.narrative,
    accountCode: row.account_code,
    accountName: row.account_name,
    boxNo: row.box_no,
    measure: row.measure as Vat201DrillDownRow['measure'],
    contribution: row.contribution as Vat201DrillDownRow['contribution'],
    debitFils: BigInt(row.debit_fils),
    creditFils: BigInt(row.credit_fils),
    signedFils: BigInt(row.signed_fils),
    documentKind: row.document_kind,
    documentId: row.document_id,
    documentNumber: row.document_number,
  }))
}

/** The exhaustive-partition measurement: seven counts a `psql` session reproduces. */
export async function vat201PartitionCensus(
  sql: Sql,
  period: Vat201Period,
): Promise<Vat201PartitionCensusRow> {
  assertPeriod(period)
  const [row] = await sql<
    {
      lines_in_period: string
      lines_enumerated: string
      lines_distinct: string
      unattributed: string
      boxed: string
      unallocated: string
      out_of_scope: string
    }[]
  >`
    select lines_in_period::text, lines_enumerated::text, lines_distinct::text,
           unattributed::text, boxed::text, unallocated::text, out_of_scope::text
    from vat201_partition_census(${period.startsOn}::date, ${period.endsOn}::date)
  `
  if (!row) {
    throw new AppError(
      'invariant_violated',
      `vat201_partition_census returned no row for ${period.startsOn}..${period.endsOn}`,
    )
  }
  return {
    linesInPeriod: Number(row.lines_in_period),
    linesEnumerated: Number(row.lines_enumerated),
    linesDistinct: Number(row.lines_distinct),
    unattributed: Number(row.unattributed),
    boxed: Number(row.boxed),
    unallocated: Number(row.unallocated),
    outOfScope: Number(row.out_of_scope),
  }
}

/** Accounts whose chart grouping and box attribution disagree. A report, never a refusal — see 0089. */
export async function vat201MappingDisagreements(
  sql: Sql,
): Promise<readonly Vat201MappingDisagreement[]> {
  const rows = await sql<
    {
      account_code: string
      account_name: string
      chart_grouping: string | null
      disposition: string
      box_no: number | null
    }[]
  >`
    select account_code, account_name, chart_grouping, disposition, box_no
    from vat201_mapping_disagreement()
    order by account_code
  `
  return rows.map((row) => ({
    accountCode: row.account_code,
    accountName: row.account_name,
    chartGrouping: row.chart_grouping,
    disposition: row.disposition,
    boxNo: row.box_no,
  }))
}

/**
 * The groupings the chart declares that no account carries, reported as zeros with their reason.
 *
 * Derived from `account`, not from a list here: a grouping that acquires an account tomorrow stops being
 * unrepresentable without anybody editing this file, and a hand-written list would keep claiming it was.
 */
export async function vat201UnrepresentableGroupings(
  sql: Sql,
): Promise<readonly Vat201UnrepresentableGrouping[]> {
  const rows = await sql<{ grouping: string }[]>`
    select g.grouping
    from unnest(array['zero_rated_supplies', 'exempt_supplies']) as g(grouping)
    where not exists (select 1 from account a where a.vat_box = g.grouping)
    order by g.grouping
  `
  return rows.map((row) => ({
    grouping: row.grouping,
    reason:
      `No account in the chart carries the ${row.grouping} grouping, so no such supply can be posted ` +
      'and this figure is a structural zero rather than a period with none in it. Adding an account is ' +
      'a statement about what the business sells, which nobody has made.',
    openQuestionId: 'Y8-coa',
  }))
}

// --- the reconciliations ------------------------------------------------------------------------

/**
 * The ledger against the documents, for the two identities this unit can close on its own.
 *
 * The output box is summed from the LEDGER and the input working paper from `bill_line` (M-VAT-03's
 * recorded finding: "a bill can satisfy one source and not the other"), so the two sources have to be
 * compared or the disagreement is nobody's. Both identities below are over the bill columns, which are
 * the ones a single query can reach.
 *
 * The full four-identity reconciliation — invoice gross less credit-note gross against revenue plus
 * output VAT, and the rest — is M-VAT-12's closed-month report and is deliberately not duplicated here.
 */
async function reconciliations(
  sql: Sql,
  period: Vat201Period,
  boxes: readonly Vat201BoxRow[],
): Promise<readonly Vat201Reconciliation[]> {
  const [billSide] = await sql<
    { reverse_charge_output: string; recoverable: string; reverse_charge_input: string }[]
  >`
    select coalesce(sum(b.reverse_charge_output_vat_fils), 0)::text as reverse_charge_output,
           coalesce(sum(b.recoverable_input_vat_fils), 0)::text     as recoverable,
           coalesce(sum(b.reverse_charge_input_vat_fils), 0)::text  as reverse_charge_input
    from bill b
    join journal_entry e on e.entry_id = b.entry_id
    where e.entry_date between ${period.startsOn}::date and ${period.endsOn}::date
  `
  const declared = BigInt(billSide?.reverse_charge_output ?? '0')
  const claimed =
    BigInt(billSide?.recoverable ?? '0') + BigInt(billSide?.reverse_charge_input ?? '0')

  /** The tax figure in the box a grouping maps to, read from the ROWS rather than from a box number. */
  const taxIn = async (grouping: string): Promise<bigint> => {
    const [row] = await sql<{ box_no: number | null }[]>`
      select m.box_no
      from vat201_box_mapping m
      join account a on a.code = m.account_code
      where a.vat_box = ${grouping} and m.measure = 'tax' and m.box_no is not null
      order by m.box_no
      limit 1
    `
    const boxNo = row?.box_no ?? null
    return boxes.find((box) => box.boxNo === boxNo)?.taxFils ?? 0n
  }

  const reverseChargeTax = await taxIn('reverse_charge')
  const inputTax = await taxIn('recoverable_input_tax')

  return [
    {
      identity: 'reverse-charge output tax: ledger against bill',
      ledgerFils: reverseChargeTax,
      documentFils: declared,
      differenceFils: reverseChargeTax - declared,
      note:
        'The box is summed from journal_line and the bill figure from bill.reverse_charge_output_vat_fils. ' +
        'M-VAT-03 recorded that a bill can satisfy one source and not the other, so a non-zero difference ' +
        'means a posting and a document disagree about what was declared.',
    },
    {
      identity: 'input tax claimed: ledger against bill',
      ledgerFils: inputTax,
      documentFils: claimed,
      differenceFils: inputTax - claimed,
      note:
        'Both halves of 1080: the claim supported by a supplier tax invoice and the claim supported by ' +
        'our own reverse-charge self-assessment. Summed separately on the bill (two columns) and ' +
        'together in the ledger (two lines on the same account), which is why the document side adds ' +
        'them rather than taking one.',
    },
  ]
}

/**
 * Which box a grouping's TAX lands in, read from the mapping rows.
 *
 * Exported because the itest and any later screen need the same answer, and because a caller that wanted
 * "box 1" would be writing down the number Y11-vat201-boxes exists to supply.
 */
export async function vat201BoxForGrouping(
  sql: Sql,
  grouping: string,
  measure: 'net_supplies' | 'tax',
): Promise<number | null> {
  const [row] = await sql<{ box_no: number | null }[]>`
    select m.box_no
    from vat201_box_mapping m
    join account a on a.code = m.account_code
    where a.vat_box = ${grouping} and m.measure = ${measure} and m.box_no is not null
    order by m.box_no
    limit 1
  `
  return row?.box_no ?? null
}

// --- the paper ----------------------------------------------------------------------------------

/**
 * The reasons a return may not be filed, as rows.
 *
 * Every one of them stands today, and the paper carries `fileable: false` as a literal type so that a
 * caller cannot branch on it being true and find out later that it never is. When Y11-tax-agent and
 * Y11-vat201-boxes are answered, `is_provisional` comes off the box rows, this list shortens, and the
 * type widens in the same commit — which is a visible change rather than a flag flipping.
 */
function notFileableReasons(
  boxes: readonly Vat201BoxRow[],
  unboxed: readonly Vat201UnboxedRow[],
  census: Vat201PartitionCensusRow,
  disagreements: readonly Vat201MappingDisagreement[],
): readonly Vat201NotFileableReason[] {
  const reasons: Vat201NotFileableReason[] = []
  const provisional = boxes.filter((box) => box.isProvisional)
  if (provisional.length > 0) {
    reasons.push({
      reason: 'box_numbering_unconfirmed',
      openQuestionId: 'Y11-vat201-boxes',
      detail:
        `${provisional.length} of ${boxes.length} box numbers are placeholders held as rows ` +
        `(${provisional.map((box) => box.boxNo).join(', ')}). Answering the question is an UPDATE of ` +
        'vat201_box and of box_no on the mapping rows; no code changes.',
    })
  }
  reasons.push({
    reason: 'tax_agent_review_outstanding',
    openQuestionId: 'Y11-tax-agent',
    detail:
      'An FTA-registered tax agent has not reviewed this mapping. Y11-tax-agent records the review as ' +
      'not optional, and these papers exist to be the thing reviewed.',
  })

  const unallocated = unboxed.filter(
    (row) => row.disposition === 'unallocated' && row.movementFils !== 0n,
  )
  if (unallocated.length > 0) {
    reasons.push({
      reason: 'unallocated_figures_present',
      openQuestionId: 'Y11-vat201-boxes',
      detail:
        `${unallocated.length} account(s) feed the return with no box number: ` +
        `${unallocated.map((row) => `${row.accountCode} (${row.movementFils} fils moved)`).join(', ')}. ` +
        'A figure with nowhere to go is not a figure that may be filed anywhere.',
    })
  }
  if (census.unattributed > 0) {
    reasons.push({
      reason: 'unattributed_lines_present',
      openQuestionId: 'Y11-vat201-boxes',
      detail:
        `${census.unattributed} journal line(s) sit on an account with no attribution at all. ZY001 is ` +
        'supposed to make this unreachable, so a non-zero count here is a defect and not a question.',
    })
  }
  if (disagreements.length > 0) {
    reasons.push({
      reason: 'mapping_disagrees_with_chart',
      openQuestionId: 'Y11-vat201-boxes',
      detail:
        `${disagreements.length} account(s) have been reclassified since the mapping was written: ` +
        `${disagreements.map((row) => row.accountCode).join(', ')}. The mapping row and account.vat_box ` +
        'no longer agree about whether the account feeds the return.',
    })
  }
  reasons.push({
    reason: 'rounding_convention_unconfirmed',
    openQuestionId: 'Y11-rounding',
    detail:
      'The gross-to-net convention (half-up on net, VAT as the remainder) is not confirmed with the tax ' +
      'agent. It moves no figure on this paper — the return applies no rate and sums fils as posted — ' +
      'and it is listed because the paper is what the agent is asked to confirm it against.',
  })
  return reasons
}

/**
 * The working papers for a CLOSED period.
 *
 * Refuses an open one, naming the earliest open date from {@link periodStatusOn} — the one reader of "is
 * this date closed?" in this repository (M-VAT-06). A second reader here would be a second answer.
 */
export async function vat201WorkingPapers(
  sql: Sql,
  period: Vat201Period,
): Promise<Vat201WorkingPapers> {
  assertPeriod(period)

  const [atStart, atEnd] = await Promise.all([
    periodStatusOn(sql, period.startsOn),
    periodStatusOn(sql, period.endsOn),
  ])
  // BOTH ends, because a lock covering only part of a VAT quarter leaves days that can still be posted
  // into, and a paper produced from them is a paper that changes after it is signed.
  for (const [label, status] of [
    ['starts', atStart],
    ['ends', atEnd],
  ] as const) {
    if (!status.closed) {
      throw new Vat201PeriodNotClosed(
        `VAT201 working papers for "${period.periodId}" were asked for while the period is open: ` +
          `${period.startsOn}..${period.endsOn} ${label} on ${status.on}, which no period_lock covers. ` +
          `The earliest open date at or after it is ${status.earliestOpenDate}. Close the period first — ` +
          'a working paper for a period a posting can still reach is a working paper that changes after ' +
          'it is filed.',
        {
          periodId: period.periodId,
          startsOn: period.startsOn,
          endsOn: period.endsOn,
          openOn: status.on,
          earliestOpenDate: status.earliestOpenDate,
        },
      )
    }
  }
  if (atStart.periodId !== atEnd.periodId) {
    throw new Vat201PeriodNotClosed(
      `VAT201 working papers for "${period.periodId}" span two different locks: ${period.startsOn} is ` +
        `in "${atStart.periodId}" and ${period.endsOn} is in "${atEnd.periodId}". period_lock_no_overlap ` +
        'makes a single lock per date, so two locks over one VAT period means the period as filed is not ' +
        'the period as closed, and which one the paper describes would depend on the dates it was given.',
      {
        periodId: period.periodId,
        startsLock: atStart.periodId,
        endsLock: atEnd.periodId,
      },
    )
  }

  const [boxes, unboxed, census, disagreements, unrepresentable, trialBalanceHash] =
    await Promise.all([
      vat201Boxes(sql, period),
      vat201UnboxedTotals(sql, period),
      vat201PartitionCensus(sql, period),
      vat201MappingDisagreements(sql),
      vat201UnrepresentableGroupings(sql),
      trialBalanceHashAsAt(sql, period.endsOn),
    ])
  const reconciled = await reconciliations(sql, period, boxes)

  const paper = {
    formatVersion: 'vat201-wp1',
    period,
    closedPeriodId: atEnd.periodId as string,
    trialBalanceHash,
    boxes,
    unboxed,
    unrepresentableGroupings: unrepresentable,
    census,
    reconciliations: reconciled,
    mappingDisagreements: disagreements,
    fileable: false,
    notFileableReasons: notFileableReasons(boxes, unboxed, census, disagreements),
  } as const

  return { ...paper, contentHash: vat201ContentHash(paper) }
}

// --- the canonical form -------------------------------------------------------------------------

/**
 * The paper as bytes, deterministically.
 *
 * `JSON.stringify` preserves insertion order, which makes the bytes depend on the order this module
 * happened to build an object in — so keys are sorted here, recursively, and every `bigint` becomes a
 * decimal string. `bigint` has no JSON representation at all and `JSON.stringify` THROWS on one, which is
 * the good failure: a figure silently becoming `null` is how a box total disappears from an artefact
 * somebody is comparing.
 *
 * The version tag is the first key for `period_trial_balance_hash()`'s reason: a future canonical form
 * has to be INCOMPARABLE to this one rather than merely unequal, so that a changed serialisation reads as
 * "a different kind of artefact" instead of "the figures moved".
 */
export function canonicaliseVat201WorkingPapers(paper: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString()
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    }
    return value
  }
  return JSON.stringify(canonical(paper))
}

/**
 * The paper's own content hash, over the canonical form.
 *
 * Computed over the paper WITHOUT `contentHash`, which is the only order that works: a hash over a value
 * containing itself has no fixed point, and a hash over a paper carrying an empty-string placeholder
 * would change the moment the placeholder was filled in.
 */
export function vat201ContentHash(paper: Omit<Vat201WorkingPapers, 'contentHash'>): string {
  return createHash('sha256').update(canonicaliseVat201WorkingPapers(paper)).digest('hex')
}

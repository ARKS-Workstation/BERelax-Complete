import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The reverse-charge exception scan: every offshore bill in a period whose reverse charge is missing or
 * disagrees with itself.
 *
 * docs/04 §4 asks for exactly this — "flag suppliers offshore and run a nightly exception report on bills
 * lacking the reverse-charge pair" — and it exists because the failure is silent in a way nothing else in
 * the system is. A bill with no reverse charge posts, balances, reconciles to the supplier's invoice to the
 * fils and ages correctly in the payables report. The only thing wrong with it is a figure that is absent
 * from a return nobody has filed yet.
 *
 * ## Why a scan, when `0039_reverse_charge.sql` refuses so much
 *
 * The migration refuses a bill whose reverse charge is internally wrong, at the statement that writes it.
 * What no constraint can refuse is a bill that was RIGHT when it was written and is wrong now, and there
 * are two such routes:
 *
 *   1. **A corrected supplier.** `supplier_tax_profile.place_of_supply_rule` is UPDATEable — deliberately,
 *      because it is configuration an admin corrects, and 0028 grants UPDATE on the profile while
 *      withholding it on the bill. A supplier mistakenly recorded `outside_scope` has bills posted with no
 *      pair, entirely legally; correcting the rule makes every one of them a missing reverse charge,
 *      retroactively. PostgreSQL does not re-validate a CHECK on a row nobody touched, and `bill` is
 *      append-only, so nothing fires and nothing can. The rule is deliberately not snapshotted onto the
 *      bill for this reason: the place of supply is a fact about the supply rather than a state of the
 *      supplier, so recording it wrongly made the RETURN wrong, and the answer is an adjustment rather than
 *      a frozen mistake that reads as correct for ever.
 *   2. **Anything posted before the migration.** Their two columns default to 0, which is the only value
 *      they can hold, and whether each one owed a reverse charge is a question about a row elsewhere.
 *
 * ## What counts as an exception
 *
 * Four kinds, and each is a different failure rather than four spellings of one:
 *
 *   `missing_pair`      the supplier supplies imported services and the bill declares no reverse charge.
 *                       The understatement docs/04 §4 is about.
 *   `pair_disagrees`    a line reclaims part of what it declared — neither all of it nor none of it — or
 *                       the bill reclaims more than it declared. Recovery is a property of the account, so
 *                       a proportion is an apportionment nothing here computes.
 *   `totals_disagree`   the header's two figures are not the sum of its lines'. The deferred trigger proves
 *                       this at COMMIT for a bill written now; a report that trusted the header instead of
 *                       re-summing the rows could be lied to by exactly the corruption it exists to find.
 *   `ledger_disagrees`  the journal entry does not carry the pair the bill records: `2035` was not credited
 *                       with the declaration, or `1080` was not debited with the claim. This is the one
 *                       that matters most, because the output box is summed from the LEDGER and the input
 *                       working paper from `bill_line` — two sources that a bill can satisfy one of.
 *
 * A bill from an offshore supplier whose rule is `outside_scope` is **not** an exception: a supply made and
 * consumed abroad owes no UAE VAT, and reporting it would train a reader to ignore the report. That is why
 * every kind reads `place_of_supply_rule` rather than `residency` alone.
 *
 * ## Reproducible, and never the clock
 *
 * Both ends of the period are arguments. A report that read `current_date` could not be regenerated for a
 * closed period, and regenerating it identically is what makes two runs of the nightly job produce the same
 * output — which is one of this unit's acceptance criteria and impossible to even ask of a query that reads
 * a clock. The period is `journal_entry.entry_date`, the **business day** the caller resolved with
 * `resolveTradingDate`: trading runs 11:00-02:00, so a bill entered at 01:30 belongs to the previous
 * trading date, and `bill_date` is the supplier's tax point rather than the date that decides the VAT
 * period.
 *
 * ## Every figure is a bigint
 *
 * `sum()` over the `fils` domain returns numeric and the driver hands it back as a **string**, so nothing
 * can silently round. `BigInt`, not `Number`: `./trial-balance.ts` documents the four-fils difference a
 * `number` produced out of nothing, and these are the figures an adjustment would be made for.
 */

/**
 * Why a bill is on the report. A closed list, because each kind has a different remedy and a single
 * "reverse charge wrong" bucket could not tell a preparer which.
 */
export const REVERSE_CHARGE_EXCEPTION_KINDS = [
  'missing_pair',
  'pair_disagrees',
  'totals_disagree',
  'ledger_disagrees',
] as const
export type ReverseChargeExceptionKind = (typeof REVERSE_CHARGE_EXCEPTION_KINDS)[number]

export interface ReverseChargeException {
  readonly kind: ReverseChargeExceptionKind
  /** Our own internal reference, so the report drills down to a document. */
  readonly reference: string
  readonly billId: string
  readonly supplierCode: string
  readonly supplierReference: string
  /** The business day the bill posted on: the period the figure belongs to. */
  readonly entryDate: string
  readonly entryId: string
  /** The supplier's place-of-supply rule **as it stands now**, which is what decides the obligation. */
  readonly placeOfSupplyRule: string
  /** The consideration: what the supplier charged, which is the base the reverse charge is computed on. */
  readonly netFils: bigint
  /** What the bill says it declared. Zero for a missing pair, which is the point. */
  readonly declaredFils: bigint
  /** What the bill says it reclaimed. */
  readonly reclaimedFils: bigint
  /** What the ledger carries against 2035 and 1080 for this entry. */
  readonly ledgerDeclaredFils: bigint
  readonly ledgerReclaimedFils: bigint
  /** One sentence naming the discrepancy, for the report and the outbox event. */
  readonly detail: string
}

export interface ReverseChargePeriod {
  readonly from: string
  readonly to: string
  /**
   * Narrows to one supplier.
   *
   * For a test that must not see another suite's rows — the integration suite runs sequentially against one
   * database and earlier files leave bills behind — and never for a return, which must see every supplier.
   */
  readonly supplierCode?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertPeriod(period: ReverseChargePeriod): void {
  for (const [label, value] of [
    ['from', period.from],
    ['to', period.to],
  ] as const) {
    if (!ISO_DATE.test(value)) {
      throw new AppError(
        'validation',
        `${label} must be an ISO business day (YYYY-MM-DD), got "${value}"`,
      )
    }
  }
  if (period.to < period.from) {
    throw new AppError(
      'validation',
      `The period ends ${period.to}, before it starts ${period.from}. A period read backwards returns ` +
        'nothing, which is indistinguishable from a period with no exceptions in it — and this report ' +
        'exists so that an empty result means something.',
    )
  }
}

/** The account the declaration is credited to, and the one the claim is debited to. See `post-bill.ts`. */
const REVERSE_CHARGE_VAT_PAYABLE = '2035'
const RECOVERABLE_INPUT_VAT = '1080'

/**
 * Every reverse-charge exception in the period, oldest first.
 *
 * One query rather than four. Each kind is a different predicate over the same join — the bill, its
 * supplier's current place-of-supply rule, the sum of its lines and the sum of the two VAT accounts in its
 * journal entry — and running four would mean four chances for the joins to drift apart. `kind` is derived
 * in SQL in priority order: a bill with no pair at all cannot also disagree with itself, and reporting it
 * twice would make the count of exceptions bigger than the count of bills.
 *
 * Ordered by business day and then by our own reference, which is gapless and monotonic (0028), so two runs
 * over the same period return the rows in the same order. That is what makes "identical output" an
 * assertion a test can make about the whole report rather than about a set.
 */
export async function reverseChargeExceptions(
  sql: Sql,
  period: ReverseChargePeriod,
): Promise<readonly ReverseChargeException[]> {
  assertPeriod(period)
  const supplierCode = period.supplierCode ?? null

  const rows = await sql<
    {
      kind: string
      reference: string
      bill_id: string
      supplier_code: string
      supplier_reference: string
      entry_date: string
      entry_id: string
      place_of_supply_rule: string
      net_fils: string
      declared_fils: string
      reclaimed_fils: string
      line_declared_fils: string
      line_reclaimed_fils: string
      ledger_declared_fils: string
      ledger_reclaimed_fils: string
      partial_lines: number
    }[]
  >`
    with scanned as (
      select b.bill_id,
             b.display_number                       as reference,
             s.code                                 as supplier_code,
             b.supplier_reference,
             e.entry_date::text                     as entry_date,
             b.entry_id,
             p.place_of_supply_rule,
             b.net_fils,
             b.reverse_charge_output_vat_fils        as declared_fils,
             b.reverse_charge_input_vat_fils         as reclaimed_fils,
             -- Re-summed from the rows rather than read off the header. The deferred trigger proves the two
             -- agree for a bill written now; a report that trusted the header could be lied to by the
             -- corruption it exists to find.
             coalesce(l.declared, 0)                as line_declared_fils,
             coalesce(l.reclaimed, 0)               as line_reclaimed_fils,
             coalesce(l.partial_lines, 0)           as partial_lines,
             -- The ledger's own answer. The output box is summed from journal lines and the input working
             -- paper from bill_line, so a bill can satisfy one of the two and not the other.
             coalesce(j.declared, 0)                as ledger_declared_fils,
             coalesce(j.reclaimed, 0)               as ledger_reclaimed_fils
        from bill b
        join supplier s             on s.supplier_id = b.supplier_id
        join supplier_tax_profile p on p.supplier_id = b.supplier_id
        join journal_entry e        on e.entry_id = b.entry_id
        left join lateral (
          select sum(bl.reverse_charge_output_vat_fils) as declared,
                 sum(bl.reverse_charge_input_vat_fils)  as reclaimed,
                 count(*) filter (
                   where bl.reverse_charge_input_vat_fils <> 0
                     and bl.reverse_charge_input_vat_fils <> bl.reverse_charge_output_vat_fils
                 )                                     as partial_lines
            from bill_line bl where bl.bill_id = b.bill_id
        ) l on true
        left join lateral (
          -- NET of both sides, not the credits alone. A declaration reversed by a later line in the same
          -- entry — which is what a botched correction looks like, because journal_line is append-only and
          -- a reversal is a new line rather than an edit — would otherwise still read as declared.
          select sum(jl.credit_fils - jl.debit_fils)
                   filter (where jl.account_code = ${REVERSE_CHARGE_VAT_PAYABLE}) as declared,
                 sum(jl.debit_fils - jl.credit_fils)
                   filter (where jl.account_code = ${RECOVERABLE_INPUT_VAT})      as reclaimed
            from journal_line jl where jl.entry_id = b.entry_id
        ) j on true
       where e.entry_date between ${period.from}::date and ${period.to}::date
         and (${supplierCode}::text is null or s.code = ${supplierCode})
         -- A domestic bill owes nothing and cannot hold a pair: bill_reverse_charge_needs_an_offshore_supplier
         -- refuses one, and it was validated over every row already there when 0039 applied.
         and b.supplier_residency = 'offshore'
    )
    select case
             -- Priority order. A bill with no pair at all cannot also disagree with itself, and reporting it
             -- under two kinds would make the exception count exceed the bill count.
             when place_of_supply_rule = 'imported_services_reverse_charge' and declared_fils = 0
               then 'missing_pair'
             when partial_lines > 0 or reclaimed_fils > declared_fils
               then 'pair_disagrees'
             when declared_fils <> line_declared_fils or reclaimed_fils <> line_reclaimed_fils
               then 'totals_disagree'
             else 'ledger_disagrees'
           end                              as kind,
           reference, bill_id::text as bill_id, supplier_code, supplier_reference, entry_date, entry_id,
           place_of_supply_rule,
           net_fils::text                   as net_fils,
           declared_fils::text              as declared_fils,
           reclaimed_fils::text             as reclaimed_fils,
           line_declared_fils::text         as line_declared_fils,
           line_reclaimed_fils::text        as line_reclaimed_fils,
           ledger_declared_fils::text       as ledger_declared_fils,
           ledger_reclaimed_fils::text      as ledger_reclaimed_fils,
           partial_lines::int               as partial_lines
      from scanned
     where (place_of_supply_rule = 'imported_services_reverse_charge' and declared_fils = 0)
        or partial_lines > 0
        or reclaimed_fils > declared_fils
        or declared_fils <> line_declared_fils
        or reclaimed_fils <> line_reclaimed_fils
        or declared_fils <> ledger_declared_fils
        -- Only where the bill claims something: 1080 legitimately carries the ordinary input claim of a
        -- domestic bill, and this scan sees offshore bills only, so the two cannot be confused here.
        or reclaimed_fils <> ledger_reclaimed_fils
     order by entry_date, reference
  `

  return rows.map((row) => ({
    kind: row.kind as ReverseChargeExceptionKind,
    reference: row.reference,
    billId: row.bill_id,
    supplierCode: row.supplier_code,
    supplierReference: row.supplier_reference,
    entryDate: row.entry_date,
    entryId: row.entry_id,
    placeOfSupplyRule: row.place_of_supply_rule,
    netFils: BigInt(row.net_fils),
    declaredFils: BigInt(row.declared_fils),
    reclaimedFils: BigInt(row.reclaimed_fils),
    ledgerDeclaredFils: BigInt(row.ledger_declared_fils),
    ledgerReclaimedFils: BigInt(row.ledger_reclaimed_fils),
    detail: detailFor(row),
  }))
}

/**
 * One sentence naming what is wrong, built from the figures rather than from the kind alone.
 *
 * The sentence is what reaches a person — in the report, in the outbox event and in the log line — and a
 * kind on its own ("pair_disagrees") tells them nothing about which figure to look at. It is derived here
 * rather than in SQL so the wording is not a string a query builds, and it is deterministic so two runs
 * produce identical output.
 */
function detailFor(row: {
  kind: string
  supplier_code: string
  net_fils: string
  declared_fils: string
  reclaimed_fils: string
  line_declared_fils: string
  line_reclaimed_fils: string
  ledger_declared_fils: string
  ledger_reclaimed_fils: string
}): string {
  switch (row.kind) {
    case 'missing_pair':
      return (
        `${row.supplier_code} supplies imported services and this bill declares no reverse charge on its ` +
        `${row.net_fils} fils of consideration, so the output VAT on it is declared nowhere`
      )
    case 'pair_disagrees':
      return (
        `declared ${row.declared_fils} fils of reverse-charge VAT and reclaimed ` +
        `${row.reclaimed_fils}, which is neither all of it nor none of it`
      )
    case 'totals_disagree':
      return (
        `the header declares ${row.declared_fils} fils and reclaims ${row.reclaimed_fils}, but its lines ` +
        `sum to ${row.line_declared_fils} and ${row.line_reclaimed_fils}`
      )
    default:
      return (
        `the bill declares ${row.declared_fils} fils and reclaims ${row.reclaimed_fils}, but its journal ` +
        `entry credits 2035 with ${row.ledger_declared_fils} and debits 1080 with ` +
        `${row.ledger_reclaimed_fils}`
      )
  }
}

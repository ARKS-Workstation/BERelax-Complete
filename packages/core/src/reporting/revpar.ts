import type { AccountCode } from '../ledger/account.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import type { KpiProvisionalMarker, KpiSpec, Measure } from './kpi-expression.ts'
import { kpiRef, measureRef, quotientOf } from './kpi-expression.ts'
import { AVAILABLE_ROOM_HOURS } from './utilisation.ts'

/**
 * Revenue per available room-hour (R-REP-03).
 *
 * # Why the numerator is a set of ACCOUNT CODES
 *
 * The acceptance line is "treatment net revenue in fils ÷ available_room_hours ... with tips and retail
 * excluded from the numerator". Neither exclusion can be made from an invoice: `invoice_line` (0026)
 * carries a description snapshot, a quantity and three money columns and **no revenue kind at all**, so
 * "which of these lines was a treatment" is not a question a tax document can answer. The distinction
 * exists exactly once in this build, in the chart of accounts, and that is where this reads it.
 *
 * The two exclusions are therefore of two different kinds, and the difference is worth stating because
 * only one of them is a rule anybody could get wrong:
 *
 *   * **Tips are not excluded. They are not revenue.** Migration 0068 records that "a tip is not
 *     consideration for a supply, so it appears on no tax invoice", and a gratuity taken at the till
 *     posts to `2040` tips payable — a LIABILITY, the salon holding the therapist's money. It is
 *     therefore outside {@link REVPARH_REVENUE_PARTITION} by construction, because that partition covers
 *     the chart's revenue accounts and `2040` is not one;
 *     `revparh-revenue-partition-claims-only-revenue-accounts` is what keeps it outside, rather than a
 *     filter that could be relaxed.
 *   * **Retail is excluded, and that is a choice with a reason.** A bottle of oil sold at the desk
 *     occupies no room-minute, so counting it would inflate a figure whose denominator is room-hours —
 *     which is the one way RevPARH can be made to look good without a single extra treatment delivered.
 *
 * # Why this is a declared PARTITION and not a list of included codes
 *
 * A list of included codes is satisfied by a chart that has grown an account nobody classified: the new
 * revenue lands in no set, the figure quietly drops it, and nothing fails. So both sides are declared,
 * and `kpi-registry.ts` holds the pair equal to `STANDARD_SPA_CHART` itself — an account added to the
 * chart and claimed by neither side is a failing test. That is ADR 0064's arrangement for the statement
 * layout, one subject along, and for the same reason: a grouping is not derivable from account numbers,
 * so it arrives with the check that holds it equal to what it groups.
 *
 * # What is provisional, and the consequence to live with
 *
 * The grouping is Y8-coa's second half — "what the accountant expects monthly" — and the marker is
 * carried on every result. Three of the seven placements are judgements rather than readings, and each
 * is stated on the entry below. The one that will move a reported figure is
 * **`4095` discounts and allowances**: there is one contra-revenue account for the whole business, so a
 * discount given on a retail product reduces this treatment numerator. Netting it out instead would
 * report RevPARH before discount, which is a gross figure wearing the word "net"; splitting it needs a
 * second discounts account, which is a chart decision and not a reporting one.
 */

/**
 * The chart's revenue accounts, split by whether the revenue was earned by occupying a room.
 *
 * Both sides stated, so an account in neither is a failing test. See this module's header.
 */
export const REVPARH_REVENUE_PARTITION: {
  readonly included: readonly AccountCode[]
  readonly excluded: readonly AccountCode[]
  readonly provisional: KpiProvisionalMarker
} = Object.freeze({
  included: Object.freeze([
    // A treatment delivered in a room, which is the figure's subject.
    ACCOUNTS.treatmentRevenue,
    // A package session redeemed is a treatment delivered in a room; the money arrived earlier.
    // Excluding it would make RevPARH FALL whenever a customer prepaid, which is a figure moving for a
    // payment-timing reason on a report about room productivity.
    ACCOUNTS.packageRedemptionRevenue,
    // A gift voucher redeemed is the same argument again: the supply happened, in a room, on this day.
    ACCOUNTS.voucherRedemptionRevenue,
    // Contra revenue, so it is NEGATIVE and the numerator is net of discount. The known imprecision —
    // one discounts account for the whole business, so a retail discount reduces this figure — is this
    // module's header's "consequence to live with".
    ACCOUNTS.discountsAndAllowances,
  ]),
  excluded: Object.freeze([
    // The acceptance line's own exclusion: a product sold at the desk occupies no room-minute.
    ACCOUNTS.retailRevenue,
    // An expired voucher is revenue with no supply and no room behind it. Whether it is a supply at all
    // is Y11-vat-package's question; either answer leaves it out of a room-productivity figure.
    ACCOUNTS.voucherBreakageRevenue,
    // Rent of a chair, a commission, a recharge: operating income that is not a treatment.
    ACCOUNTS.otherOperatingIncome,
  ]),
  provisional: Object.freeze({
    openQuestionId: 'Y8-coa',
    note:
      'Which revenue accounts count as room-occupying revenue is the second half of Y8-coa — what the ' +
      'accountant expects monthly. Answering it moves accounts between the two sides of ' +
      'REVPARH_REVENUE_PARTITION and changes no arithmetic; the partition is held equal to the chart, ' +
      'so an account added to the chart and classified by neither side is a failing test.',
  }),
})

/**
 * `Σ over revenue postings in scope on an included account of net_fils`.
 *
 * Signed as the ledger signs it: positive for a supply, negative for a credit note (`fact_sale` already
 * negates one, 0110) and negative for a posting to the contra discounts account. So the sum is net
 * revenue, and a month whose refunds exceed its takings produces a negative RevPARH rather than a
 * clamped zero — which is why {@link scaledFigure}'s rounding is half away from zero.
 */
export const TREATMENT_NET_REVENUE_FILS: Measure = {
  id: 'treatment_net_revenue_fils',
  summary:
    'Net revenue in fils, of VAT, earned by occupying a room: the postings in the period on the ' +
    'accounts REVPARH_REVENUE_PARTITION includes. Retail is excluded by that partition and a tip is ' +
    'not revenue at all — it is a liability on 2040 and appears on no tax invoice (0068).',
  unit: 'fils',
  reads: [
    'businessDays.businessDay',
    'revenueLines.businessDay',
    'revenueLines.accountCode',
    'revenueLines.netFils',
  ],
  reduce: (input) => {
    const days = new Set<string>()
    for (const day of input.businessDays) days.add(day.businessDay)
    const included = new Set<string>(REVPARH_REVENUE_PARTITION.included)
    let total = 0n
    for (const line of input.revenueLines) {
      if (!days.has(line.businessDay)) continue
      if (!included.has(line.accountCode)) continue
      total += line.netFils
    }
    return total
  },
}

export const REVENUE_PER_AVAILABLE_ROOM_HOUR: KpiSpec = {
  id: 'revenue_per_available_room_hour',
  label: 'Revenue per available room-hour (RevPARH)',
  summary:
    'Net treatment revenue in fils for every room-hour the premises could have sold. The denominator ' +
    'is available room-hours and never a room count, so closing a room for maintenance raises the ' +
    'figure rather than diluting it — the capacity genuinely was not for sale.',
  unit: 'fils_per_room_hour',
  expression: quotientOf(
    measureRef(TREATMENT_NET_REVENUE_FILS.id),
    kpiRef(AVAILABLE_ROOM_HOURS.id),
  ),
  provisional: REVPARH_REVENUE_PARTITION.provisional,
}

export const REVPAR_MEASURES: readonly Measure[] = [TREATMENT_NET_REVENUE_FILS]

export const REVPAR_KPIS: readonly KpiSpec[] = [REVENUE_PER_AVAILABLE_ROOM_HOUR]

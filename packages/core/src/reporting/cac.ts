import { AppError } from '@berelax/shared'
import type { CustomerAcquisitionSource } from '../crm/lifecycle.ts'
import { CUSTOMER_ACQUISITION_SOURCES } from '../crm/lifecycle.ts'
import type { AccountCode } from '../ledger/account.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import {
  COHORT_CUSTOMERS,
  COHORT_MONTHLY_CONTRIBUTION_PER_CUSTOMER,
  cohortMemberCount,
  cohortWindowCohorts,
} from './cohorts.ts'
import type {
  FirstTouchPaidState,
  KpiAcquisitionSpend,
  KpiProvisionalMarker,
  KpiSpec,
  Measure,
} from './kpi-expression.ts'
import { kpiRef, measureRef, quotientOf } from './kpi-expression.ts'

/**
 * Customer acquisition cost, its payback, and the share of acquisitions nobody can attribute (R-REP-05).
 *
 * # Both halves of CAC are missing from this build, and they are missing differently
 *
 * `CAC = paid acquisition spend ÷ new customers acquired through a paid channel`. The dispatch for this
 * unit said to check before assuming the spend figure exists. It does not, and neither does the
 * denominator's classification, and the two are different kinds of absence:
 *
 *   * **The spend is recorded and is NOT attributed to a channel.** Ad spend lands on
 *     `6070 Marketing and advertising` through `bill_line.expense_account_code` or
 *     `recurring_cost.expense_account_code` (migrations 0028 and 0031), and neither table has a channel
 *     column — a grep for one across every migration finds only the messaging estate's `channel`, which
 *     is an SMS-or-WhatsApp transport and not a marketing source. So the movement on `6070` is
 *     readable and it mixes paid acquisition with signage, print, the shopfront and anything else the
 *     owner files there. Measured on a database migrated and seeded from clean in this worktree: zero
 *     `bill_line` rows, zero `recurring_cost` rows and zero `journal_line` rows on `6070`, so today
 *     there is no spend figure at all, let alone a channel-attributed one.
 *   * **The denominator's classification does not exist and could not be derived from what does.**
 *     `customer_acquisition_source` (0053) holds six labels — `walk_in`, `whatsapp`, `phone`, `web`,
 *     `referral`, `unknown` — and NONE of them records whether the touch was bought. A `web` booking
 *     may have arrived from organic search, from a link in a reminder or from an advertisement, and the
 *     row cannot tell the three apart. Paid-ness is a property of the TOUCH, which is A-FIRST-08's
 *     attribution row and its medium, and that unit does not exist yet.
 *
 * So the response is the one brief rule 15 and ADR 0070 both prescribe: **the mechanism goes in and the
 * figure becomes an open question.** {@link FIRST_TOUCH_PAID_CLASSIFICATION} classifies all six sources
 * as `not_recorded` with a reason on each, {@link spendNotChannelAttributed} refuses a total that no
 * channel claims, and `Y9-paid-channel-attribution` is the row in `docs/OPEN-QUESTIONS.md` that would
 * answer both halves. Nothing here holds a rate, a share or a default.
 *
 * **Classifying `web` as paid would have been one line and is exactly the refused move.** It is the same
 * shape as ADR 0070's rejected pro-rata allocation: a policy decision disguised as a calculation, where
 * the choice decides the figure and the figure is what an acquisition budget is set from. A plausible
 * classification is indistinguishable from a recorded one, and `Y9-crm-source` already says the same
 * thing about the labels themselves — "a plausible attribution is indistinguishable from a recorded one".
 *
 * # Why the unattributed share is published beside every figure rather than folded into one
 *
 * The acceptance line asks for it: "the unattributated share is reported alongside as a percentage". It
 * is R-REP-04's `kpiDiscountCoverage` arrangement — ADR 0070 names this unit as where it came from — and
 * the reason is that a CAC over the attributed subset is a figure whose denominator moves with how much
 * happens to be known. With the share beside it, a CAC computed over 4% of acquisitions is visibly a
 * CAC computed over 4% of acquisitions. Against this build's own data the share is the whole of it.
 *
 * Nothing here reads a clock or performs I/O. Every money figure is a `bigint` and none is a `Fils`.
 */

// --- is a first touch a paid one -----------------------------------------------------------------

/** One acquisition source's paid-ness, with the reason it reads that way. */
export interface FirstTouchClassification {
  readonly state: FirstTouchPaidState
  /** Why. Read by whoever answers `Y9-paid-channel-attribution`. */
  readonly why: string
}

/**
 * Whether each acquisition label records a PAID first touch. All six: it does not.
 *
 * A `Record` over the union, so a label added to `CUSTOMER_ACQUISITION_SOURCES` and left unclassified is
 * a `pnpm typecheck` failure naming this file. That is stronger than the runtime findings rule
 * `REVPARH_REVENUE_PARTITION` needs, and it is available here because the vocabulary is a closed union
 * in `packages/core` while a chart of accounts is a list of rows.
 *
 * Every entry is `not_recorded` and that is the finding, not a placeholder. It is deliberately NOT
 * `unpaid`: `unpaid` would be the claim that these customers cost nothing to acquire, which is what a
 * CAC denominator of nought computed over a real advertising spend would then report as an infinite
 * cost per paid customer — or, with the spend also absent, as a tidy zero.
 */
export const FIRST_TOUCH_PAID_CLASSIFICATION: Record<
  CustomerAcquisitionSource,
  FirstTouchClassification
> = Object.freeze({
  walk_in: {
    state: 'not_recorded',
    why:
      'Somebody came in off Al Wasl Road. Whether they were walking past or had seen an advertisement ' +
      'is exactly what nobody asked them, and the label records the door they used rather than the ' +
      'reason they chose it.',
  },
  whatsapp: {
    state: 'not_recorded',
    why:
      'The published WhatsApp number is on the shopfront, in the directory listings and in any paid ' +
      'placement that carries a click-to-chat link. The label records the transport and not the source.',
  },
  phone: {
    state: 'not_recorded',
    why:
      'A telephone call records the transport. A call-only advertisement and a word-of-mouth call ' +
      'arrive identically.',
  },
  web: {
    state: 'not_recorded',
    why:
      'The one most likely to be classified as paid, and the one where doing so would be wrong most ' +
      'often: organic search, a direct visit, a link in a reminder message and an advertisement click ' +
      "all produce `web`. The medium that would separate them is A-FIRST-08's attribution row.",
  },
  referral: {
    state: 'not_recorded',
    why:
      'A client sent them. Not classified `unpaid`, because a referral scheme that pays a reward is a ' +
      'paid acquisition with a cost nothing in this build records, and nothing says whether there is ' +
      'one.',
  },
  unknown: {
    state: 'not_recorded',
    why:
      'Nobody wrote down where this record came from. It is the DEFAULT and it is true of every ' +
      'customer the business already had (0053), so it is the largest group and the honest answer.',
  },
} satisfies Record<CustomerAcquisitionSource, FirstTouchClassification>)

/**
 * The paid-ness of a first touch recorded only as an acquisition label.
 *
 * The db query reads this, which is why every real cohort member today arrives as `not_recorded`. When
 * A-FIRST-08 lands, the member's `firstTouch` is resolved from the attribution row's medium instead and
 * this function narrows to the rows that have no attribution — which is what the deferral in
 * `build/manifest.yaml` hands it.
 */
export const firstTouchPaidStateOf = (source: CustomerAcquisitionSource): FirstTouchPaidState =>
  FIRST_TOUCH_PAID_CLASSIFICATION[source].state

/** Every label this build can classify, so a caller can enumerate rather than spell one. */
export const CLASSIFIED_ACQUISITION_SOURCES: readonly CustomerAcquisitionSource[] = Object.freeze([
  ...CUSTOMER_ACQUISITION_SOURCES,
])

/**
 * The expense accounts acquisition spend could be read from, stated here and passed as an ARGUMENT.
 *
 * `packages/db` may never import `packages/core` (ADR 0001), so the query module takes the codes rather
 * than spelling them — the arrangement R-REP-04 put in place and gate case 148n enforces by refusing a
 * four-digit string literal in `kpi-queries.ts`. One account, because the chart has one marketing
 * account for the whole business; splitting paid media out of it is a chart decision (Y8-coa) and not a
 * reporting one.
 */
export const ACQUISITION_SPEND_ACCOUNTS: readonly AccountCode[] = Object.freeze([
  ACCOUNTS.marketing,
])

/** The open question both halves of CAC are waiting on. Copied onto every figure CAC produces. */
export const PAID_CHANNEL_ATTRIBUTION_PROVISIONAL: KpiProvisionalMarker = Object.freeze({
  openQuestionId: 'Y9-paid-channel-attribution',
  note:
    'Which acquisition channels are PAID, and how a cost is tagged to one. No acquisition label in ' +
    '0053 records paid-ness and no cost table carries a channel, so both the CAC numerator and its ' +
    'denominator are mechanisms without figures. Answering it is an attribution medium (A-FIRST-08) ' +
    'plus a channel on a bill line; no arithmetic here changes.',
})

// --- the spend, which is stated or refused and never a total that looks like one ----------------

/**
 * Acquisition spend for a period: attributed to paid channels, or a total that no channel claims.
 *
 * Two states and not three. A period in which the business genuinely spent nothing on a paid channel is
 * `channel_attributed` with no rows and a basis that says what was measured — a real figure of zero,
 * which is what makes a CAC of zero legible. `not_channel_attributed` is the state this build's own
 * ledger is in whenever `6070` has moved: a figure exists and nothing says which of it bought customers.
 *
 * There is no `measured total` state, because that is the one shape a caller would be tempted to divide
 * by: the whole marketing movement over the paid-channel customers is a CAC that is too high by every
 * dirham of signage and too low by nothing, and it would look exactly like a CAC.
 */
export type AcquisitionSpendStatement =
  | {
      readonly state: 'channel_attributed'
      readonly rows: readonly KpiAcquisitionSpend[]
      readonly basis: string
    }
  | {
      readonly state: 'not_channel_attributed'
      /** What the expense accounts moved by. Reported, and deliberately not called acquisition spend. */
      readonly unattributedTotalFils: bigint
      readonly basis: string
      readonly openQuestionIds: readonly string[]
    }

const requireBasis = (basis: string): string => {
  if (basis.trim() === '') {
    throw new AppError(
      'validation',
      'An acquisition spend statement must say what it was taken from. A spend figure with no stated ' +
        'basis is a figure nobody can check and nobody can correct.',
    )
  }
  return basis
}

/** Spend each of whose rows names the paid channel it bought. Empty rows is a measured zero. */
export function channelAttributedSpend(
  rows: readonly KpiAcquisitionSpend[],
  basis: string,
): AcquisitionSpendStatement {
  for (const row of rows) {
    if (row.channel.trim() === '') {
      throw new AppError(
        'validation',
        `An acquisition spend row of ${row.netFils} fils in ${row.cohortMonth} names no channel. A row ` +
          'with a blank channel is an unattributed total wearing the attributed state.',
        { details: { cohortMonth: row.cohortMonth, netFils: row.netFils.toString() } },
      )
    }
    if (row.netFils < 0n) {
      throw new AppError(
        'validation',
        `Acquisition spend of ${row.netFils} fils on ${row.channel} is negative. A credit from a ` +
          "platform is a reduction of that month's spend and belongs in that month's row, not as a " +
          'negative that could make a CAC smaller than the money that left.',
        { details: { channel: row.channel, netFils: row.netFils.toString() } },
      )
    }
  }
  return Object.freeze({
    state: 'channel_attributed' as const,
    rows: Object.freeze([...rows]),
    basis: requireBasis(basis),
  })
}

/** A marketing total that no channel claims, which is what this build's ledger can produce. */
export function spendNotChannelAttributed(
  unattributedTotalFils: bigint,
  basis: string,
  openQuestionIds: readonly string[] = ['Y9-paid-channel-attribution'],
): AcquisitionSpendStatement {
  if (openQuestionIds.length === 0) {
    throw new AppError(
      'validation',
      'Spend reported as unattributed must name the open question that would attribute it. An ' +
        'unattributable figure with nothing to chase is an answer nobody is waiting for.',
    )
  }
  return Object.freeze({
    state: 'not_channel_attributed' as const,
    unattributedTotalFils,
    basis: requireBasis(basis),
    openQuestionIds: Object.freeze([...openQuestionIds]),
  })
}

/** Raised when a CAC is asked for over spend that no channel claims. See {@link acquisitionSpendRows}. */
export class AcquisitionSpendNotAttributable extends AppError {
  constructor(totalFils: bigint, basis: string, openQuestionIds: readonly string[]) {
    super(
      'invariant_violated',
      `The period's marketing movement of ${totalFils} fils is not attributed to any channel ` +
        `(${basis}), so there is no paid acquisition spend to divide. Dividing the whole movement by ` +
        'the paid-channel customers would produce a figure indistinguishable from a CAC and wrong by ' +
        `every dirham of signage, print and shopfront in it. ${openQuestionIds.join(', ')}.`,
      {
        details: {
          totalFils: totalFils.toString(),
          basis,
          openQuestionIds: [...openQuestionIds],
        },
      },
    )
    this.name = 'AcquisitionSpendNotAttributable'
  }
}

/**
 * The `acquisitionSpend` dataset rows, or the refusal.
 *
 * The only way spend reaches the registry, which is what keeps an unattributed total out of a figure
 * structurally rather than by a reviewer noticing. A measure can only return a `bigint`, so an absent
 * spend would arrive as an empty dataset and a CAC of zero — the forbidden substitution ADR 0070 is
 * about, with the sign reversed: a free customer rather than a free treatment.
 */
export function acquisitionSpendRows(
  statement: AcquisitionSpendStatement,
): readonly KpiAcquisitionSpend[] {
  if (statement.state === 'not_channel_attributed') {
    throw new AcquisitionSpendNotAttributable(
      statement.unattributedTotalFils,
      statement.basis,
      statement.openQuestionIds,
    )
  }
  return statement.rows
}

// --- the measures -------------------------------------------------------------------------------

export const PAID_CHANNEL_ACQUISITION_SPEND_FILS: Measure = {
  id: 'paid_channel_acquisition_spend_fils',
  summary:
    'What was spent on paid channels in the cohort months the window covers, in fils net of ' +
    'recoverable VAT. Only channel-attributed spend can be in the dataset — acquisitionSpendRows() ' +
    'refuses a marketing total that no channel claims — so this is never the 6070 movement in disguise.',
  unit: 'fils',
  reads: ['cohortMonths.cohortMonth', 'acquisitionSpend.cohortMonth', 'acquisitionSpend.netFils'],
  reduce: (input) => {
    // The ACQUISITION month and not the window's months: a cohort's cost is what was spent to win it,
    // which is month 0 only. Summing the window would add eleven later months of advertising to the
    // cost of one cohort, and the figure would rise the longer the cohort was observed.
    const cohorts = cohortWindowCohorts(input.cohortMonths)
    let total = 0n
    for (const row of input.acquisitionSpend) {
      if (!cohorts.has(row.cohortMonth)) continue
      total += row.netFils
    }
    return total
  },
}

const PAID: readonly FirstTouchPaidState[] = ['paid']
const NOT_RECORDED: readonly FirstTouchPaidState[] = ['not_recorded']

export const NEW_CUSTOMERS_FROM_PAID_CHANNELS: Measure = {
  id: 'new_customers_from_paid_channels',
  summary:
    'How many of the window\'s new customers had a PAID first touch. The acceptance line\'s "only": a ' +
    'denominator counting every new customer would divide paid spend by people who arrived by ' +
    "referral and report a CAC a fraction of the real one. Against this build's data it is nought, " +
    'because no acquisition label records paid-ness (FIRST_TOUCH_PAID_CLASSIFICATION).',
  unit: 'customers',
  reads: [
    'cohortMonths.cohortMonth',
    'cohortMembers.cohortMonth',
    'cohortMembers.customerId',
    'cohortMembers.firstTouch',
  ],
  reduce: (input) =>
    cohortMemberCount(input.cohortMembers, cohortWindowCohorts(input.cohortMonths), PAID),
}

export const NEW_CUSTOMERS_WITH_UNRECORDED_FIRST_TOUCH: Measure = {
  id: 'new_customers_with_unrecorded_first_touch',
  summary:
    "How many of the window's new customers nothing can attribute to a channel at all. Published " +
    'beside every CAC so a figure computed over a fraction of the acquisitions is visibly that ' +
    "(R-REP-04's discount-coverage arrangement, which ADR 0070 names this unit as the source of).",
  unit: 'customers',
  reads: [
    'cohortMonths.cohortMonth',
    'cohortMembers.cohortMonth',
    'cohortMembers.customerId',
    'cohortMembers.firstTouch',
  ],
  reduce: (input) =>
    cohortMemberCount(input.cohortMembers, cohortWindowCohorts(input.cohortMonths), NOT_RECORDED),
}

export const CAC_MEASURES: readonly Measure[] = Object.freeze([
  PAID_CHANNEL_ACQUISITION_SPEND_FILS,
  NEW_CUSTOMERS_FROM_PAID_CHANNELS,
  NEW_CUSTOMERS_WITH_UNRECORDED_FIRST_TOUCH,
])

// --- the KPIs -----------------------------------------------------------------------------------

export const CUSTOMER_ACQUISITION_COST: KpiSpec = {
  id: 'customer_acquisition_cost',
  label: 'Customer acquisition cost (CAC)',
  summary:
    'Paid acquisition spend per new customer whose first touch was a paid one. Both halves are ' +
    'mechanisms without figures in this build: no cost table carries a marketing channel, and no ' +
    'acquisition label records whether a touch was bought — so the denominator is nought and the ' +
    'answer is no_denominator naming it. Read acquisition_unattributed_share beside it, always.',
  unit: 'fils_per_customer',
  expression: quotientOf(
    measureRef(PAID_CHANNEL_ACQUISITION_SPEND_FILS.id),
    measureRef(NEW_CUSTOMERS_FROM_PAID_CHANNELS.id),
  ),
  provisional: PAID_CHANNEL_ATTRIBUTION_PROVISIONAL,
}

export const ACQUISITION_UNATTRIBUTED_SHARE: KpiSpec = {
  id: 'acquisition_unattributed_share',
  label: 'Share of acquisitions with no recorded channel',
  summary:
    "The fraction of the window's new customers whose first touch nothing can attribute. A ratio, " +
    'published to four decimal places, so it reads in basis points. A CAC is only as meaningful as ' +
    'one minus this figure, which is why they are published together and never separately.',
  unit: 'ratio',
  expression: quotientOf(
    measureRef(NEW_CUSTOMERS_WITH_UNRECORDED_FIRST_TOUCH.id),
    measureRef(COHORT_CUSTOMERS.id),
  ),
  provisional: PAID_CHANNEL_ATTRIBUTION_PROVISIONAL,
}

/**
 * How many months of the cohort's own realised run rate it takes to earn the acquisition cost back.
 *
 * The acceptance line's "returning NoDenominator when contribution is zero" is structural rather than a
 * branch: the divisor is a KPI, the expression language answers a zero divisor with `NoDenominator`
 * naming the rendered divisor, and `bigint` division throws rather than producing `Infinity` even if
 * that answer were removed (ADR 0068). A cohort that has contributed nothing has no payback — not a
 * payback of nought, and not one of infinity months.
 *
 * It divides by the REALISED run rate, so the figure is "at this cohort's observed rate, this many
 * months" and not "this cohort will pay back in this many months". The second sentence is a forecast and
 * is what the arch rule over this module's import closure exists to keep out of the path.
 */
export const CAC_PAYBACK_MONTHS: KpiSpec = {
  id: 'cac_payback_months',
  label: "CAC payback, in months of the cohort's own realised rate",
  summary:
    'The acquisition cost divided by the monthly net contribution a customer in this cohort has ' +
    'ACTUALLY produced. A statement about an observed rate and not a prediction of a date: the rate is ' +
    'the average over the months the cohort has lived, and a cohort that has contributed nothing ' +
    'answers no_denominator rather than a payback of nought or of infinity.',
  unit: 'months',
  expression: quotientOf(
    kpiRef(CUSTOMER_ACQUISITION_COST.id),
    kpiRef(COHORT_MONTHLY_CONTRIBUTION_PER_CUSTOMER.id),
  ),
  provisional: PAID_CHANNEL_ATTRIBUTION_PROVISIONAL,
}

export const CAC_KPIS: readonly KpiSpec[] = Object.freeze([
  CUSTOMER_ACQUISITION_COST,
  ACQUISITION_UNATTRIBUTED_SHARE,
  CAC_PAYBACK_MONTHS,
])

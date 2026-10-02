import { AppError } from '@berelax/shared'
import type { TenderKind } from '../checkout/posting.ts'
import { TENDER_ACCOUNT } from '../checkout/posting.ts'
import type { AccountCode } from '../ledger/account.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'

/**
 * Contribution margin per service: net price minus the costs attributable to the delivery (R-REP-04).
 *
 * # The whole difficulty is the word "attributable"
 *
 * `contribution_margin_unit = net_price - (therapist_cost + consumables + room_consumables +
 * payment_fee)` is one subtraction. What makes it hard is that four of those five figures are not the
 * same KIND of thing, and three of them do not exist in this build at all:
 *
 *   * **`net_price`** exists and is a SNAPSHOT. A treatment sold at the till carries it on
 *     `invoice_line`, and a treatment taken out of a package carries it on `package_redemption` — the
 *     gross released from the deferred-revenue account when that session was delivered. Neither is a
 *     catalogue lookup, which is the acceptance line "a package redemption contributes revenue at the
 *     snapshotted per-session price, not the package price current on the day the report runs".
 *     {@link NetPriceSource} is why that is structural rather than a promise: the only way to state a
 *     net price here is to name the row it was read from, and the catalogue has no such row.
 *   * **`therapist_cost`** does not exist per treatment. P-HR-11's commission is per treatment and its
 *     module ships disabled with no published rule version (Y9-commission), so there are no commission
 *     lines; and the wage path cannot be derived either, because all nineteen employment records carry
 *     `basic_wage_fils` NULL (Y8-staff). A monthly salary is in any case a cost of the MONTH and not of
 *     a treatment, so turning one into a per-treatment figure needs an attribution basis nobody has
 *     stated — see the ADR.
 *   * **`consumables` and `room_consumables`** do not exist per service either. The ledger holds the
 *     period's total on `6030 Treatment consumables used`, and nothing anywhere records what one
 *     treatment consumed. There is no bill of materials, no product per service and no room cost.
 *   * **`payment_fee`** has no rate anywhere in the build. For `cash` and `bank_transfer` it is zero by
 *     CONSTRUCTION — there is no acquirer to charge one — and for a card tender it is the merchant
 *     service charge in an agreement nobody has signed (Y7-card-fee, beside Y7-mcc).
 *
 * # So a component has three states, and `0` is not one of them
 *
 * {@link CostComponent} is `measured`, `none_by_construction` or `unattributable`. Substituting zero for
 * an unknown cost is not a conservative simplification: it reports the HIGHEST possible margin, on the
 * screen where somebody decides what to charge. This build has measured that failure once already —
 * `rota_version.forecast_unpriced_employees` exists because "an employee with no wage contributes
 * nothing to a sum, so a forecast over a rota where no wage is recorded is 0 fils and reads as a free
 * rota", and all nineteen seeded employees are in exactly that state. The same arithmetic one subject
 * along would read as a treatment that costs nothing to deliver.
 *
 * `none_by_construction` is deliberately NOT the same state as `measured 0`. A cash tender carries no
 * acquirer fee because there is no acquirer; a card tender measured at 0 fils would mean an acquirer
 * that charged nothing. The two are indistinguishable as numbers and are different facts, and the one
 * that will one day be wrong is the one that was never stated.
 *
 * # What the margin therefore is
 *
 * {@link contributionMarginUnit} returns a FIGURE only when every one of the four components is stated
 * and none is `unattributable`. Otherwise it returns `not_attributable`, naming the components and the
 * open questions — which is a result a tile can render (R-REP-07's typed result is the same idea) and
 * is not a number anybody can act on by mistake.
 *
 * Every component must be stated exactly once. A partial cost list summed as though it were complete is
 * the same overstatement as a zero, arriving as an omission instead of a value, so
 * {@link contributionMarginUnit} refuses one — ADR 0064's "total, disjoint partition" discipline applied
 * to the cost side of a margin rather than to the sections of a balance sheet.
 *
 * # Every figure is a `bigint`
 *
 * `packages/db/src/queries/trial-balance.ts` records what a `number` did to a cumulative ledger
 * position: 2^53 + 1 fils on each side reported a difference of -4 fils out of nothing, because the two
 * sides round independently. A margin aggregated over a period is the same cumulative shape, and `Fils`
 * in `../money.ts` is a branded `number` capped at `Number.MAX_SAFE_INTEGER`. So nothing here is `Fils`,
 * exactly as in `./statements.ts`.
 *
 * Nothing in this module reads a clock, performs I/O or consults the catalogue.
 */

// --- the four components ------------------------------------------------------------------------

/**
 * The four deductions, closed and in the order the formula states them.
 *
 * Closed, because the open alternative is a cost list a caller can be one element short of without
 * anything noticing — and a margin that is too high by a cost nobody passed looks exactly like a
 * margin. There is no `other`: an `other` bucket absorbs every case nobody wanted to classify and is
 * the largest component within a quarter.
 */
export const COST_COMPONENTS = [
  'therapist',
  'consumables',
  'room_consumables',
  'payment_fee',
] as const

export type CostComponentId = (typeof COST_COMPONENTS)[number]

/**
 * What each component is, as data.
 *
 * A `Record` over the union, so a component added to {@link COST_COMPONENTS} and left undescribed fails
 * `pnpm typecheck` naming this file. The prose is read by whoever has to answer the open question.
 */
export const COST_COMPONENT_NOTES: Record<CostComponentId, string> = {
  therapist:
    'What the therapist who delivered this treatment cost for the minutes it took: commission under ' +
    'the rule version that judged it, plus the wage attributable to those minutes. P-HR-11 produces ' +
    'the first per appointment; the second needs a wage and an attribution basis (Y8-staff, ' +
    'Y9-unit-cost-basis).',
  consumables:
    'Oil, wax, linen and anything else consumed by this treatment. The ledger holds the period total ' +
    'on 6030; nothing records per-treatment usage (Y9-unit-cost-basis).',
  room_consumables:
    'What the ROOM consumed for this delivery as distinct from the treatment — a wet room is the case ' +
    'that makes it a separate component rather than part of the treatment (Y9-unit-cost-basis).',
  payment_fee:
    'The acquirer or processor fee on the tender that settled this delivery. Zero by construction for ' +
    'cash and bank transfer, which have no acquirer; unknown for a card tender (Y7-card-fee).',
}

/** The open question each component is waiting on, so an `unattributable` result can name it. */
export const COST_COMPONENT_OPEN_QUESTIONS: Record<CostComponentId, readonly string[]> = {
  therapist: ['Y9-commission', 'Y8-staff', 'Y9-unit-cost-basis'],
  consumables: ['Y9-unit-cost-basis'],
  room_consumables: ['Y9-unit-cost-basis'],
  payment_fee: ['Y7-card-fee'],
}

/**
 * One component's value, in one of three states.
 *
 * `basis` is not decoration: it is what the person reading a margin needs in order to disagree with it.
 * A `measured` component says which row the figure came from, and an `unattributable` one says what
 * would have to exist for it to become a figure.
 */
export type CostComponent =
  | {
      readonly component: CostComponentId
      readonly state: 'measured'
      readonly fils: bigint
      readonly basis: string
    }
  | {
      readonly component: CostComponentId
      readonly state: 'none_by_construction'
      readonly basis: string
    }
  | {
      readonly component: CostComponentId
      readonly state: 'unattributable'
      readonly openQuestionIds: readonly string[]
      readonly basis: string
    }

const requireBasis = (basis: string, component: CostComponentId): string => {
  if (basis.trim() === '') {
    throw new AppError(
      'validation',
      `A ${component} cost must say what it was taken from. A figure with no stated basis is a figure ` +
        'nobody can check and nobody can correct.',
      { details: { component } },
    )
  }
  return basis
}

/**
 * A component measured against a row that exists.
 *
 * Negative is refused, and that refusal is what makes "contribution margin <= net revenue" a property
 * rather than a hope: the inequality holds for every input precisely because no cost can be negative.
 * A negative cost is a rebate or a credit, which is revenue and belongs on the other side of the
 * subtraction.
 */
export function measuredCost(
  component: CostComponentId,
  fils: bigint,
  basis: string,
): CostComponent {
  if (fils < 0n) {
    throw new AppError(
      'validation',
      `A ${component} cost of ${fils} fils is negative. A cost that gives money back is a rebate, ` +
        'which is revenue and belongs on the other side of the subtraction — not a cost with a minus ' +
        'sign, which would make a margin larger than the price.',
      { details: { component, fils: fils.toString() } },
    )
  }
  return Object.freeze({
    component,
    state: 'measured' as const,
    fils,
    basis: requireBasis(basis, component),
  })
}

/**
 * A component that is zero because the thing that would charge it does not exist.
 *
 * The one state that is a genuine zero. Kept distinct from `measured 0n` because the two are the same
 * number and different claims, and only one of them survives somebody signing an acquirer agreement.
 */
export function noCostByConstruction(component: CostComponentId, basis: string): CostComponent {
  return Object.freeze({
    component,
    state: 'none_by_construction' as const,
    basis: requireBasis(basis, component),
  })
}

/**
 * A component nothing in this build can put a figure on.
 *
 * It names the open questions rather than describing them, so the Unconfirmed Assumptions panel and a
 * margin tile point at the same row of `docs/OPEN-QUESTIONS.md`.
 */
export function unattributableCost(
  component: CostComponentId,
  basis: string,
  openQuestionIds: readonly string[] = COST_COMPONENT_OPEN_QUESTIONS[component],
): CostComponent {
  if (openQuestionIds.length === 0) {
    throw new AppError(
      'validation',
      `A ${component} cost reported as unattributable must name the open question that would answer ` +
        'it. An unattributable figure with nothing to chase is an answer nobody is waiting for.',
      { details: { component } },
    )
  }
  return Object.freeze({
    component,
    state: 'unattributable' as const,
    openQuestionIds: Object.freeze([...openQuestionIds]),
    basis: requireBasis(basis, component),
  })
}

// --- the one component with a real answer for part of the population ----------------------------

/**
 * The accounts a PROCESSOR settles through, net of its own fee. Stated once, here.
 *
 * Which tenders carry a processing fee is not a new fact: it is already recorded in where each tender is
 * debited. `0068_payment_tender.sql` gives the reason in so many words — "the terminal settles in a
 * batch, net of fees, days later, and debiting 1020 would leave the bank reconciliation permanently out
 * by every unsettled batch" — which is why `card_in_salon` debits `1040 Card terminal clearing` and
 * `card_online` debits `1030 Payment gateway clearing`. Cash is in the drawer and a bank transfer lands
 * in the bank, so neither passes through anybody who could take a cut.
 *
 * So this list is the DERIVATION rather than a second opinion, and {@link paymentFeeComponent} reads
 * `TENDER_ACCOUNT` — the registry's own statement of where each tender posts — instead of listing the
 * tenders again. A tender kind added to `TENDER_KINDS` is therefore classified by construction, and
 * `contribution-margin.test.ts` enumerates the registry to prove it.
 *
 * Note what this is NOT: a fee, a rate or a figure. The merchant service charge on a card tender is in
 * an agreement nobody has signed (Y7-card-fee, beside Y7-mcc), so a card delivery's payment fee is
 * `unattributable` and a cash one is `none_by_construction`.
 */
export const PROCESSOR_CLEARING_ACCOUNTS: readonly AccountCode[] = Object.freeze([
  ACCOUNTS.cardTerminalClearing,
  ACCOUNTS.gatewayClearing,
])

/** True when a tender of this kind clears through a processor that settles net of its own fee. */
export function tenderClearsThroughAProcessor(kind: TenderKind): boolean {
  return PROCESSOR_CLEARING_ACCOUNTS.includes(TENDER_ACCOUNT[kind])
}

/**
 * The payment-fee component for a delivery settled by these tenders.
 *
 * Three answers, and the middle one is the point:
 *
 *   * no tender at all — a package redemption, whose money arrived when the package was sold — is
 *     `none_by_construction` on THIS delivery. The fee on the package sale belongs to the sale.
 *   * every tender in hand (cash, bank transfer) is `none_by_construction`: there is no acquirer.
 *   * any tender clearing through a processor makes the whole delivery `unattributable`, because the
 *     rate is unknown. Not "the known part of the fee": a document settled half in cash and half on a
 *     card has an unknown fee on the card half, and reporting the cash half's zero would be a fee of
 *     zero on the whole.
 */
export function paymentFeeComponent(tenderKinds: readonly TenderKind[]): CostComponent {
  const processed = tenderKinds.filter(tenderClearsThroughAProcessor)
  if (processed.length > 0) {
    return unattributableCost(
      'payment_fee',
      `settled by ${processed.join(', ')}, which clear through a processor that takes its fee out of ` +
        'the batch. No merchant service charge is recorded anywhere in this build',
      ['Y7-card-fee'],
    )
  }
  if (tenderKinds.length === 0) {
    return noCostByConstruction(
      'payment_fee',
      'no tender on this delivery: a package redemption releases money taken when the package was ' +
        'sold, so any fee belongs to that sale',
    )
  }
  return noCostByConstruction(
    'payment_fee',
    `settled by ${tenderKinds.join(', ')}, which the business receives in hand — there is no acquirer ` +
      'or processor to charge a fee',
  )
}

// --- where a net price is allowed to come from --------------------------------------------------

/**
 * The row a net price was read from. There is no third shape, and no shape for a catalogue price.
 *
 * This is the acceptance line "a package redemption contributes revenue at the snapshotted per-session
 * price, not the package price current on the day the report runs", made structural. `dim_service`
 * carries `list_gross_fils` and migration 0110's own comment says why it is named `list_`: it is the
 * price TODAY. A margin computed against it would move every historic figure the next time the owner
 * edited the menu. There is nowhere in this type to put one.
 */
export type NetPriceSource =
  | { readonly basis: 'invoice_line'; readonly invoiceId: string; readonly lineNo: number }
  | { readonly basis: 'package_redemption'; readonly redemptionId: string }

export const NET_PRICE_BASES = ['invoice_line', 'package_redemption'] as const
export type NetPriceBasis = (typeof NET_PRICE_BASES)[number]

const describeSource = (source: NetPriceSource): string =>
  source.basis === 'invoice_line'
    ? `invoice_line ${source.invoiceId}#${source.lineNo}`
    : `package_redemption ${source.redemptionId}`

// --- one delivery -------------------------------------------------------------------------------

export interface ContributionMarginInput {
  /** The appointment this margin is about. One delivery, one margin. */
  readonly appointmentId: string
  readonly serviceVariantId: string
  /** The treatment style, carried so a report can group Asian and Arabic without a second join. */
  readonly treatmentStyle: string
  /** The net of the snapshotted gross, VAT excluded, as stored on the row `source` names. */
  readonly netPriceFils: bigint
  readonly source: NetPriceSource
  /** Every component of {@link COST_COMPONENTS}, exactly once. */
  readonly costs: readonly CostComponent[]
}

/** A margin, or the reason there is not one. Never a number with a gap in it. */
export type ContributionMarginUnit =
  | {
      readonly state: 'margin'
      readonly appointmentId: string
      readonly serviceVariantId: string
      readonly treatmentStyle: string
      readonly netPriceFils: bigint
      readonly costFils: bigint
      readonly marginFils: bigint
      readonly components: readonly CostComponent[]
      readonly netPriceBasis: string
    }
  | {
      readonly state: 'not_attributable'
      readonly appointmentId: string
      readonly serviceVariantId: string
      readonly treatmentStyle: string
      readonly netPriceFils: bigint
      /** What the stated components add up to. Reported, and deliberately not called a cost total. */
      readonly attributedCostFils: bigint
      readonly missing: readonly CostComponentId[]
      readonly openQuestionIds: readonly string[]
      readonly components: readonly CostComponent[]
      readonly netPriceBasis: string
    }

/**
 * Holds the cost list to a total, disjoint statement of {@link COST_COMPONENTS}.
 *
 * Both directions, and the first is the one that matters: a component NOT stated is the overstatement
 * this module exists to refuse, arriving as an omission rather than as a zero. The second — a component
 * stated twice — would double a cost and understate a margin, which is the less dangerous error and is
 * refused anyway, because a caller that stated one twice has no idea which figure it meant.
 */
function assertComponentsStatedOnce(
  costs: readonly CostComponent[],
  appointmentId: string,
): ReadonlyMap<CostComponentId, CostComponent> {
  const byId = new Map<CostComponentId, CostComponent>()
  const repeated: CostComponentId[] = []
  for (const cost of costs) {
    if (byId.has(cost.component)) repeated.push(cost.component)
    byId.set(cost.component, cost)
  }
  const absent = COST_COMPONENTS.filter((component) => !byId.has(component))
  if (absent.length > 0 || repeated.length > 0) {
    throw new AppError(
      'invariant_violated',
      `The cost of appointment ${appointmentId} does not state every component exactly once: ` +
        `${absent.length > 0 ? `absent ${absent.join(', ')}` : 'none absent'}; ` +
        `${repeated.length > 0 ? `repeated ${repeated.join(', ')}` : 'none repeated'}. ` +
        'A component left out is summed as zero, which reports the highest possible margin on the ' +
        'screen somebody prices from — state it as unattributable instead.',
      { details: { appointmentId, absent, repeated, stated: costs.map((c) => c.component) } },
    )
  }
  return byId
}

/**
 * One delivery's contribution margin, or the named reason there is not one.
 *
 * The subtraction is trivial and the two refusals are the content: the cost list must be complete, and
 * a cost nobody can put a figure on makes the margin `not_attributable` rather than optimistic.
 */
export function contributionMarginUnit(input: ContributionMarginInput): ContributionMarginUnit {
  if (input.netPriceFils < 0n) {
    throw new AppError(
      'validation',
      `A net price of ${input.netPriceFils} fils on appointment ${input.appointmentId} is negative. A ` +
        'credit note is a document of its own with its own sign (0072); a negative price here would ' +
        'make a margin out of money that went back.',
      { details: { appointmentId: input.appointmentId } },
    )
  }
  const byId = assertComponentsStatedOnce(input.costs, input.appointmentId)
  const components = Object.freeze(COST_COMPONENTS.map((id) => byId.get(id) as CostComponent))
  const netPriceBasis = describeSource(input.source)

  let attributedCostFils = 0n
  const missing: CostComponentId[] = []
  const openQuestionIds = new Set<string>()
  for (const component of components) {
    if (component.state === 'measured') {
      attributedCostFils += component.fils
      continue
    }
    if (component.state === 'none_by_construction') continue
    missing.push(component.component)
    for (const id of component.openQuestionIds) openQuestionIds.add(id)
  }

  if (missing.length > 0) {
    return Object.freeze({
      state: 'not_attributable' as const,
      appointmentId: input.appointmentId,
      serviceVariantId: input.serviceVariantId,
      treatmentStyle: input.treatmentStyle,
      netPriceFils: input.netPriceFils,
      attributedCostFils,
      missing: Object.freeze([...missing]),
      openQuestionIds: Object.freeze([...openQuestionIds].sort()),
      components,
      netPriceBasis,
    })
  }

  return Object.freeze({
    state: 'margin' as const,
    appointmentId: input.appointmentId,
    serviceVariantId: input.serviceVariantId,
    treatmentStyle: input.treatmentStyle,
    netPriceFils: input.netPriceFils,
    costFils: attributedCostFils,
    marginFils: input.netPriceFils - attributedCostFils,
    components,
    netPriceBasis,
  })
}

/** The formula, as the string a registry publishes beside the figure. */
export const CONTRIBUTION_MARGIN_UNIT_FORMULA =
  'contribution_margin_unit = net_price_fils - (therapist + consumables + room_consumables + ' +
  'payment_fee), every component stated exactly once, in integer fils; a component nothing can put a ' +
  'figure on makes the result not_attributable rather than a larger margin'

// --- one service over one period ----------------------------------------------------------------

export interface ServiceMarginInput {
  readonly serviceVariantId: string
  readonly periodId: string
  /** Every delivery of this variant in the period. Empty is {@link ServiceContributionMargin} no_data. */
  readonly units: readonly ContributionMarginInput[]
}

export type ServiceContributionMargin =
  | {
      readonly state: 'margin'
      readonly serviceVariantId: string
      readonly periodId: string
      readonly deliveries: number
      readonly netRevenueFils: bigint
      readonly costFils: bigint
      readonly marginFils: bigint
      readonly units: readonly ContributionMarginUnit[]
    }
  | {
      readonly state: 'not_attributable'
      readonly serviceVariantId: string
      readonly periodId: string
      readonly deliveries: number
      readonly netRevenueFils: bigint
      readonly attributedCostFils: bigint
      readonly missing: readonly CostComponentId[]
      readonly openQuestionIds: readonly string[]
      readonly units: readonly ContributionMarginUnit[]
    }
  | {
      readonly state: 'no_data'
      readonly serviceVariantId: string
      readonly periodId: string
      readonly why: string
    }

/**
 * A service's contribution margin over a period, or `no_data`.
 *
 * `no_data` and never `0`, which is the acceptance line, and the reason is the same one `resolvePrice`
 * gives for refusing to answer zero: a service nobody bought and a service bought at no margin are
 * different facts, and a zero on a margin report is read as the second. A variant with no deliveries
 * has no margin to report at all.
 *
 * One `unattributable` unit makes the whole period `not_attributable`. Reporting the attributable
 * subset would be a margin over a sample nobody chose, which is worse than no figure: it is a figure
 * whose denominator moves with how much happens to be known.
 */
export function serviceContributionMargin(input: ServiceMarginInput): ServiceContributionMargin {
  if (input.units.length === 0) {
    return Object.freeze({
      state: 'no_data' as const,
      serviceVariantId: input.serviceVariantId,
      periodId: input.periodId,
      why:
        `No delivery of service variant ${input.serviceVariantId} in ${input.periodId}. A service ` +
        'nobody bought and a service bought at no margin are different facts, and a zero would be ' +
        'read as the second.',
    })
  }
  const units = Object.freeze(input.units.map(contributionMarginUnit))
  let netRevenueFils = 0n
  let attributedCostFils = 0n
  const missing = new Set<CostComponentId>()
  const openQuestionIds = new Set<string>()
  for (const unit of units) {
    netRevenueFils += unit.netPriceFils
    if (unit.state === 'margin') {
      attributedCostFils += unit.costFils
      continue
    }
    attributedCostFils += unit.attributedCostFils
    for (const component of unit.missing) missing.add(component)
    for (const id of unit.openQuestionIds) openQuestionIds.add(id)
  }

  if (missing.size > 0) {
    return Object.freeze({
      state: 'not_attributable' as const,
      serviceVariantId: input.serviceVariantId,
      periodId: input.periodId,
      deliveries: units.length,
      netRevenueFils,
      attributedCostFils,
      missing: Object.freeze(COST_COMPONENTS.filter((component) => missing.has(component))),
      openQuestionIds: Object.freeze([...openQuestionIds].sort()),
      units,
    })
  }

  return Object.freeze({
    state: 'margin' as const,
    serviceVariantId: input.serviceVariantId,
    periodId: input.periodId,
    deliveries: units.length,
    netRevenueFils,
    costFils: attributedCostFils,
    marginFils: netRevenueFils - attributedCostFils,
    units,
  })
}

export const SERVICE_CONTRIBUTION_MARGIN_FORMULA =
  'service_contribution_margin(variant, period) = SUM over every delivery of contribution_margin_unit; ' +
  'no delivery is no_data rather than zero, and one unattributable component makes the period ' +
  'not_attributable rather than a margin over whichever subset happens to be known'

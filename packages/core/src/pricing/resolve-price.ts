import type { Brand } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import { assertNever } from '../assert-never.ts'
import type { Fils, Money, VatRateBp } from '../money.ts'
import { filsFrom, money, roundHalfUp, splitGross, UAE_STANDARD_VAT_BP } from '../money.ts'
import type { LocalDate } from '../time.ts'

/**
 * The price resolution chain (ADR 0021, docs/13 §4).
 *
 * One question — "what does this cost?" — has four possible answers stacked on top of each other, and
 * the whole value of this module is that it says **which one it used**. A resolver that returned a bare
 * integer would be correct today and unexplainable in six months, when a customer disputes a figure on
 * an invoice and the only surviving evidence is the number itself. Every appointment snapshots what
 * `resolvePrice` returns (B-AVAIL-06), so the snapshot has to carry the reason as well as the amount.
 *
 * ## The order, and why it is this order
 *
 *   1. `base`       — the service's own catalogue gross.
 *   2. `variant`    — the gross for the chosen duration. Duration is the ONLY pricing axis there is.
 *   3. `price_list`  — an effective-dated override: a seasonal menu, a Ramadan card, a price rise.
 *   4. `promotion`  — a discount off whatever the three above settled on.
 *
 * The first three are **absolute**: each replaces the running gross rather than adjusting it, and the
 * later one wins. The fourth is the only **relative** layer. Reverse any two of the first three and the
 * number changes — a price rise dated from Monday would be overruled by the catalogue row it was
 * written to replace — so the order is asserted as a table of all sixteen presence/absence combinations
 * in `resolve-price.test.ts` rather than described in a comment.
 *
 * ## Purity
 *
 * There is no clock here. The effective date is an argument (`on`), because the same booking is priced
 * from three different dates in the life of one appointment: quoted today, rescheduled next week,
 * re-rendered on an invoice next year. A resolver that read the clock would answer the third question
 * with today's menu. `scripts/check-core-purity.mjs` and `pnpm boundaries` both enforce it.
 *
 * ## VAT
 *
 * Gross is authoritative (docs/01 decision 7). Net and VAT are derived here by `splitGross` from F05 —
 * `net = roundHalfUp(gross × 10000 / 10500)`, then `vat = gross − net` as the remainder — so
 * `net + vat === gross` for every input by construction rather than for almost every input. The
 * rounding rule is named on the result (`rounding`) so a snapshot states how it was rounded instead of
 * leaving a later reader to infer it from the digits.
 */

/** A row of `price_list` (migration 0025). Opaque here: `packages/core` never reads the table. */
export type PriceListId = Brand<string, 'PriceListId'>

/**
 * A promotion's identifier.
 *
 * No `promotion` table exists yet and no unit in `build/manifest.yaml` owns one, so this is whatever
 * identifier the caller has for the offer it applied. It is carried through to the snapshot regardless,
 * because "20% off, and here is which 20% off" is the only form of that fact worth storing.
 */
export type PromotionId = Brand<string, 'PromotionId'>

/** The four layers, in chain order. The names match the columns a snapshot stores them in. */
export const PRICE_RULES = ['base', 'variant', 'price_list', 'promotion'] as const
export type PriceRule = (typeof PRICE_RULES)[number]

/** The three layers that state a price outright, as opposed to adjusting one. */
export type AbsolutePriceRule = Exclude<PriceRule, 'promotion'>

/**
 * The rounding rule, named on every result.
 *
 * Half-up away from zero, matching `roundHalfUp` in F05 and UAE invoice practice. Stated as data rather
 * than left implicit: a snapshot that records only the rounded figure cannot be recomputed by anybody
 * who does not already know which way it was rounded, and "banker's rounding" is the default in enough
 * other systems for the question to be real.
 */
export const PRICE_ROUNDING = 'half_up_away_from_zero' as const
export type PriceRounding = typeof PRICE_ROUNDING

/**
 * An inclusive validity window over calendar dates.
 *
 * `to` is the last day the row applies, not the first day after it — the same convention as
 * `period_lock` in 0018_ledger.sql, and the same as the `daterange(valid_from, valid_to, '[]')` the
 * exclusion constraint in 0025_price_list.sql is built from. `null` means open-ended.
 *
 * Inclusive because the alternative is a menu that expires a day early exactly once, on the row
 * somebody wrote by copying the end date off a poster.
 */
export interface EffectiveWindow {
  readonly from: LocalDate
  readonly to: LocalDate | null
}

/** Whether a window covers a date, and when it does not, which side of it the date fell. */
export type WindowState = 'effective' | 'not_yet_effective' | 'expired'

/** Why a layer did not contribute. `absent` means there was no such row to consider at all. */
export type SkipReason = 'absent' | 'not_yet_effective' | 'expired'

/** The service's own catalogue gross, in integer fils, VAT-inclusive. */
export interface BasePriceLayer {
  readonly grossFils: Fils
}

/** The gross for one duration. Duration is the only pricing axis (ADR 0021). */
export interface VariantPriceLayer {
  readonly grossFils: Fils
  readonly durationMinutes: number
}

/** One effective-dated `price_list` row for the variant being priced. */
export interface PriceListLayer {
  readonly priceListId: PriceListId
  readonly grossFils: Fils
  readonly validFrom: LocalDate
  /** `null` is open-ended: the row applies until another one supersedes it. */
  readonly validTo: LocalDate | null
  /** What the price list is called, e.g. 'Ramadan 2027 menu'. Carried for the audit trail only. */
  readonly label?: string
}

/**
 * How a promotion reduces a price.
 *
 * `percentage_bp` is basis points off the gross (1000 bp = 10%); `absolute_fils` is a flat number of
 * fils. Both reduce the **gross**, never the net, because the gross is what was advertised and what the
 * customer agreed — discounting a net and re-grossing it produces a displayed price nobody quoted.
 */
export type PromotionKind = 'percentage_bp' | 'absolute_fils'

export interface PromotionLayer {
  readonly promotionId: PromotionId
  readonly kind: PromotionKind
  /** Basis points for `percentage_bp`, fils for `absolute_fils`. */
  readonly value: number
  readonly validFrom: LocalDate
  readonly validTo: LocalDate | null
}

/**
 * The four layers as the caller found them.
 *
 * Every layer is optional and `null` is accepted as well as omission, because the caller assembles this
 * from four lookups that each legitimately return nothing, and `exactOptionalPropertyTypes` makes
 * `{ base: undefined }` a type error otherwise.
 */
export interface PriceChain {
  readonly base?: BasePriceLayer | null
  readonly variant?: VariantPriceLayer | null
  readonly priceList?: PriceListLayer | null
  readonly promotion?: PromotionLayer | null
}

export interface ResolveOptions {
  /** The date the price is being asked about. An argument, never a clock read. */
  readonly on: LocalDate
  /** Defaults to the UAE standard rate. Passed for a zero-rated or exempt supply. */
  readonly vatRateBp?: VatRateBp
}

/** One layer's fate, in chain order. Present for all four layers whether they applied or not. */
export interface PriceChainStep {
  readonly rule: PriceRule
  readonly applied: boolean
  /** The running gross after this step, or `null` when the step did not apply. */
  readonly grossFils: Fils | null
  /** `null` when the step applied. */
  readonly skipped: SkipReason | null
}

/**
 * The snapshot-ready result.
 *
 * `priceListId` and `promotionId` are the two fields a dispute is settled with, which is why they are
 * `null` rather than absent when those layers did not apply: an absent key reads as "not recorded",
 * and a `null` reads as "considered, did not apply". B-AVAIL-06 stores both on the appointment.
 */
export interface ResolvedPrice {
  /** Authoritative. What the customer pays. */
  readonly gross: Money
  readonly net: Money
  readonly vat: Money
  readonly vatRateBp: VatRateBp
  readonly rounding: PriceRounding
  /** Which rule produced `gross`. `promotion` whenever a promotion applied. */
  readonly appliedRule: PriceRule
  /** The absolute rule the promotion discounted; equal to `appliedRule` when none applied. */
  readonly basisRule: AbsolutePriceRule
  readonly priceListId: PriceListId | null
  readonly promotionId: PromotionId | null
  /** The date this resolution is for. Echoed back so a stored result is self-describing. */
  readonly effectiveOn: LocalDate
  /** All four layers and what became of each, in chain order. */
  readonly chain: readonly PriceChainStep[]
}

/**
 * Raised when no absolute layer applied, so there is no price at all.
 *
 * Deliberately not a zero: B-CAT-03 settled that zero is a *missing* price rather than a free
 * treatment, and a zero reaching a booking would invoice as 0.00 and reconcile to nothing. Three of
 * docs/13 §4's items really are "price on request" — the right answer there is a catalogue state that
 * B-CAT-06 models, not a number this function invents.
 */
export class NoApplicablePrice extends AppError {
  readonly code = 'no_applicable_price' as const
  readonly effectiveOn: LocalDate
  constructor(on: LocalDate, chain: readonly PriceChainStep[]) {
    super(
      'not_found',
      `No price applies on ${on}: no base, variant or effective price_list layer was present. ` +
        'Zero is a missing price, not a free treatment.',
      { details: { code: 'no_applicable_price', effectiveOn: on, chain } },
    )
    this.name = 'NoApplicablePrice'
    this.effectiveOn = on
  }
}

/**
 * Raised when a discount would take the gross to zero or below.
 *
 * A 100%-off promotion is not a price of zero; it is a comp, which is a different transaction with a
 * different ledger treatment. Clamping to zero here would hide that distinction inside a pricing
 * function and post a nil sale.
 */
export class PromotionExceedsPrice extends AppError {
  readonly code = 'promotion_exceeds_price' as const
  constructor(promotionId: PromotionId, grossFils: number, discountFils: number) {
    super(
      'invariant_violated',
      `Promotion "${promotionId}" discounts ${discountFils} fils off a gross of ${grossFils} fils, ` +
        'which is not a price. A full discount is a comp, not a zero-priced sale.',
      {
        details: {
          code: 'promotion_exceeds_price',
          promotionId,
          grossFils,
          discountFils,
        },
      },
    )
    this.name = 'PromotionExceedsPrice'
  }
}

/** Raised when a layer is structurally unusable — before any arithmetic is attempted on it. */
export class MalformedPriceChain extends AppError {
  readonly code = 'malformed_price_chain' as const
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', message, { details: { code: 'malformed_price_chain', ...details } })
    this.name = 'MalformedPriceChain'
  }
}

/**
 * Where a date falls relative to a window.
 *
 * `LocalDate` is `YYYY-MM-DD`, which compares and sorts correctly as a string. That is not a shortcut:
 * it is the reason this module needs no date arithmetic and can therefore be forbidden `Date`
 * altogether, the same argument the ledger makes in `packages/core/src/ledger/entry.ts`.
 */
export function windowStateOn(window: EffectiveWindow, on: LocalDate): WindowState {
  if (window.to !== null && window.to < window.from) {
    throw new MalformedPriceChain(
      `A validity window ends (${window.to}) before it starts (${window.from}).`,
      { from: window.from, to: window.to },
    )
  }
  if (on < window.from) return 'not_yet_effective'
  if (window.to !== null && on > window.to) return 'expired'
  return 'effective'
}

/** True when the window covers the date. Both ends inclusive. */
export function isEffectiveOn(window: EffectiveWindow, on: LocalDate): boolean {
  return windowStateOn(window, on) === 'effective'
}

/**
 * The one price-list row effective on a date, or `null`.
 *
 * The database guarantees at most one (the `price_list_no_overlap` exclusion constraint in
 * 0025_price_list.sql), so finding two here means the rows did not come from that table — a seed, a
 * fixture or a hand-assembled list. That is worth failing on rather than picking the first: the whole
 * point of the constraint is that "the price on the 3rd" has one answer.
 */
export function selectEffectivePriceList(
  rows: readonly PriceListLayer[],
  on: LocalDate,
): PriceListLayer | null {
  const effective = rows.filter((row) =>
    isEffectiveOn({ from: row.validFrom, to: row.validTo }, on),
  )
  if (effective.length > 1) {
    throw new MalformedPriceChain(
      `${effective.length} price_list rows are effective on ${on}. The database forbids overlap; ` +
        'these rows did not come from it.',
      { on, priceListIds: effective.map((row) => row.priceListId) },
    )
  }
  return effective[0] ?? null
}

/** A gross that is not a positive whole number of fils is not a price. */
function grossOf(rule: PriceRule, grossFils: number): Fils {
  if (!Number.isInteger(grossFils)) {
    throw new MalformedPriceChain(
      `The ${rule} layer has a fractional gross (${grossFils} fils). Money is whole fils.`,
      { rule, grossFils },
    )
  }
  if (grossFils <= 0) {
    throw new MalformedPriceChain(
      `The ${rule} layer has a gross of ${grossFils} fils. Zero is a missing price, not a free ` +
        'treatment, and a negative price is a refund.',
      { rule, grossFils },
    )
  }
  return filsFrom(grossFils)
}

/** The discount a promotion takes off a gross, rounded by the declared rule. */
function discountFils(promotion: PromotionLayer, grossFils: Fils): number {
  switch (promotion.kind) {
    case 'percentage_bp': {
      if (!Number.isInteger(promotion.value) || promotion.value <= 0 || promotion.value > 10_000) {
        throw new MalformedPriceChain(
          `Promotion "${promotion.promotionId}" has a percentage of ${promotion.value} bp. A ` +
            'discount is between 1 and 10000 basis points.',
          { promotionId: promotion.promotionId, value: promotion.value },
        )
      }
      // Half-up on the DISCOUNT, then gross − discount, so the reduced gross stays a whole number of
      // fils without a second rounding. Rounding the reduced gross directly would round twice.
      return roundHalfUp((grossFils * promotion.value) / 10_000)
    }
    case 'absolute_fils': {
      if (!Number.isInteger(promotion.value) || promotion.value <= 0) {
        throw new MalformedPriceChain(
          `Promotion "${promotion.promotionId}" takes ${promotion.value} fils off, which is not a ` +
            'discount.',
          { promotionId: promotion.promotionId, value: promotion.value },
        )
      }
      return promotion.value
    }
    default:
      return assertNever(promotion.kind, 'discountFils promotion kind')
  }
}

/** One absolute layer, normalised so the three of them can be folded in one loop. */
interface AbsoluteCandidate {
  readonly rule: AbsolutePriceRule
  readonly grossFils: number
  /** `null` for the catalogue layers: only the price list is effective-dated. */
  readonly window: EffectiveWindow | null
  readonly priceListId: PriceListId | null
}

function absoluteCandidates(
  chain: PriceChain,
): readonly { readonly rule: AbsolutePriceRule; readonly candidate: AbsoluteCandidate | null }[] {
  const base = chain.base ?? null
  const variant = chain.variant ?? null
  const list = chain.priceList ?? null
  return [
    {
      rule: 'base',
      candidate:
        base === null
          ? null
          : { rule: 'base', grossFils: base.grossFils, window: null, priceListId: null },
    },
    {
      rule: 'variant',
      candidate:
        variant === null
          ? null
          : { rule: 'variant', grossFils: variant.grossFils, window: null, priceListId: null },
    },
    {
      rule: 'price_list',
      candidate:
        list === null
          ? null
          : {
              rule: 'price_list',
              grossFils: list.grossFils,
              window: { from: list.validFrom, to: list.validTo },
              priceListId: list.priceListId,
            },
    },
  ]
}

function step(rule: PriceRule, grossFils: Fils | null, skipped: SkipReason | null): PriceChainStep {
  return Object.freeze({ rule, applied: skipped === null, grossFils, skipped })
}

/**
 * Resolves one price, and says which rule produced it.
 *
 * Throws rather than returning a union, for the reason `postEntry` does: a caller has nothing useful to
 * do with "there is no price", and an ignored result union prices a booking at whatever the variable
 * was initialised to.
 */
export function resolvePrice(chain: PriceChain, options: ResolveOptions): ResolvedPrice {
  const on = options.on
  const rateBp = options.vatRateBp ?? UAE_STANDARD_VAT_BP
  const steps: PriceChainStep[] = []

  let running: { readonly rule: AbsolutePriceRule; readonly grossFils: Fils } | null = null
  let priceListId: PriceListId | null = null

  // Later absolute layers overrule earlier ones, so this walks the chain forwards and keeps the last
  // one that applied. Walking backwards and stopping at the first hit would give the same answer only
  // for as long as no layer can be present but ineffective — and the price list can be exactly that.
  for (const { rule, candidate } of absoluteCandidates(chain)) {
    if (candidate === null) {
      steps.push(step(rule, null, 'absent'))
      continue
    }
    const state = candidate.window === null ? 'effective' : windowStateOn(candidate.window, on)
    if (state !== 'effective') {
      steps.push(step(rule, null, state))
      continue
    }
    const gross = grossOf(rule, candidate.grossFils)
    running = { rule, grossFils: gross }
    priceListId = candidate.priceListId
    steps.push(step(rule, gross, null))
  }

  if (running === null) {
    // No fourth step is appended, and the omission is deliberate: the promotion layer was never
    // reached. Recording it as `absent` would state that no promotion was supplied, which is false
    // whenever one was — and the chain on this error is the only record of what was considered.
    throw new NoApplicablePrice(on, Object.freeze(steps))
  }

  const promotion = chain.promotion ?? null
  let promotionId: PromotionId | null = null
  let grossFils: Fils = running.grossFils

  if (promotion === null) {
    steps.push(step('promotion', null, 'absent'))
  } else {
    const state = windowStateOn({ from: promotion.validFrom, to: promotion.validTo }, on)
    if (state !== 'effective') {
      steps.push(step('promotion', null, state))
    } else {
      const discount = discountFils(promotion, grossFils)
      if (discount >= grossFils) {
        throw new PromotionExceedsPrice(promotion.promotionId, grossFils, discount)
      }
      grossFils = filsFrom(grossFils - discount)
      promotionId = promotion.promotionId
      steps.push(step('promotion', grossFils, null))
    }
  }

  const breakdown = splitGross(money(grossFils), rateBp)

  return Object.freeze({
    gross: breakdown.gross,
    net: breakdown.net,
    vat: breakdown.vat,
    vatRateBp: breakdown.rateBp,
    rounding: PRICE_ROUNDING,
    appliedRule: promotionId === null ? running.rule : 'promotion',
    basisRule: running.rule,
    priceListId,
    promotionId,
    effectiveOn: on,
    chain: Object.freeze(steps),
  })
}

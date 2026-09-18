import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { filsFrom, money, UAE_STANDARD_VAT_BP, vatRateBp, ZERO_RATED_BP } from '../money.ts'
import { ASIA_DUBAI, fixedClock, localDate, toLocal } from '../time.ts'
import {
  isEffectiveOn,
  MalformedPriceChain,
  NoApplicablePrice,
  PRICE_ROUNDING,
  type PriceChain,
  type PriceChainStep,
  type PriceListId,
  type PriceListLayer,
  PromotionExceedsPrice,
  type PromotionId,
  resolvePrice,
  selectEffectivePriceList,
  windowStateOn,
} from './resolve-price.ts'

/**
 * B-CAT-04 — the price resolution chain.
 *
 * The centre of this file is the sixteen-row table: four layers, each present or absent, and every row
 * asserting an exact number of fils rather than a range. A resolver can be wrong in sixteen different
 * ways and pass any one of them, because each wrong precedence order agrees with the right one on some
 * subset of the combinations — which is why the table is exhaustive and why `wrongOrderGross` below is
 * asserted to differ. An assertion that the resolver returns *something* would pass against a resolver
 * that returned the base price always.
 */

const LIST_ID = 'pl_ramadan_2027' as PriceListId
const PROMO_ID = 'promo_12_5_off' as PromotionId

/** docs/13 §4, Asian Normal Massage: 45 min AED 170 is the service's entry price, so the base. */
const BASE_FILS = 17_000
/** The same service at 60 minutes, AED 200. Duration is the only pricing axis (ADR 0021). */
const VARIANT_FILS = 20_000
/** A seasonal menu at AED 180 — deliberately *between* base and variant, so a resolver that picked
 *  the cheapest or the dearest layer rather than the last one would fail rather than coincide. */
const LIST_FILS = 18_000
/** 12.5% off. Chosen so that no discounted figure collides with an undiscounted one: 14875, 17500 and
 *  15750 are distinct from 17000, 20000 and 18000, and a layer applied in the wrong place shows up as
 *  a wrong number instead of the right one by luck. */
const PROMO_BP = 1_250

const ON = localDate('2026-09-18')
const WINDOW_START = localDate('2026-09-01')
const WINDOW_END = localDate('2026-09-30')

interface Presence {
  readonly base: boolean
  readonly variant: boolean
  readonly priceList: boolean
  readonly promotion: boolean
}

function chainFor(present: Presence): PriceChain {
  return {
    base: present.base ? { grossFils: filsFrom(BASE_FILS) } : null,
    variant: present.variant ? { grossFils: filsFrom(VARIANT_FILS), durationMinutes: 60 } : null,
    priceList: present.priceList
      ? {
          priceListId: LIST_ID,
          grossFils: filsFrom(LIST_FILS),
          validFrom: WINDOW_START,
          validTo: WINDOW_END,
        }
      : null,
    promotion: present.promotion
      ? {
          promotionId: PROMO_ID,
          kind: 'percentage_bp',
          value: PROMO_BP,
          validFrom: WINDOW_START,
          validTo: WINDOW_END,
        }
      : null,
  }
}

const label = (p: Presence) =>
  [
    p.base ? 'base' : '-',
    p.variant ? 'variant' : '-',
    p.priceList ? 'price_list' : '-',
    p.promotion ? 'promotion' : '-',
  ].join('+')

type Expectation =
  | {
      readonly kind: 'priced'
      readonly grossFils: number
      readonly netFils: number
      readonly vatFils: number
      readonly appliedRule: 'base' | 'variant' | 'price_list' | 'promotion'
      readonly basisRule: 'base' | 'variant' | 'price_list'
      readonly priceListApplied: boolean
      readonly promotionApplied: boolean
    }
  | { readonly kind: 'no_price' }

/**
 * All sixteen combinations, with the exact fils each produces.
 *
 * Fourteen resolve to a number. The two with no absolute layer resolve to the named
 * `no_applicable_price` error and **not** to zero: B-CAT-03 settled that zero is a missing price rather
 * than a free treatment, and the three "price on request" items in docs/13 §4 are a catalogue state
 * B-CAT-06 models, not a figure this function may invent. Asserting a fils value for those two rows
 * would be asserting a fiction, so they assert the error by name instead — which is still an exact
 * outcome, and the `resolves` control below proves the other fourteen do not throw.
 */
const TABLE: readonly (Presence & { readonly expect: Expectation })[] = [
  { base: false, variant: false, priceList: false, promotion: false, expect: { kind: 'no_price' } },
  { base: false, variant: false, priceList: false, promotion: true, expect: { kind: 'no_price' } },
  {
    base: false,
    variant: false,
    priceList: true,
    promotion: false,
    expect: {
      kind: 'priced',
      grossFils: 18_000,
      netFils: 17_143,
      vatFils: 857,
      appliedRule: 'price_list',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: false,
    },
  },
  {
    base: false,
    variant: false,
    priceList: true,
    promotion: true,
    expect: {
      kind: 'priced',
      grossFils: 15_750,
      netFils: 15_000,
      vatFils: 750,
      appliedRule: 'promotion',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: true,
    },
  },
  {
    base: false,
    variant: true,
    priceList: false,
    promotion: false,
    expect: {
      kind: 'priced',
      grossFils: 20_000,
      netFils: 19_048,
      vatFils: 952,
      appliedRule: 'variant',
      basisRule: 'variant',
      priceListApplied: false,
      promotionApplied: false,
    },
  },
  {
    base: false,
    variant: true,
    priceList: false,
    promotion: true,
    expect: {
      kind: 'priced',
      grossFils: 17_500,
      netFils: 16_667,
      vatFils: 833,
      appliedRule: 'promotion',
      basisRule: 'variant',
      priceListApplied: false,
      promotionApplied: true,
    },
  },
  {
    base: false,
    variant: true,
    priceList: true,
    promotion: false,
    expect: {
      kind: 'priced',
      grossFils: 18_000,
      netFils: 17_143,
      vatFils: 857,
      appliedRule: 'price_list',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: false,
    },
  },
  {
    base: false,
    variant: true,
    priceList: true,
    promotion: true,
    expect: {
      kind: 'priced',
      grossFils: 15_750,
      netFils: 15_000,
      vatFils: 750,
      appliedRule: 'promotion',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: true,
    },
  },
  {
    base: true,
    variant: false,
    priceList: false,
    promotion: false,
    expect: {
      kind: 'priced',
      grossFils: 17_000,
      netFils: 16_190,
      vatFils: 810,
      appliedRule: 'base',
      basisRule: 'base',
      priceListApplied: false,
      promotionApplied: false,
    },
  },
  {
    base: true,
    variant: false,
    priceList: false,
    promotion: true,
    expect: {
      kind: 'priced',
      grossFils: 14_875,
      netFils: 14_167,
      vatFils: 708,
      appliedRule: 'promotion',
      basisRule: 'base',
      priceListApplied: false,
      promotionApplied: true,
    },
  },
  {
    base: true,
    variant: false,
    priceList: true,
    promotion: false,
    expect: {
      kind: 'priced',
      grossFils: 18_000,
      netFils: 17_143,
      vatFils: 857,
      appliedRule: 'price_list',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: false,
    },
  },
  {
    base: true,
    variant: false,
    priceList: true,
    promotion: true,
    expect: {
      kind: 'priced',
      grossFils: 15_750,
      netFils: 15_000,
      vatFils: 750,
      appliedRule: 'promotion',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: true,
    },
  },
  {
    base: true,
    variant: true,
    priceList: false,
    promotion: false,
    expect: {
      kind: 'priced',
      grossFils: 20_000,
      netFils: 19_048,
      vatFils: 952,
      appliedRule: 'variant',
      basisRule: 'variant',
      priceListApplied: false,
      promotionApplied: false,
    },
  },
  {
    base: true,
    variant: true,
    priceList: false,
    promotion: true,
    expect: {
      kind: 'priced',
      grossFils: 17_500,
      netFils: 16_667,
      vatFils: 833,
      appliedRule: 'promotion',
      basisRule: 'variant',
      priceListApplied: false,
      promotionApplied: true,
    },
  },
  {
    base: true,
    variant: true,
    priceList: true,
    promotion: false,
    expect: {
      kind: 'priced',
      grossFils: 18_000,
      netFils: 17_143,
      vatFils: 857,
      appliedRule: 'price_list',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: false,
    },
  },
  {
    base: true,
    variant: true,
    priceList: true,
    promotion: true,
    expect: {
      kind: 'priced',
      grossFils: 15_750,
      netFils: 15_000,
      vatFils: 750,
      appliedRule: 'promotion',
      basisRule: 'price_list',
      priceListApplied: true,
      promotionApplied: true,
    },
  },
]

describe('acceptance — base -> variant -> price_list -> promotion, all 16 combinations', () => {
  it('enumerates every one of the sixteen combinations exactly once', () => {
    // Without this the table could lose a row in a merge and still report sixteen passes, because
    // nothing else here counts them. 2^4, with no duplicates.
    expect(TABLE).toHaveLength(16)
    expect(new Set(TABLE.map(label)).size).toBe(16)
  })

  for (const row of TABLE) {
    const expectation = row.expect
    if (expectation.kind === 'no_price') {
      it(`${label(row)} has no price at all and says so by name`, () => {
        const attempt = () => resolvePrice(chainFor(row), { on: ON })
        expect(attempt).toThrow(NoApplicablePrice)
        // By name, not merely "it threw": a typo in a layer name also throws, and this assertion has
        // to fail when the reason is different (ADR 0003).
        try {
          attempt()
        } catch (error) {
          expect((error as NoApplicablePrice).code).toBe('no_applicable_price')
          expect((error as NoApplicablePrice).kind).toBe('not_found')
          // The chain on the error names the three absolute layers it considered and stops there. The
          // promotion was never reached, and recording it as `absent` would be a false statement about
          // an input this row may well have supplied — one of these two rows does supply one.
          const considered = (error as NoApplicablePrice).details['chain'] as PriceChainStep[]
          expect(considered.map((s) => s.rule)).toEqual(['base', 'variant', 'price_list'])
          expect(considered.every((s) => s.skipped === 'absent')).toBe(true)
        }
      })
      continue
    }

    it(`${label(row)} resolves to exactly ${expectation.grossFils} fils via ${expectation.appliedRule}`, () => {
      const resolved = resolvePrice(chainFor(row), { on: ON })

      expect(resolved.gross.fils).toBe(expectation.grossFils)
      expect(resolved.net.fils).toBe(expectation.netFils)
      expect(resolved.vat.fils).toBe(expectation.vatFils)
      // The property that must never drift, asserted on every row rather than once.
      expect(resolved.net.fils + resolved.vat.fils).toBe(resolved.gross.fils)

      expect(resolved.appliedRule).toBe(expectation.appliedRule)
      expect(resolved.basisRule).toBe(expectation.basisRule)
      expect(resolved.priceListId).toBe(expectation.priceListApplied ? LIST_ID : null)
      expect(resolved.promotionId).toBe(expectation.promotionApplied ? PROMO_ID : null)

      expect(resolved.vatRateBp).toBe(UAE_STANDARD_VAT_BP)
      expect(resolved.rounding).toBe(PRICE_ROUNDING)
      expect(resolved.effectiveOn).toBe(ON)
      // All four layers are accounted for whether they applied or not, so a snapshot explains itself.
      expect(resolved.chain.map((s) => s.rule)).toEqual([
        'base',
        'variant',
        'price_list',
        'promotion',
      ])
    })
  }

  it('does not throw for the fourteen combinations that have a price', () => {
    // The control for the two `no_price` rows. Without it, a resolver that threw for every input would
    // satisfy those two assertions and fail nothing that named the reason.
    const priced = TABLE.filter((row) => row.expect.kind === 'priced')
    expect(priced).toHaveLength(14)
    for (const row of priced) {
      expect(() => resolvePrice(chainFor(row), { on: ON })).not.toThrow()
    }
  })
})

describe('acceptance — the order of the chain is load-bearing', () => {
  const allFour = chainFor({ base: true, variant: true, priceList: true, promotion: true })

  it('the last absolute layer wins, not the first', () => {
    const resolved = resolvePrice(allFour, { on: ON })
    expect(resolved.gross.fils).toBe(15_750)

    // The control. "First absolute layer wins" is the plausible wrong implementation — it is what a
    // fall-back chain written with `??` produces — and it would discount the BASE price instead:
    // 17000 − 12.5% = 14875. A resolver that returned that would satisfy every "returns a number"
    // assertion in this file, so the number is named here and asserted absent.
    const firstWinsGross = 14_875
    expect(resolved.gross.fils).not.toBe(firstWinsGross)
  })

  it('a promotion applied before the price list would produce a different number', () => {
    // Discounting the variant and then letting the price list overrule it gives 18000, not 15750.
    // Asserted so that swapping steps 3 and 4 fails here rather than passing quietly.
    const resolved = resolvePrice(allFour, { on: ON })
    expect(resolved.gross.fils).not.toBe(18_000)
    expect(resolved.appliedRule).toBe('promotion')
    expect(resolved.basisRule).toBe('price_list')
  })

  it('the variant overrules the base, and not the other way round', () => {
    const resolved = resolvePrice(
      chainFor({ base: true, variant: true, priceList: false, promotion: false }),
      { on: ON },
    )
    expect(resolved.gross.fils).toBe(VARIANT_FILS)
    expect(resolved.gross.fils).not.toBe(BASE_FILS)
  })
})

describe('acceptance — a price list effective tomorrow does not change today (F05 frozen clock)', () => {
  /** The menu changes on the 19th. `validTo` open-ended: it applies until something supersedes it. */
  const tomorrowsList: PriceListLayer = {
    priceListId: LIST_ID,
    grossFils: filsFrom(LIST_FILS),
    validFrom: localDate('2026-09-19'),
    validTo: null,
  }
  const chain: PriceChain = {
    variant: { grossFils: filsFrom(VARIANT_FILS), durationMinutes: 60 },
    priceList: tomorrowsList,
  }

  /**
   * The date the resolver is asked about, taken from an injected clock.
   *
   * The **calendar** date in the business timezone, deliberately not `businessDayFor`. Trading runs
   * 11:00–02:00, so the trading date at 00:01 is still the 18th — and a customer looking at the website
   * at 00:01 on the 19th sees the new menu. Pricing a booking made at that moment from yesterday's
   * trading day would quote a price the site no longer shows. The resolver takes the date as an
   * argument precisely so this choice is the caller's and is visible; the test below asserts what the
   * other choice would have produced.
   */
  const dateAt = (iso: string) => toLocal(fixedClock(iso).now(), ASIA_DUBAI).date

  it('at 23:59 on the 18th the price list is not yet effective', () => {
    const on = dateAt('2026-09-18T23:59:00+04:00')
    expect(on).toBe('2026-09-18')

    const resolved = resolvePrice(chain, { on })
    expect(resolved.gross.fils).toBe(VARIANT_FILS)
    expect(resolved.appliedRule).toBe('variant')
    expect(resolved.priceListId).toBeNull()
    // The row was considered and rejected for a stated reason, not silently ignored.
    expect(resolved.chain.find((s) => s.rule === 'price_list')?.skipped).toBe('not_yet_effective')
  })

  it('at 00:01 on the 19th it is, and the resolved price changes', () => {
    const on = dateAt('2026-09-19T00:01:00+04:00')
    expect(on).toBe('2026-09-19')

    const resolved = resolvePrice(chain, { on })
    expect(resolved.gross.fils).toBe(LIST_FILS)
    expect(resolved.appliedRule).toBe('price_list')
    expect(resolved.priceListId).toBe(LIST_ID)
    expect(resolved.chain.find((s) => s.rule === 'price_list')?.skipped).toBeNull()
  })

  it('the two instants are two minutes apart and produce two different prices', () => {
    // The control. If both clocks resolved to the same date — a timezone slip of four hours would do
    // it — the pair above would both assert the same thing and one of them would be dead.
    const before = dateAt('2026-09-18T23:59:00+04:00')
    const after = dateAt('2026-09-19T00:01:00+04:00')
    expect(before).not.toBe(after)
    expect(resolvePrice(chain, { on: before }).gross.fils).not.toBe(
      resolvePrice(chain, { on: after }).gross.fils,
    )
  })

  it('an expired price list is skipped with a different reason from one not yet effective', () => {
    const resolved = resolvePrice(
      {
        variant: { grossFils: filsFrom(VARIANT_FILS), durationMinutes: 60 },
        priceList: {
          priceListId: LIST_ID,
          grossFils: filsFrom(LIST_FILS),
          validFrom: localDate('2026-08-01'),
          validTo: localDate('2026-08-31'),
        },
      },
      { on: ON },
    )
    expect(resolved.gross.fils).toBe(VARIANT_FILS)
    expect(resolved.chain.find((s) => s.rule === 'price_list')?.skipped).toBe('expired')
  })

  it('a price list is effective on both the first and the last day of its window', () => {
    // Inclusive at both ends, matching daterange(valid_from, valid_to, '[]') in 0025_price_list.sql.
    // An exclusive end expires the menu a day early, once, on the row copied off a poster.
    for (const day of ['2026-09-01', '2026-09-30']) {
      const resolved = resolvePrice(
        chainFor({ base: false, variant: true, priceList: true, promotion: false }),
        { on: localDate(day) },
      )
      expect(resolved.gross.fils).toBe(LIST_FILS)
    }
    // And not on the days either side of it.
    for (const day of ['2026-08-31', '2026-10-01']) {
      const resolved = resolvePrice(
        chainFor({ base: false, variant: true, priceList: true, promotion: false }),
        { on: localDate(day) },
      )
      expect(resolved.gross.fils).toBe(VARIANT_FILS)
    }
  })
})

describe('acceptance — price_list_id and promotion_id make a snapshot explainable', () => {
  it('populates both when both layers applied', () => {
    const resolved = resolvePrice(
      chainFor({ base: true, variant: true, priceList: true, promotion: true }),
      { on: ON },
    )
    expect(resolved.priceListId).toBe(LIST_ID)
    expect(resolved.promotionId).toBe(PROMO_ID)
  })

  it('leaves both null when neither applied', () => {
    const resolved = resolvePrice(
      chainFor({ base: true, variant: true, priceList: false, promotion: false }),
      { on: ON },
    )
    expect(resolved.priceListId).toBeNull()
    expect(resolved.promotionId).toBeNull()
  })

  it('nulls the promotion id when the promotion existed but was not yet effective', () => {
    // The distinction this pair of fields exists for: "considered, did not apply" must not read the
    // same as "applied". A promotion id recorded against a price it did not reduce is the version of
    // this bug that only surfaces when somebody audits a discount report.
    const resolved = resolvePrice(
      {
        variant: { grossFils: filsFrom(VARIANT_FILS), durationMinutes: 60 },
        promotion: {
          promotionId: PROMO_ID,
          kind: 'percentage_bp',
          value: PROMO_BP,
          validFrom: localDate('2026-12-01'),
          validTo: null,
        },
      },
      { on: ON },
    )
    expect(resolved.gross.fils).toBe(VARIANT_FILS)
    expect(resolved.promotionId).toBeNull()
    expect(resolved.appliedRule).toBe('variant')
    expect(resolved.chain.find((s) => s.rule === 'promotion')?.skipped).toBe('not_yet_effective')
  })

  it('nulls the price list id when the price list existed but had expired', () => {
    const resolved = resolvePrice(
      {
        base: { grossFils: filsFrom(BASE_FILS) },
        priceList: {
          priceListId: LIST_ID,
          grossFils: filsFrom(LIST_FILS),
          validFrom: localDate('2026-01-01'),
          validTo: localDate('2026-01-31'),
          label: 'January 2026 menu',
        },
      },
      { on: ON },
    )
    expect(resolved.priceListId).toBeNull()
    expect(resolved.appliedRule).toBe('base')
  })
})

describe('promotions', () => {
  const base = { base: { grossFils: filsFrom(BASE_FILS) } }
  const window = { validFrom: WINDOW_START, validTo: WINDOW_END }

  it('takes an absolute discount in whole fils', () => {
    const resolved = resolvePrice(
      {
        ...base,
        promotion: { promotionId: PROMO_ID, kind: 'absolute_fils', value: 2_000, ...window },
      },
      { on: ON },
    )
    expect(resolved.gross.fils).toBe(15_000)
    expect(resolved.appliedRule).toBe('promotion')
    expect(resolved.basisRule).toBe('base')
  })

  it('rounds a percentage discount half up, away from zero', () => {
    // 17000 × 1765 bp = 3000.5 fils exactly. Half-up takes 3001, leaving 13999; rounding the other way
    // would leave 14000. One fil, and it is the fil that makes `PRICE_ROUNDING` worth recording.
    const resolved = resolvePrice(
      {
        ...base,
        promotion: { promotionId: PROMO_ID, kind: 'percentage_bp', value: 1_765, ...window },
      },
      { on: ON },
    )
    expect(resolved.gross.fils).toBe(13_999)
    expect(resolved.gross.fils).not.toBe(14_000)
    expect(resolved.rounding).toBe('half_up_away_from_zero')
  })

  it('refuses a discount that consumes the whole price', () => {
    const attempt = () =>
      resolvePrice(
        {
          ...base,
          promotion: { promotionId: PROMO_ID, kind: 'percentage_bp', value: 10_000, ...window },
        },
        { on: ON },
      )
    expect(attempt).toThrow(PromotionExceedsPrice)
    try {
      attempt()
    } catch (error) {
      expect((error as PromotionExceedsPrice).code).toBe('promotion_exceeds_price')
      expect((error as PromotionExceedsPrice).kind).toBe('invariant_violated')
    }
  })

  it('refuses an absolute discount larger than the price', () => {
    expect(() =>
      resolvePrice(
        {
          ...base,
          promotion: { promotionId: PROMO_ID, kind: 'absolute_fils', value: 99_000, ...window },
        },
        { on: ON },
      ),
    ).toThrow(PromotionExceedsPrice)
  })

  it('accepts a discount of all but one fil, which is the control for the two refusals', () => {
    const resolved = resolvePrice(
      {
        ...base,
        promotion: {
          promotionId: PROMO_ID,
          kind: 'absolute_fils',
          value: BASE_FILS - 1,
          ...window,
        },
      },
      { on: ON },
    )
    expect(resolved.gross.fils).toBe(1)
  })

  it('refuses a percentage outside 1..10000 basis points', () => {
    for (const value of [0, -100, 10_001, 12.5]) {
      expect(() =>
        resolvePrice(
          {
            ...base,
            promotion: { promotionId: PROMO_ID, kind: 'percentage_bp', value, ...window },
          },
          { on: ON },
        ),
      ).toThrow(MalformedPriceChain)
    }
  })

  it('refuses a non-positive or fractional absolute discount', () => {
    for (const value of [0, -1, 10.5]) {
      expect(() =>
        resolvePrice(
          {
            ...base,
            promotion: { promotionId: PROMO_ID, kind: 'absolute_fils', value, ...window },
          },
          { on: ON },
        ),
      ).toThrow(MalformedPriceChain)
    }
  })
})

describe('a layer that is not a price', () => {
  it('refuses a zero gross — a missing price, not a free treatment', () => {
    expect(() => resolvePrice({ base: { grossFils: filsFrom(0) } }, { on: ON })).toThrow(
      MalformedPriceChain,
    )
  })

  it('refuses a negative gross', () => {
    expect(() =>
      resolvePrice({ variant: { grossFils: filsFrom(-1), durationMinutes: 60 } }, { on: ON }),
    ).toThrow(MalformedPriceChain)
  })

  it('refuses a fractional gross, which is what 250.5 fils would be', () => {
    // `filsFrom` already refuses this, so the cast is how a fractional value actually arrives — from
    // JSON, or from a driver handing back a numeric. The check is worth keeping for that path.
    expect(() =>
      resolvePrice(
        { base: { grossFils: 250.5 as unknown as ReturnType<typeof filsFrom> } },
        {
          on: ON,
        },
      ),
    ).toThrow(MalformedPriceChain)
  })

  it('accepts one fil, which is the control for the three refusals', () => {
    expect(resolvePrice({ base: { grossFils: filsFrom(1) } }, { on: ON }).gross.fils).toBe(1)
  })

  it('refuses a validity window that ends before it starts', () => {
    expect(() =>
      resolvePrice(
        {
          variant: { grossFils: filsFrom(VARIANT_FILS), durationMinutes: 60 },
          priceList: {
            priceListId: LIST_ID,
            grossFils: filsFrom(LIST_FILS),
            validFrom: localDate('2026-09-30'),
            validTo: localDate('2026-09-01'),
          },
        },
        { on: ON },
      ),
    ).toThrow(MalformedPriceChain)
  })
})

describe('the window predicate, which the SQL in 0025_price_list.sql mirrors', () => {
  const window = { from: WINDOW_START, to: WINDOW_END }

  it('is inclusive at both ends', () => {
    expect(windowStateOn(window, localDate('2026-08-31'))).toBe('not_yet_effective')
    expect(windowStateOn(window, localDate('2026-09-01'))).toBe('effective')
    expect(windowStateOn(window, localDate('2026-09-30'))).toBe('effective')
    expect(windowStateOn(window, localDate('2026-10-01'))).toBe('expired')
  })

  it('treats a null end as open-ended', () => {
    const open = { from: WINDOW_START, to: null }
    expect(isEffectiveOn(open, localDate('2026-09-01'))).toBe(true)
    expect(isEffectiveOn(open, localDate('2099-12-31'))).toBe(true)
    expect(isEffectiveOn(open, localDate('2026-08-31'))).toBe(false)
  })

  it('throws on an inverted window rather than treating it as empty', () => {
    expect(() => windowStateOn({ from: WINDOW_END, to: WINDOW_START }, ON)).toThrow(
      MalformedPriceChain,
    )
  })
})

describe('selectEffectivePriceList', () => {
  const row = (id: string, from: string, to: string | null): PriceListLayer => ({
    priceListId: id as PriceListId,
    grossFils: filsFrom(LIST_FILS),
    validFrom: localDate(from),
    validTo: to === null ? null : localDate(to),
  })

  it('picks the one row covering the date', () => {
    const rows = [
      row('pl_aug', '2026-08-01', '2026-08-31'),
      row('pl_sep', '2026-09-01', '2026-09-30'),
      row('pl_oct', '2026-10-01', null),
    ]
    expect(selectEffectivePriceList(rows, ON)?.priceListId).toBe('pl_sep')
    expect(selectEffectivePriceList(rows, localDate('2026-12-25'))?.priceListId).toBe('pl_oct')
  })

  it('returns null when no row covers the date', () => {
    expect(selectEffectivePriceList([row('pl_aug', '2026-08-01', '2026-08-31')], ON)).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(selectEffectivePriceList([], ON)).toBeNull()
  })

  it('refuses to choose between two overlapping rows', () => {
    // The database cannot produce this (`price_list_no_overlap`), so rows that do came from a seed or
    // a fixture. Picking the first would make "the price on the 18th" depend on row order, which is
    // the ambiguity the exclusion constraint exists to remove.
    expect(() =>
      selectEffectivePriceList(
        [row('pl_a', '2026-09-01', '2026-09-30'), row('pl_b', '2026-09-15', null)],
        ON,
      ),
    ).toThrow(MalformedPriceChain)
  })
})

describe('acceptance — gross -> net/VAT at 5% round-trips exactly, for all 32 catalogue prices', () => {
  /**
   * The 32 price points of docs/13 §4, as literals: `[style, treatment, minutes, gross, net, vat]`.
   *
   * Transcribed here rather than read from the database on purpose. B-CAT-03 did not seed them — that
   * is B-CAT-06's — and this assertion is about arithmetic, which needs no rows. Transcribed *by hand*
   * from the document rather than generated from the formula, because a generated expectation would
   * only prove the formula equals itself.
   */
  const CATALOGUE: readonly [string, string, number, number, number, number][] = [
    ['asian', 'normal_massage', 45, 17_000, 16_190, 810],
    ['asian', 'normal_massage', 60, 20_000, 19_048, 952],
    ['asian', 'normal_massage', 90, 30_000, 28_571, 1_429],
    ['asian', 'normal_massage', 120, 40_000, 38_095, 1_905],
    ['asian', 'hot_oil_balm_massage', 45, 20_000, 19_048, 952],
    ['asian', 'hot_oil_balm_massage', 60, 25_000, 23_810, 1_190],
    ['asian', 'hot_oil_balm_massage', 90, 35_000, 33_333, 1_667],
    ['asian', 'hot_oil_balm_massage', 120, 45_000, 42_857, 2_143],
    ['asian', 'morocco_bath_jacuzzi', 45, 25_000, 23_810, 1_190],
    ['asian', 'morocco_bath_jacuzzi', 60, 30_000, 28_571, 1_429],
    ['asian', 'morocco_bath_jacuzzi', 90, 44_000, 41_905, 2_095],
    ['asian', 'morocco_bath_jacuzzi', 120, 55_000, 52_381, 2_619],
    ['asian', 'massage_with_shaving', 45, 20_000, 19_048, 952],
    ['asian', 'massage_with_shaving', 60, 25_000, 23_810, 1_190],
    ['asian', 'massage_with_shaving', 90, 35_000, 33_333, 1_667],
    ['asian', 'massage_with_shaving', 120, 45_000, 42_857, 2_143],
    ['arabic', 'normal_massage', 45, 20_000, 19_048, 952],
    ['arabic', 'normal_massage', 60, 25_000, 23_810, 1_190],
    ['arabic', 'normal_massage', 90, 35_000, 33_333, 1_667],
    ['arabic', 'normal_massage', 120, 45_000, 42_857, 2_143],
    ['arabic', 'hot_oil_balm_massage', 45, 25_000, 23_810, 1_190],
    ['arabic', 'hot_oil_balm_massage', 60, 30_000, 28_571, 1_429],
    ['arabic', 'hot_oil_balm_massage', 90, 40_000, 38_095, 1_905],
    ['arabic', 'hot_oil_balm_massage', 120, 50_000, 47_619, 2_381],
    ['arabic', 'morocco_bath_jacuzzi', 45, 33_000, 31_429, 1_571],
    ['arabic', 'morocco_bath_jacuzzi', 60, 38_000, 36_190, 1_810],
    ['arabic', 'morocco_bath_jacuzzi', 90, 52_000, 49_524, 2_476],
    ['arabic', 'morocco_bath_jacuzzi', 120, 62_000, 59_048, 2_952],
    ['arabic', 'massage_with_shaving', 45, 30_000, 28_571, 1_429],
    ['arabic', 'massage_with_shaving', 60, 35_000, 33_333, 1_667],
    ['arabic', 'massage_with_shaving', 90, 45_000, 42_857, 2_143],
    ['arabic', 'massage_with_shaving', 120, 55_000, 52_381, 2_619],
  ]

  it('has all 32 price points: 8 services x 4 durations', () => {
    expect(CATALOGUE).toHaveLength(32)
    expect(new Set(CATALOGUE.map(([s, t]) => `${s}.${t}`)).size).toBe(8)
    expect(new Set(CATALOGUE.map(([, , d]) => d))).toEqual(new Set([45, 60, 90, 120]))
  })

  for (const [style, treatment, minutes, gross, net, vat] of CATALOGUE) {
    it(`${style} ${treatment} ${minutes}min: ${gross} = ${net} + ${vat}`, () => {
      const resolved = resolvePrice(
        { variant: { grossFils: filsFrom(gross), durationMinutes: minutes } },
        { on: ON },
      )
      expect(resolved.gross.fils).toBe(gross)
      expect(resolved.net.fils).toBe(net)
      expect(resolved.vat.fils).toBe(vat)
      expect(resolved.net.fils + resolved.vat.fils).toBe(gross)
      // The control for the transcription: a net computed at the wrong rate would still add up.
      expect(resolved.vat.fils).not.toBe(Math.round(gross * 0.05))
    })
  }

  it('is not a tautology: 5% of the gross is not the VAT on a gross-inclusive price', () => {
    // The mistake this whole module exists to prevent, stated once as a number. AED 200 gross carries
    // AED 9.52 of VAT, not AED 10.00 — 5% of the NET, not 5% of the gross. Getting it the other way
    // round overstates output VAT on every invoice by 5% of 5%.
    const resolved = resolvePrice(
      { variant: { grossFils: filsFrom(20_000), durationMinutes: 60 } },
      { on: ON },
    )
    expect(resolved.vat.fils).toBe(952)
    expect(resolved.vat.fils).not.toBe(1_000)
  })

  it('derives no VAT on a zero-rated supply', () => {
    const resolved = resolvePrice(
      { variant: { grossFils: filsFrom(20_000), durationMinutes: 60 } },
      { on: ON, vatRateBp: ZERO_RATED_BP },
    )
    expect(resolved.vat.fils).toBe(0)
    expect(resolved.net.fils).toBe(20_000)
    expect(resolved.vatRateBp).toBe(0)
  })

  it('carries the rate that was used, so a snapshot is not ambiguous', () => {
    const resolved = resolvePrice(
      { variant: { grossFils: filsFrom(20_000), durationMinutes: 60 } },
      { on: ON, vatRateBp: vatRateBp(500) },
    )
    expect(resolved.vatRateBp).toBe(500)
  })
})

describe('acceptance — properties over 1..10,000,000 fils with zero rounding drift', () => {
  const grossArb = fc.integer({ min: 1, max: 10_000_000 })

  /**
   * The independent oracle, in integer arithmetic.
   *
   * `net = roundHalfUp(gross × 20 / 21)`, computed as `floor((40·gross + 21) / 42)` over BigInt so that
   * no float is involved at all. Exact halves cannot occur — `20g/21 = k + 1/2` implies `40g = 42k + 21`,
   * an even number equal to an odd one — so half-up, half-down and half-even all agree, and any
   * disagreement with this oracle is drift rather than a tie-break convention.
   */
  const oracleNet = (gross: number): number => Number((40n * BigInt(gross) + 21n) / 42n)

  it('net matches the integer oracle exactly, for every gross', () => {
    fc.assert(
      fc.property(grossArb, (gross) => {
        const resolved = resolvePrice(
          { variant: { grossFils: filsFrom(gross), durationMinutes: 60 } },
          { on: ON },
        )
        return resolved.net.fils === oracleNet(gross)
      }),
      { numRuns: 5_000 },
    )
  })

  it('net + vat === gross, exactly, with no drift anywhere in the range', () => {
    fc.assert(
      fc.property(grossArb, (gross) => {
        const resolved = resolvePrice(
          { variant: { grossFils: filsFrom(gross), durationMinutes: 60 } },
          { on: ON },
        )
        return (
          resolved.net.fils + resolved.vat.fils === gross &&
          resolved.gross.fils === gross &&
          Number.isInteger(resolved.net.fils) &&
          Number.isInteger(resolved.vat.fils)
        )
      }),
      { numRuns: 5_000 },
    )
  })

  it('the oracle would catch a wrong rate, which is what makes the two above mean something', () => {
    // The control. A net derived at 4% would satisfy "net + vat === gross" for every input, so that
    // property alone proves nothing about the rate. This asserts the oracle disagrees with it.
    fc.assert(
      fc.property(fc.integer({ min: 1_000, max: 10_000_000 }), (gross) => {
        const wrong = Math.round((gross * 100) / 104)
        return wrong !== oracleNet(gross)
      }),
      { numRuns: 1_000 },
    )
  })

  it('a promotion either produces a whole positive gross or refuses by name', () => {
    // Stated as a disjunction because the property found the edge: one fil at 50% off rounds the
    // discount up to one fil, which would leave nothing. That is refused rather than clamped to zero,
    // and a property that quietly excluded the case would have hidden the only input where the
    // half-up rule and the "a discount is not a comp" rule collide.
    fc.assert(
      fc.property(grossArb, fc.integer({ min: 1, max: 9_000 }), (gross, bp) => {
        const chain = {
          variant: { grossFils: filsFrom(gross), durationMinutes: 60 },
          promotion: {
            promotionId: PROMO_ID,
            kind: 'percentage_bp' as const,
            value: bp,
            validFrom: WINDOW_START,
            validTo: null,
          },
        }
        const discount = Math.round((gross * bp) / 10_000)
        try {
          const resolved = resolvePrice(chain, { on: ON })
          return (
            discount < gross &&
            Number.isInteger(resolved.gross.fils) &&
            resolved.gross.fils === gross - discount &&
            resolved.gross.fils > 0 &&
            resolved.net.fils + resolved.vat.fils === resolved.gross.fils
          )
        } catch (error) {
          return error instanceof PromotionExceedsPrice && discount >= gross
        }
      }),
      { numRuns: 2_000 },
    )
  })
})

describe('acceptance — pure and deterministic', () => {
  const chain = chainFor({ base: true, variant: true, priceList: true, promotion: true })

  it('returns a byte-identical result across 1000 calls', () => {
    const first = JSON.stringify(resolvePrice(chain, { on: ON }))
    for (let i = 0; i < 1_000; i += 1) {
      expect(JSON.stringify(resolvePrice(chain, { on: ON }))).toBe(first)
    }
  })

  it('differs when the date differs, which is the control for the 1000 identical calls', () => {
    // Otherwise a resolver that ignored `on` entirely would pass the determinism test perfectly.
    const outsideWindow = JSON.stringify(resolvePrice(chain, { on: localDate('2026-10-15') }))
    expect(outsideWindow).not.toBe(JSON.stringify(resolvePrice(chain, { on: ON })))
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(chain)
    resolvePrice(chain, { on: ON })
    expect(JSON.stringify(chain)).toBe(before)
  })

  it('returns a frozen result, so a snapshot cannot be edited after the fact', () => {
    const resolved = resolvePrice(chain, { on: ON })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.chain)).toBe(true)
  })

  it('prices from a Money the caller built, not from a number it invented', () => {
    // `money(filsFrom(...))` is the only way into this module, and `aed()`/`aedFrom()` are the only
    // ways into `money`. Asserted so the shape of the result stays comparable with F05's.
    const resolved = resolvePrice({ base: { grossFils: filsFrom(20_000) } }, { on: ON })
    expect(resolved.gross).toEqual(money(filsFrom(20_000)))
    expect(resolved.gross.currency).toBe('AED')
  })
})

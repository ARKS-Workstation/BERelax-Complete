import {
  type Basket,
  basketId,
  buildBasket,
  discountLine,
  entryId,
  filsFrom,
  type Instant,
  money,
  serviceLineFromAppointment,
  STANDARD_SPA_CHART,
  type TenderLine,
  tipLine,
  type VatRateBp,
} from '@berelax/core'
import {
  checkoutMapping,
  FIXTURE_HOURS,
  FIXTURE_ISSUER,
  packageRedemptionMapping,
  packageSaleMapping,
} from '@berelax/fixtures'
import { describe, expect, it } from 'vitest'
import {
  tillCheckoutMapping,
  tillPackageRedemptionMapping,
  tillPackageSaleMapping,
} from './till/mapping.ts'

/**
 * The till's three core→db mappings, held EQUAL to `@berelax/fixtures`' three (M-TILL-13).
 *
 * `apps/web/src/till/mapping.ts` explains why there are two transcriptions rather than one implementation:
 * `@berelax/fixtures` is a **devDependency** of `@berelax/web`, its public entry is a barrel that re-exports
 * the salon generator and every loader, and a route importing it would pull that graph into the Next server
 * bundle. A test may import it, so this file is where the two are compared.
 *
 * ## Why deep equality on the whole input, and not field by field
 *
 * The thing that goes wrong at this seam is a FIELD, not a formula: a `net` sent where the row wanted `gross`,
 * a dropped `2030` line, a tender's reference lost. Naming the fields would mean this file listing them, and
 * then a field added to `FinaliseCheckoutInput` would be absent from the list and from the comparison at the
 * same time. `toEqual` over the whole object cannot miss one.
 *
 * Every case is paired with a control that a deliberately wrong transcription IS detected, because an equality
 * test between two objects built by the same call would pass for any pair (ADR 0003, brief rule 3).
 */

const PROBE_APPOINTMENT = '00000000-0000-4000-8000-00000000ab01'
const RATE = 500 as VatRateBp
const SUPPLY_AT = Date.parse('2026-09-18T15:00:00+04:00') as Instant
const ISSUED_AT = Date.parse('2026-09-18T15:30:00+04:00') as Instant

const gross = (fils: number) => money(filsFrom(fils))

/** A basket with a treatment, a discount that says why, and a gratuity — three of the four line kinds. */
function probeBasket(): Basket {
  const service = serviceLineFromAppointment('appt-1', {
    appointmentId: PROBE_APPOINTMENT,
    serviceVariantId: '00000000-0000-4000-8000-00000000cd01',
    status: 'completed',
    description: 'asian normal_massage, 60 min',
    gross: gross(20_000),
    net: gross(19_048),
    vat: gross(952),
    vatRateBp: RATE,
    priceListId: null,
    promotionId: null,
  })
  return buildBasket(
    {
      basketId: basketId('till-mapping-probe'),
      customerId: null,
      lines: [
        service,
        discountLine({
          lineId: 'discount-1',
          targetLineId: 'appt-1',
          reason: 'service_recovery',
          kind: 'absolute_fils',
          value: 2_000,
        }),
        tipLine({ lineId: 'tip-1', gross: gross(1_500) }),
      ],
    },
    STANDARD_SPA_CHART,
  )
}

/** Split tender: cash and a card with a reference, which is the field a transcription most easily loses. */
const TENDERS: readonly TenderLine[] = [
  { kind: 'cash', amount: gross(10_000) },
  { kind: 'card_in_salon', amount: gross(9_500), reference: 'APPROVAL-42' },
]

describe('acceptance — the till checkout mapping is the fixture checkout mapping', () => {
  it('produces the same finaliseCheckout input, field for field', () => {
    const basket = probeBasket()
    const shared = {
      basket,
      tenders: TENDERS,
      entryId: entryId('till-mapping-probe'),
      idempotencyKey: 'till:2026-09-18:probe',
      requestFingerprint: 'probe-fingerprint',
      supplyAt: SUPPLY_AT,
      issuedAt: ISSUED_AT,
      origins: [{ lineId: 'appt-1', appointmentId: PROBE_APPOINTMENT }],
    } as const

    const fixture = checkoutMapping({ ...shared, customerIndex: 42 })
    const till = tillCheckoutMapping({
      ...shared,
      issuer: FIXTURE_ISSUER,
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      // `checkoutMapping` labels the customer `Customer 0042` by default (ADR 0020). The till takes the label
      // from the row and has no index, so the same label is passed in rather than a second derivation of it.
      customerLabel: 'Customer 0042',
      hoursFor: FIXTURE_HOURS,
    })

    expect(till.input).toEqual(fixture.input)
    expect(till.tradingDate).toBe(fixture.tradingDate)
    // The posting too, because the document and the entry are the two halves a mapping can get wrong
    // independently: `reconcileCheckoutMapping` exists because neither package's own suite can see the other.
    expect(till.posting.entry.lines).toEqual(fixture.posting.entry.lines)
  })

  it('the control: a mapping that dropped the card reference is NOT equal', () => {
    // Without this, a `toEqual` between two objects built from the same inputs would pass for any pair of
    // implementations, including two copies of a broken one.
    const basket = probeBasket()
    const shared = {
      basket,
      tenders: TENDERS,
      entryId: entryId('till-mapping-probe'),
      idempotencyKey: 'till:2026-09-18:probe',
      requestFingerprint: 'probe-fingerprint',
      supplyAt: SUPPLY_AT,
      issuedAt: ISSUED_AT,
      origins: [{ lineId: 'appt-1', appointmentId: PROBE_APPOINTMENT }],
    } as const
    const fixture = checkoutMapping({ ...shared, customerIndex: 42 })
    const withoutReference = tillCheckoutMapping({
      ...shared,
      tenders: TENDERS.map((tender) => ({ kind: tender.kind, amount: tender.amount })),
      issuer: FIXTURE_ISSUER,
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      customerLabel: 'Customer 0042',
      hoursFor: FIXTURE_HOURS,
    })
    expect(withoutReference.input).not.toEqual(fixture.input)
  })
})

/** Cash plus a referenced card, adding to the package price to the fils. */
const PACKAGE_TENDERS: readonly TenderLine[] = [
  { kind: 'cash', amount: gross(10_000) },
  { kind: 'card_in_salon', amount: gross(90_000), reference: 'APPROVAL-43' },
]

describe('acceptance — the till package-sale mapping is the fixture package-sale mapping', () => {
  const shared = {
    entryId: entryId('till-pkg-sale-probe'),
    tradingDate: '2026-09-18' as never,
    customerId: '00000000-0000-4000-8000-00000000ef01',
    templateVersionId: '00000000-0000-4000-8000-00000000ef02',
    priceGross: gross(100_000),
    lines: [
      { lineNo: 1, serviceVariantId: '00000000-0000-4000-8000-00000000cd01', sessionCount: 3, listGrossFils: 60_000 },
      { lineNo: 2, serviceVariantId: '00000000-0000-4000-8000-00000000cd02', sessionCount: 2, listGrossFils: 50_000 },
    ],
    // A package's tenders have to equal the price EXACTLY (ZG012): an invoice may be part paid and a package
    // may not, because a part payment would credit 2050 with a liability the salon was never paid for.
    tenders: PACKAGE_TENDERS,
    validityMonths: 6,
    transferable: false,
    unredeemedBalancePolicy: 'retained' as const,
    packageLabel: '[confirm] 5 sessions — Y9-package-catalogue',
  }

  it('produces the same sellPackage input, field for field', () => {
    expect(tillPackageSaleMapping(shared).input).toEqual(packageSaleMapping(shared).input)
  })

  it('the control: a mapping that swapped the two lines is NOT equal', () => {
    // The defect this seam really has: an allocation put on the wrong entitlement, where both shares still sum
    // to the price and ZG006 still passes. Reversing the lines is that defect, reproduced.
    const reversed = { ...shared, lines: [...shared.lines].reverse() }
    expect(tillPackageSaleMapping(reversed).input).not.toEqual(packageSaleMapping(shared).input)
  })
})

describe('acceptance — the till redemption mapping is the fixture redemption mapping', () => {
  const shared = {
    entryId: entryId('till-pkg-redeem-probe'),
    tradingDate: '2026-09-18' as never,
    balance: {
      balanceId: '00000000-0000-4000-8000-00000000ef03',
      sessionsTotal: 5,
      sessionsRedeemed: 1,
      valueGross: gross(100_000),
      releasedGross: gross(20_000),
    },
    appointmentId: PROBE_APPOINTMENT,
    units: 2,
    packageLabel: '[confirm] 5 sessions — Y9-package-catalogue',
  }

  it('produces the same redeemPackage input, field for field', () => {
    expect(tillPackageRedemptionMapping(shared).input).toEqual(
      packageRedemptionMapping(shared).input,
    )
  })

  it('the control: one more session released is NOT equal', () => {
    expect(tillPackageRedemptionMapping({ ...shared, units: 3 }).input).not.toEqual(
      packageRedemptionMapping(shared).input,
    )
  })
})

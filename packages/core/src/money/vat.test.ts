import { AppError } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import {
  filsFrom,
  money,
  roundHalfUp,
  UAE_STANDARD_VAT_BP,
  vatRateBp,
  ZERO_RATED_BP,
} from '../money.ts'
import { instantFromIso, localTime, type TimeZone, type TradingHours } from '../time.ts'
import {
  checkTrn,
  deriveDocumentTax,
  deriveTaxLine,
  type IssuerSnapshot,
  isPlaceholderText,
  issuerAddressSnapshot,
  PLACEHOLDER_MARKERS,
  PLACEHOLDER_TRN,
  requireIssuerSnapshot,
  requireIssuerTrn,
  resolveTaxPoint,
  type TaxableLine,
  TrnNotConfigured,
  vatIfReDerivedFromTotal,
} from './vat.ts'

const grossFils = (f: number) => money(filsFrom(f))
const line = (fils: number, quantity = 1, rateBp = UAE_STANDARD_VAT_BP): TaxableLine => ({
  quantity,
  unitGross: grossFils(fils),
  rateBp,
})

/** 0 to 1,000,000.00 AED in fils, the range the acceptance criterion names. */
const grossArb = fc.integer({ min: 0, max: 100_000_000 })

describe('per-line derivation', () => {
  it('net + vat === gross exactly, over 5000 cases at 5%', () => {
    fc.assert(
      fc.property(grossArb, (fils) => {
        const derived = deriveTaxLine(line(fils))
        return derived.net.fils + derived.vat.fils === derived.gross.fils
      }),
      { numRuns: 5000 },
    )
  })

  it('vat === gross - roundHalfUp(gross * 20 / 21), the declared rule, over 5000 cases', () => {
    // 5% inclusive means net = gross * 10000 / 10500 = gross * 20 / 21. Stated here as the arithmetic
    // rather than by calling splitGross, so this is an independent statement of the rule and not the
    // implementation compared with itself.
    fc.assert(
      fc.property(grossArb, (fils) => {
        const derived = deriveTaxLine(line(fils))
        return derived.vat.fils === fils - roundHalfUp((fils * 20) / 21)
      }),
      { numRuns: 5000 },
    )
  })

  it('the control: the same property is FALSE under a rounding rule that is not half-up', () => {
    // Without this, the two properties above would pass just as happily against an implementation
    // that truncated instead of rounding half-up: the two rules agree on most inputs, which is
    // precisely what lets a wrong one survive a property test. The inputs where they disagree are
    // found rather than asserted, and every one of them is checked to follow half-up and not
    // truncation — so "the declared rule" above is a statement about which rule, not just about
    // arithmetic.
    const truncating = (fils: number) => fils - Math.floor((fils * 20) / 21)
    const halfUp = (fils: number) => fils - roundHalfUp((fils * 20) / 21)
    const divergent = Array.from({ length: 200 }, (_, f) => f).filter(
      (f) => truncating(f) !== halfUp(f),
    )
    expect(divergent.length).toBeGreaterThan(0)
    for (const fils of divergent) {
      expect(deriveTaxLine(line(fils)).vat.fils).toBe(halfUp(fils))
      expect(deriveTaxLine(line(fils)).vat.fils).not.toBe(truncating(fils))
    }
  })

  it('rounds on the line gross, not per unit', () => {
    // 3 at 11 fils is 33 gross, and 33 - round(33 * 20 / 21) = 33 - 31 = 2. Rounding per unit and
    // multiplying would claim 3, and the line would then disagree with its own total.
    const derived = deriveTaxLine(line(11, 3))
    expect(derived.gross.fils).toBe(33)
    expect(derived.vat.fils).toBe(2)
    expect(derived.vat.fils).not.toBe(3)
  })

  it('a zero-rated line carries no VAT', () => {
    const derived = deriveTaxLine(line(10_000, 1, ZERO_RATED_BP))
    expect(derived.vat.fils).toBe(0)
    expect(derived.net.fils).toBe(10_000)
  })

  it('refuses a quantity that is not a whole number of at least one', () => {
    expect(() => deriveTaxLine(line(1000, 0))).toThrow(/whole quantity of at least 1/)
    expect(() => deriveTaxLine(line(1000, 1.5))).toThrow(AppError)
    expect(() => deriveTaxLine(line(1000, -2))).toThrow(/whole quantity/)
    // The control: a legitimate quantity is accepted, so the three refusals are not a function that
    // refuses everything.
    expect(deriveTaxLine(line(1000, 2)).gross.fils).toBe(2000)
  })
})

describe('the two-lines-at-11-fils case', () => {
  const TWO_ELEVENS = [line(11), line(11)] as const

  it('stores 2, because the document total is the SUM of per-line VAT', () => {
    const document = deriveDocumentTax(TWO_ELEVENS)
    expect(document.lines.map((l) => l.vat.fils)).toEqual([1, 1])
    expect(document.vat.fils).toBe(2)
    expect(document.gross.fils).toBe(22)
    expect(document.net.fils).toBe(20)
    expect(document.net.fils + document.vat.fils).toBe(document.gross.fils)
  })

  it('and the re-derivation from the 22-fils total gives 1, which is the number to look for', () => {
    // The control for the assertion above, and the reason the fixture is two lines at 11 rather than
    // any two lines: the two methods genuinely disagree here. If they agreed, "stores 2" would be
    // satisfied by the wrong implementation too.
    const document = deriveDocumentTax(TWO_ELEVENS)
    const reDerived = vatIfReDerivedFromTotal(document.gross)
    expect(reDerived.fils).toBe(1)
    expect(reDerived.fils).not.toBe(document.vat.fils)
  })

  it('refuses a document with no lines', () => {
    expect(() => deriveDocumentTax([])).toThrow(/at least one line/)
  })
})

describe('document totals', () => {
  it('are sums of the lines for an arbitrary set of lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 20 }),
        (grosses) => {
          const document = deriveDocumentTax(grosses.map((g) => line(g)))
          const lineVat = document.lines.reduce((total, l) => total + l.vat.fils, 0)
          const lineNet = document.lines.reduce((total, l) => total + l.net.fils, 0)
          return (
            document.vat.fils === lineVat &&
            document.net.fils === lineNet &&
            document.net.fils + document.vat.fils === document.gross.fils
          )
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('analyse by rate, ascending, and a mixed-rate document keeps the rates apart', () => {
    const document = deriveDocumentTax([line(21_000), line(10_000, 1, ZERO_RATED_BP), line(9_000)])
    expect(document.byRate.map((r) => r.rateBp)).toEqual([ZERO_RATED_BP, UAE_STANDARD_VAT_BP])
    const [zero, standard] = document.byRate
    expect(zero?.vat.fils).toBe(0)
    expect(zero?.gross.fils).toBe(10_000)
    expect(standard?.gross.fils).toBe(30_000)
    // The per-rate VAT sums back to the document VAT, so the analysis cannot silently lose a line.
    expect(document.byRate.reduce((t, r) => t + r.vat.fils, 0)).toBe(document.vat.fils)

    // The control: re-deriving the mixed-rate document from its 40,000-fils total at the standard
    // rate is wrong by more than a fils, which is what makes the aggregate shortcut unwritable rather
    // than merely imprecise.
    expect(vatIfReDerivedFromTotal(document.gross).fils).not.toBe(document.vat.fils)
  })

  it('a non-standard rate is honoured rather than silently replaced by 5%', () => {
    const document = deriveDocumentTax([line(10_000, 1, vatRateBp(1000))])
    expect(document.vat.fils).toBe(10_000 - roundHalfUp((10_000 * 10_000) / 11_000))
    expect(document.byRate[0]?.rateBp).toBe(1000)
  })
})

describe('the tax point is not the issue date', () => {
  const OPEN_11_TO_02: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
  const DAILY: HoursForDate = () => OPEN_11_TO_02

  it('a 01:30 supply invoiced the next day keeps its tax point on the previous trading date', () => {
    const resolved = resolveTaxPoint({
      // 01:30 on the 19th is inside the 18th's 11:00-02:00 session.
      supplyAt: instantFromIso('2026-09-19T01:30:00+04:00'),
      issuedAt: instantFromIso('2026-09-19T12:00:00+04:00'),
      hoursFor: DAILY,
    })
    expect(resolved.kind).toBe('resolved')
    if (resolved.kind !== 'resolved') return
    expect(resolved.taxPointDate).toBe('2026-09-18')
    expect(resolved.issueDate).toBe('2026-09-19')
    // The whole point: the two dates differ. A resolver that returned the calendar date for both
    // would satisfy every other assertion in this file.
    expect(resolved.taxPointDate).not.toBe(resolved.issueDate)
    expect(resolved.issueTradingDate).toBe('2026-09-19')
  })

  it('a supply during the evening keeps the tax point and the issue date the same', () => {
    // The control. If the tax point were always the previous date, the case above would pass for the
    // wrong reason.
    const resolved = resolveTaxPoint({
      supplyAt: instantFromIso('2026-09-18T20:00:00+04:00'),
      issuedAt: instantFromIso('2026-09-18T20:05:00+04:00'),
      hoursFor: DAILY,
    })
    expect(resolved.kind).toBe('resolved')
    if (resolved.kind !== 'resolved') return
    expect(resolved.taxPointDate).toBe('2026-09-18')
    expect(resolved.issueDate).toBe('2026-09-18')
  })

  it('reports an issue during the daytime gap as belonging to no trading date', () => {
    const resolved = resolveTaxPoint({
      supplyAt: instantFromIso('2026-09-18T20:00:00+04:00'),
      // 10:00 is after the previous night's 02:00 close and before the 11:00 opening.
      issuedAt: instantFromIso('2026-09-19T10:00:00+04:00'),
      hoursFor: DAILY,
    })
    expect(resolved.kind).toBe('resolved')
    if (resolved.kind !== 'resolved') return
    expect(resolved.issueTradingDate).toBeNull()
    expect(resolved.issueDate).toBe('2026-09-19')
    expect(resolved.taxPointDate).toBe('2026-09-18')
  })

  it('refuses to invent a tax point for a supply that belongs to no trading date', () => {
    const resolved = resolveTaxPoint({
      supplyAt: instantFromIso('2026-09-19T09:00:00+04:00'),
      issuedAt: instantFromIso('2026-09-19T12:00:00+04:00'),
      hoursFor: DAILY,
    })
    expect(resolved.kind).toBe('unresolved')
    if (resolved.kind !== 'unresolved') return
    expect(resolved.reason).toBe('before_opening')
    expect(resolved.calendarDate).toBe('2026-09-19')
  })

  it('takes the zone as an argument, and an explicit UTC zone moves the trading date', () => {
    // 22:30 UTC on the 18th is 02:30 Dubai on the 19th, which is outside the 18th's session — so the
    // same instant resolves differently depending on the zone, and the zone is therefore never
    // ambient. Asserted so that a default quietly baked in somewhere would fail here.
    const supplyAt = instantFromIso('2026-09-18T22:30:00Z')
    const dubai = resolveTaxPoint({ supplyAt, issuedAt: supplyAt, hoursFor: DAILY })
    const utc = resolveTaxPoint({
      supplyAt,
      issuedAt: supplyAt,
      hoursFor: DAILY,
      zone: 'UTC' as TimeZone,
    })
    expect(dubai.kind).toBe('unresolved')
    expect(utc.kind).toBe('resolved')
    if (utc.kind !== 'resolved') return
    expect(utc.taxPointDate).toBe('2026-09-18')
  })
})

describe('the placeholder TRN fails validation', () => {
  /** Fifteen digits. A test value, not the business's registration number (Y1-trn is open). */
  const REAL_SHAPED_TRN = '100123456700003'

  it('rejects the seeded placeholder with TrnNotConfigured', () => {
    expect(() => requireIssuerTrn(PLACEHOLDER_TRN)).toThrow(TrnNotConfigured)
    expect(() => requireIssuerTrn(PLACEHOLDER_TRN)).toThrow(/TrnNotConfigured/)
    expect(checkTrn(PLACEHOLDER_TRN)).toEqual({ ok: false, reason: 'placeholder' })
  })

  it('accepts a fifteen-digit TRN — otherwise the check is just "invoices never validate"', () => {
    // The control without which the assertion above is worthless: a validator that rejected
    // everything would satisfy it, and nothing would ever be issuable.
    expect(requireIssuerTrn(REAL_SHAPED_TRN)).toBe(REAL_SHAPED_TRN)
    expect(checkTrn(REAL_SHAPED_TRN)).toEqual({ ok: true, trn: REAL_SHAPED_TRN })
    expect(requireIssuerTrn(`  ${REAL_SHAPED_TRN}  `)).toBe(REAL_SHAPED_TRN)
  })

  it('names which of the three problems it found', () => {
    expect(checkTrn(null).ok).toBe(false)
    expect(checkTrn(null)).toEqual({ ok: false, reason: 'missing' })
    expect(checkTrn(undefined)).toEqual({ ok: false, reason: 'missing' })
    expect(checkTrn('   ')).toEqual({ ok: false, reason: 'missing' })
    expect(checkTrn('12345')).toEqual({ ok: false, reason: 'malformed' })
    expect(checkTrn('10012345670000A')).toEqual({ ok: false, reason: 'malformed' })
    // An operator needs to be told which, so the reason travels on the error too.
    try {
      requireIssuerTrn('12345')
      expect.unreachable('a five-digit TRN must not validate')
    } catch (err) {
      expect(err).toBeInstanceOf(TrnNotConfigured)
      expect((err as TrnNotConfigured).reason).toBe('malformed')
      expect((err as TrnNotConfigured).name).toBe('TrnNotConfigured')
      expect((err as TrnNotConfigured).kind).toBe('invariant_violated')
    }
  })

  it('recognises every placeholder marker, and does not flag a real value', () => {
    for (const marker of PLACEHOLDER_MARKERS) {
      expect(isPlaceholderText(`Some ${marker} value`)).toBe(true)
      expect(isPlaceholderText(marker.toUpperCase())).toBe(true)
    }
    expect(isPlaceholderText(null)).toBe(true)
    expect(isPlaceholderText(undefined)).toBe(true)
    expect(isPlaceholderText('  ')).toBe(true)
    // Controls. Nothing here carries a marker, and a matcher that flagged them would refuse the real
    // legal name and the real address.
    expect(isPlaceholderText('BE RELAX SPA - L.L.C - O.P.C')).toBe(false)
    expect(isPlaceholderText('250 Al Meena Street')).toBe(false)
    expect(isPlaceholderText(REAL_SHAPED_TRN)).toBe(false)
  })

  describe('the issuer snapshot', () => {
    const CONFIGURED: IssuerSnapshot = {
      legalName: 'BE RELAX SPA - L.L.C - O.P.C',
      tradingName: 'BE RELAX - Massage Center and Spa',
      trn: REAL_SHAPED_TRN,
      addressLines: ['250 Al Meena Street', 'Al Zahiyah', 'Abu Dhabi'],
      emirate: 'Abu Dhabi',
    }

    it('passes when the name, the address and the TRN are all real', () => {
      expect(requireIssuerSnapshot(CONFIGURED)).toBe(CONFIGURED)
      expect(issuerAddressSnapshot(CONFIGURED.addressLines)).toBe(
        '250 Al Meena Street\nAl Zahiyah\nAbu Dhabi',
      )
    })

    it('refuses a placeholder TRN, legal name or address, each on its own', () => {
      expect(() => requireIssuerSnapshot({ ...CONFIGURED, trn: PLACEHOLDER_TRN })).toThrow(
        TrnNotConfigured,
      )
      expect(() => requireIssuerSnapshot({ ...CONFIGURED, legalName: '[CONFIRM]' })).toThrow(
        /IssuerNotConfigured: legal_entity.legal_name/,
      )
      expect(() => requireIssuerSnapshot({ ...CONFIGURED, addressLines: [] })).toThrow(
        /IssuerNotConfigured: the premises address/,
      )
      expect(() => requireIssuerSnapshot({ ...CONFIGURED, addressLines: ['TBC'] })).toThrow(
        /premises address/,
      )
    })
  })
})

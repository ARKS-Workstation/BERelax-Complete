import { describe, expect, it } from 'vitest'
import { releaseThrough } from '../money/package-drawdown.ts'
import { filsFrom, money } from '../money.ts'
import { localDate } from '../time.ts'
import { STANDARD_SPA_CHART } from './chart-of-accounts.ts'
import { entryId, postEntry } from './entry.ts'
import {
  formatOpeningPackageVariance,
  MalformedReconstruction,
  OPENING_PACKAGE_LIABILITY_ACCOUNTS,
  openingPackageLiability,
  openingPackageLiabilityPosting,
  type ReconstructedPackage,
  reconcileOpeningPackageCash,
} from './opening-package-liability.ts'

/**
 * The pure half of H-MIG-03: what a reconstructed package still owes, and whether a file reconciles.
 *
 * Every claim is paired with a control that must fail (brief rule 3), because both of the figures here are
 * the kind whose being quietly wrong is undetectable: a liability that is out by a fils is out by it for
 * ever, and a reconciliation with a tolerance passes for the import it was supposed to block.
 */

const ATTESTATION = 'owner_attestation'

const row = (over: Partial<ReconstructedPackage> = {}): ReconstructedPackage => ({
  lineNumber: 4,
  holderPhoneE164: '+971590000101',
  templateKey: 'fixture_template_a',
  purchaseDate: localDate('2025-03-11'),
  pricePaid: money(filsFrom(100_000)),
  sessionsTotal: 5,
  sessionsUsed: 0,
  expiresOn: localDate('2025-09-11'),
  evidenceKind: 'receipt',
  ...over,
})

describe('what a reconstructed package still owes', () => {
  it('owes the whole price when no session has been taken', () => {
    const liability = openingPackageLiability(row())
    expect(liability.sessionsRemaining).toBe(5)
    expect(liability.consumed.fils).toBe(0)
    expect(liability.outstanding.fils).toBe(100_000)
  })

  it('owes nothing when every session has been taken', () => {
    const liability = openingPackageLiability(row({ sessionsUsed: 5 }))
    expect(liability.sessionsRemaining).toBe(0)
    // Exactly the price, not nearly it. The release formula's fourth property is that it is exactly the
    // value at `total`, which is what makes a fully drawn package owe zero rather than a rounding.
    expect(liability.consumed.fils).toBe(100_000)
    expect(liability.outstanding.fils).toBe(0)
  })

  it('splits a price that does not divide, by the ledger formula and not by a second one', () => {
    // 95,000 over 5 sessions with 1 taken. The control is the figure a different-but-plausible rule gives:
    // `floor(95000 / 5) * 1` is 19,000 here and the two agree, so the case that matters is the one where
    // they do not — 95,001 over 7.
    const divides = openingPackageLiability(
      row({ pricePaid: money(filsFrom(95_000)), sessionsTotal: 5, sessionsUsed: 1 }),
    )
    expect(divides.outstanding.fils).toBe(76_000)

    const awkward = { pricePaid: money(filsFrom(95_001)), sessionsTotal: 7, sessionsUsed: 3 }
    const liability = openingPackageLiability(row(awkward))
    expect(liability.consumed.fils).toBe(releaseThrough(money(filsFrom(95_001)), 7, 3).fils)
    expect(liability.outstanding.fils).toBe(95_001 - liability.consumed.fils)
    // The control: a per-session figure multiplied up disagrees, which is why this module calls the
    // formula rather than dividing. If this ever stops disagreeing the case above has stopped measuring.
    expect(Math.floor(95_001 / 7) * 3).not.toBe(liability.consumed.fils)
  })

  it('never leaves a liability that the sessions do not account for', () => {
    // The property, over every split of a price that does not divide: consumed plus outstanding is the
    // price, exactly, at every point — which is what makes the sum of this unit's imports equal to 2050.
    for (let used = 0; used <= 7; used += 1) {
      const liability = openingPackageLiability(
        row({ pricePaid: money(filsFrom(95_001)), sessionsTotal: 7, sessionsUsed: used }),
      )
      expect(liability.consumed.fils + liability.outstanding.fils).toBe(95_001)
      expect(liability.outstanding.fils).toBeGreaterThanOrEqual(0)
    }
  })

  it('refuses a row whose counts cannot describe a package', () => {
    expect(() => openingPackageLiability(row({ sessionsTotal: 0 }))).toThrow(
      MalformedReconstruction,
    )
    expect(() => openingPackageLiability(row({ sessionsUsed: 6 }))).toThrow(MalformedReconstruction)
    expect(() => openingPackageLiability(row({ sessionsUsed: -1 }))).toThrow(
      MalformedReconstruction,
    )
    expect(() => openingPackageLiability(row({ pricePaid: money(filsFrom(0)) }))).toThrow(
      MalformedReconstruction,
    )
    // The control: the row the fixtures carry is accepted, so the four above are refusing something
    // specific rather than everything.
    expect(() => openingPackageLiability(row())).not.toThrow()
  })
})

describe('the opening posting', () => {
  const posting = (outstandingFils: number) =>
    openingPackageLiabilityPosting({
      entryId: entryId('pkg-open-probe'),
      openingDate: localDate('2026-10-01'),
      outstanding: money(filsFrom(outstandingFils)),
      reconstructionId: '01a0-probe',
      holderPhoneE164: '+971590000101',
      templateKey: 'fixture_template_a',
    })

  it('credits the package liability and debits opening equity, and balances', () => {
    const entry = postEntry(posting(60_000), STANDARD_SPA_CHART)
    expect(entry.source).toBe('opening_balance')
    const byAccount = new Map(
      entry.lines.map((line) => [line.account as string, line.debitFils - line.creditFils]),
    )
    expect(byAccount.get(OPENING_PACKAGE_LIABILITY_ACCOUNTS.liability as string)).toBe(-60_000)
    expect(byAccount.get(OPENING_PACKAGE_LIABILITY_ACCOUNTS.counterpart as string)).toBe(60_000)
    // The acceptance line "no output VAT is posted at import", at the one place the entry is built.
    expect(byAccount.has('2030')).toBe(false)
    expect(byAccount.has('4020')).toBe(false)
  })

  it('names the reconstruction in its narrative, so the entry is readable without a join', () => {
    expect(posting(60_000).narrative).toContain('01a0-probe')
    expect(posting(60_000).narrative).toContain('+971590000101')
  })

  it('refuses to post a liability of nothing', () => {
    // A fully drawn package owes nothing and is imported with no sale at all. Building an entry for zero
    // would be refused by `journal_line_exactly_one_side` at the INSERT, which is a worse place to find it.
    expect(() => posting(0)).toThrow(MalformedReconstruction)
    expect(() => posting(-1)).toThrow(MalformedReconstruction)
    // The control.
    expect(() => posting(1)).not.toThrow()
  })
})

describe('the cash reconciliation', () => {
  /** The five rows of H-MIG-02's clean fixture, as figures. Totals: 415,000 paid, 276,000 outstanding. */
  const clean: readonly ReconstructedPackage[] = [
    row({ lineNumber: 4, pricePaid: money(filsFrom(100_000)), sessionsTotal: 5, sessionsUsed: 0 }),
    row({ lineNumber: 5, pricePaid: money(filsFrom(100_000)), sessionsTotal: 5, sessionsUsed: 2 }),
    row({ lineNumber: 6, pricePaid: money(filsFrom(60_000)), sessionsTotal: 3, sessionsUsed: 3 }),
    row({
      lineNumber: 7,
      pricePaid: money(filsFrom(60_000)),
      sessionsTotal: 3,
      sessionsUsed: 1,
      evidenceKind: ATTESTATION,
    }),
    row({ lineNumber: 8, pricePaid: money(filsFrom(95_000)), sessionsTotal: 5, sessionsUsed: 1 }),
  ]

  const reconcile = (cashFils: number) =>
    reconcileOpeningPackageCash({
      rows: clean,
      cashReceived: money(filsFrom(cashFils)),
      attestationEvidenceKind: ATTESTATION,
    })

  it('reconciles when the cash equals the file, and reports the liability the ledger must hold', () => {
    const report = reconcile(415_000)
    expect(report.ok).toBe(true)
    expect(report.varianceFils).toBe(0)
    expect(report.totalPricePaid.fils).toBe(415_000)
    expect(report.totalOutstanding.fils).toBe(276_000)
    expect(report.attestedRows).toBe(1)
    expect(formatOpeningPackageVariance(report, 'workbook.tsv')).toEqual([])
  })

  it('blocks on one fils in either direction, and lists every contributing row', () => {
    for (const cash of [414_999, 415_001]) {
      const report = reconcile(cash)
      expect(report.ok, `cash ${cash}`).toBe(false)
      expect(Math.abs(report.varianceFils), `cash ${cash}`).toBe(1)
      const lines = formatOpeningPackageVariance(report, 'workbook.tsv')
      // The acceptance line: the variance report LISTS the contributing rows. One header plus five rows,
      // each naming its line in the file, because the file is what somebody has to go and correct.
      expect(lines).toHaveLength(6)
      for (const line of clean) {
        expect(lines.some((text) => text.includes(`workbook.tsv:${line.lineNumber}`))).toBe(true)
      }
    }
  })

  it('orders the contributions largest first, deterministically', () => {
    const report = reconcile(1)
    expect(report.contributions.map((row_) => row_.pricePaidFils)).toEqual([
      100_000, 100_000, 95_000, 60_000, 60_000,
    ])
    // Ties broken by line, so two runs over one file produce the same report rather than whatever the
    // sort happened to do with two equal prices.
    expect(report.contributions.slice(0, 2).map((row_) => row_.lineNumber)).toEqual([4, 5])
  })

  it('counts the attested rows in the same pass as the totals', () => {
    // The control: a second count over a differently-filtered set is how "one of these rests on a
    // recollection" becomes none, so the count is asserted against a file where the attested row is also
    // the one with the smallest contribution — i.e. not findable by position.
    const report = reconcile(415_000)
    expect(report.attestedRows).toBe(
      clean.filter((line) => line.evidenceKind === ATTESTATION).length,
    )
    expect(report.rows).toBe(5)
  })
})

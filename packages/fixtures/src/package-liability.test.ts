import { readFileSync } from 'node:fs'
import { EVIDENCE_KINDS } from '@berelax/migration/importers/packages'
import { describe, expect, it } from 'vitest'
import {
  ATTESTATION_EVIDENCE_KIND,
  asWorkbookRow,
  evidenceKindsNamedInMigration,
  expectedOutstandingFils,
  type LiabilityFixtureRow,
  PACKAGE_LIABILITY_MIGRATION,
} from './package-liability.ts'

/**
 * The two statements of one word, held equal — and the fixture arithmetic, checked against a figure a
 * person can verify by hand.
 *
 * `0119_migration_signoff.sql` spells `owner_attestation` exactly once, as the expression of the GENERATED
 * column `imported_package_sale.admitted_on_attestation`. That is deliberate: the flag is generated so it
 * cannot DISAGREE with the kind, which a stored boolean beside it could — and the failure mode of that
 * would be the quiet one, a liability resting on the owner's recollection that every report counts as
 * documented.
 *
 * But generating it means SQL holds a copy of a word H-MIG-02's vocabulary owns, and SQL cannot import
 * TypeScript. So the two are held equal here, in the one package that can read both, in the same way
 * `card-shape-agreement.itest.ts` holds `is_card_shaped()` to `cardShapedRuns()`. Rename the kind without
 * touching the migration and this fails by name rather than silently clearing a flag.
 */

const row = (over: Partial<LiabilityFixtureRow> = {}): LiabilityFixtureRow => ({
  holderPhoneE164: '+971590000101',
  templateKey: 'fixture_template_a',
  purchaseDate: '2082-03-11',
  pricePaidFils: 100_000,
  sessionsTotal: 5,
  sessionsUsed: 0,
  expiresOn: '2082-09-11',
  evidenceKind: 'receipt',
  evidenceReference: 'receipt 4417',
  notes: '',
  ...over,
})

describe('the attestation kind is one word in two languages', () => {
  it('is a member of H-MIG-02 vocabulary', () => {
    expect(EVIDENCE_KINDS).toContain(ATTESTATION_EVIDENCE_KIND)
  })

  it('is the word migration 0119 generates the flag from', () => {
    const named = evidenceKindsNamedInMigration()
    // The floor first (ADR 0002): a regular expression that stopped matching would report agreement
    // between an empty list and the vocabulary, which is the shape of pass this whole file is against.
    expect(
      named,
      'the generated-column expression in 0119 no longer matches the pattern this check reads, so it is ' +
        'comparing nothing. Update the pattern in the same commit as the column.',
    ).toHaveLength(1)
    expect(named[0]).toBe(ATTESTATION_EVIDENCE_KIND)
  })

  it('is spelled in the migration exactly once, so there is one copy to hold equal', () => {
    const sql = readFileSync(PACKAGE_LIABILITY_MIGRATION, 'utf8')
    const occurrences = sql.split(`'${ATTESTATION_EVIDENCE_KIND}'`).length - 1
    expect(
      occurrences,
      'the migration spells the attestation kind more than once. A second copy is a second statement of ' +
        "a fact H-MIG-02's vocabulary owns, and this check only holds ONE of them to it.",
    ).toBe(1)
  })

  it('names no other kind in the migration', () => {
    // The control: every other kind in the vocabulary must be absent from the SQL, because a CHECK listing
    // the reasons a row may rest on would be the second list 0111 refused to write for rejections.
    const sql = readFileSync(PACKAGE_LIABILITY_MIGRATION, 'utf8')
    for (const kind of EVIDENCE_KINDS) {
      if (kind === ATTESTATION_EVIDENCE_KIND) continue
      expect(sql, `the migration names the evidence kind "${kind}"`).not.toContain(`'${kind}'`)
    }
  })
})

describe('the workbook row a suite imports', () => {
  it('derives sessions_remaining rather than carrying a typed one', () => {
    expect(asWorkbookRow(row({ sessionsTotal: 5, sessionsUsed: 2 })).sessionsRemaining).toBe('3')
    // The control: a fixture that typed the figure would make the validator's one cross-check vacuous,
    // so the derivation has to be visible as a derivation.
    expect(asWorkbookRow(row({ sessionsTotal: 3, sessionsUsed: 3 })).sessionsRemaining).toBe('0')
  })

  it('signs every row off, because an unsigned row is a rejection and not a fixture', () => {
    expect(asWorkbookRow(row()).ownerSignedOff).toBe('yes')
  })

  it('totals the outstanding liability to a figure that can be checked by hand', () => {
    // 100,000 untouched + 100,000 with 2 of 5 taken (60,000) + 60,000 fully drawn (0)
    //   + 60,000 with 1 of 3 taken (40,000) + 95,000 with 1 of 5 taken (76,000) = 276,000.
    const rows = [
      row({ pricePaidFils: 100_000, sessionsTotal: 5, sessionsUsed: 0 }),
      row({ pricePaidFils: 100_000, sessionsTotal: 5, sessionsUsed: 2 }),
      row({ pricePaidFils: 60_000, sessionsTotal: 3, sessionsUsed: 3 }),
      row({ pricePaidFils: 60_000, sessionsTotal: 3, sessionsUsed: 1 }),
      row({ pricePaidFils: 95_000, sessionsTotal: 5, sessionsUsed: 1 }),
    ]
    expect(expectedOutstandingFils(rows)).toBe(276_000)
    // And it is NOT the total paid, which is the figure a reconciliation that had been written the easy
    // way would produce.
    expect(expectedOutstandingFils(rows)).not.toBe(415_000)
  })
})

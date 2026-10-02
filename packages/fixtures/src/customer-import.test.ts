import { E164_IDENTITY_REJECTIONS, e164IdentityResult } from '@berelax/core'
import { parseContactWorkbook } from '@berelax/migration/importers/customers'
import { describe, expect, it } from 'vitest'
import {
  buildContactList,
  CONTACT_LIST_HEADER,
  CONTACT_SPELLINGS,
  contactNormaliser,
  UNREADABLE_REASONS,
  unreadableCells,
} from './customer-import.ts'
import { ALLOCATED_UAE_MOBILE_PREFIXES, REAL_BUSINESS_NUMBERS } from './synthetic.ts'

/**
 * The contact-list fixture, with nothing running.
 *
 * Three claims, and the first is the one the integration suite's arithmetic rests on: **the file says what
 * this module says it says.** The distinct count and the duplicate count are what H-MIG-04's fourth
 * acceptance line is asserted against, so a generator that reported a figure the file did not contain
 * would make that case pass while measuring something else.
 */

describe('the contact-list fixture', () => {
  it('reports the counts that are actually in the file', () => {
    const list = buildContactList({
      baseIndex: 4_000_000,
      distinct: 50,
      duplicates: 6,
      claimEvery: 5,
      unreadable: unreadableCells(7),
    })
    const cells = parseContactWorkbook(list.sourceText)
    expect(cells).toHaveLength(list.lines)
    expect(list.lines).toBe(50 + 6 + unreadableCells(7).length)
    expect(list.duplicates).toBe(6)
    expect(list.quarantined).toBe(unreadableCells(7).length)
    expect(cells.filter((cell) => cell.sourceConsentClaim)).toHaveLength(list.claims)

    // What the file actually normalises to, counted the way the import counts it.
    const canonical = cells
      .map((cell) => e164IdentityResult(cell.phoneAsListed))
      .filter((result) => result.ok)
      .map((result) => (result.ok ? result.e164 : ''))
    expect(new Set(canonical).size).toBe(list.numbers.length)
    expect(canonical.length - new Set(canonical).size).toBe(list.duplicates)
    expect(cells.length - canonical.length).toBe(list.quarantined)
  })

  it('writes every spelling, so the normaliser is exercised over all of them', () => {
    // A list written in one spelling would assert nothing about the other seven, and the planted
    // duplicates are specifically a DIFFERENT spelling of a number already present.
    const list = buildContactList({ baseIndex: 4_100_000, distinct: CONTACT_SPELLINGS.length * 2 })
    const cells = parseContactWorkbook(list.sourceText)
    // Latin and Arabic-Indic digits are blanked to DIFFERENT markers, because `0590000042` and
    // `٠٥٩٠٠٠٠٠٤٢` are the same shape and not the same spelling — and the Arabic one is the spelling an
    // Arabic-locale contact list actually holds, which is the whole reason it is in the list.
    const shapes = new Set(
      cells.map((cell) => cell.phoneAsListed.replace(/[0-9]/g, '#').replace(/[٠-٩]/g, '@')),
    )
    expect(shapes.size).toBe(CONTACT_SPELLINGS.length)
    for (const cell of cells) {
      // Every spelling the generator writes must normalise, or the fixture would be planting quarantines
      // it did not report.
      expect(contactNormaliser(cell.phoneAsListed).ok, cell.phoneAsListed).toBe(true)
    }
  })

  it('plants an unreadable cell for every reason, and each produces its own', () => {
    for (const entry of unreadableCells(7)) {
      const result = contactNormaliser(entry.cell)
      expect(result.ok, entry.cell).toBe(false)
      expect(result.ok ? '' : result.reason, entry.cell).toBe(entry.reason)
    }
    // The set is complete: every reason the normaliser can give has a cell that produces it, so the
    // quarantine assertions in the integration suite cover the whole vocabulary rather than one value.
    expect([...UNREADABLE_REASONS].sort()).toEqual([...E164_IDENTITY_REJECTIONS].sort())
  })

  it('never produces a number that could reach a real handset', () => {
    const list = buildContactList({ baseIndex: 4_200_000, distinct: 120, duplicates: 14 })
    for (const number of list.numbers) {
      expect(REAL_BUSINESS_NUMBERS).not.toContain(number)
      expect(ALLOCATED_UAE_MOBILE_PREFIXES as readonly string[]).not.toContain(
        number.replace('+971', '').slice(0, 2),
      )
    }
    // The two numbers H-MIG-04's acceptance line names are the business's own and must never be in a
    // list this module builds — normalising them is the proof, creating a customer from one is not.
    expect(list.sourceText).not.toContain('5108633')
    expect(list.sourceText).not.toContain('5576533')
  })

  it('builds a file an importer can read, with the generated header', () => {
    const list = buildContactList({ baseIndex: 4_300_000, distinct: 3 })
    expect(list.sourceText).toContain(CONTACT_LIST_HEADER)
    expect(() => parseContactWorkbook(list.sourceText)).not.toThrow()
  })

  it('places more repeats than it has room to interleave rather than dropping them', () => {
    // `duplicates` larger than `distinct` has no interleaving slot for every repeat, and the generator
    // must then still produce the count it reports — a fixture that silently planted fewer would make
    // every assertion about the dedup off by the difference.
    const list = buildContactList({ baseIndex: 4_400_000, distinct: 2, duplicates: 5 })
    expect(list.duplicates).toBe(5)
    expect(list.lines).toBe(7)
    const canonical = parseContactWorkbook(list.sourceText)
      .map((cell) => e164IdentityResult(cell.phoneAsListed))
      .map((result) => (result.ok ? result.e164 : ''))
    expect(new Set(canonical).size).toBe(2)
  })
})

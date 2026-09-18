import { SERVICE_DURATIONS, TREATMENT_KEYS, TREATMENT_STYLES } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { PRICE_ON_REQUEST_SEED } from './catalogue.ts'
import {
  comparePriceCells,
  DOCS_13_PRICE_POINT_COUNT,
  DOCS_13_PRICES_AED,
  docs13PriceCells,
  FILS_PER_AED,
  type StoredPricePoint,
} from './fixtures/prices-docs-13.ts'

/**
 * The transcription of docs/13 §4, and the comparison that will catch a wrong cell.
 *
 * This file deliberately does **not** assert the 32 figures against a second copy of them. A test that
 * restated the table would be comparing the document against itself, would pass for any pair of
 * identical typos, and would double the number of places a price rise has to be applied. The figures
 * are compared against the *database* by `packages/fixtures/src/business-seed.itest.ts`, which is the
 * comparison the acceptance criterion is about.
 *
 * What is asserted here is everything about the table that is checkable without a database: that it is
 * total over the three enums, that the conversion to fils is the only arithmetic in it, and — the half
 * that makes the whole thing worth having — that `comparePriceCells` actually reports a wrong cell by
 * name. ADR 0003: a check nobody has seen fail is not a check.
 */

const cells = docs13PriceCells()

describe('docs/13 §4 is transcribed in full', () => {
  it('states exactly 32 price points, one per (style, treatment, duration)', () => {
    expect(cells).toHaveLength(DOCS_13_PRICE_POINT_COUNT)
    expect(DOCS_13_PRICE_POINT_COUNT).toBe(
      TREATMENT_STYLES.length * TREATMENT_KEYS.length * SERVICE_DURATIONS.length,
    )
    // No duplicate cell: a repeated (style, treatment, duration) would make one of the 32 unreachable
    // while the count still read 32.
    const keys = new Set(cells.map((c) => `${c.style}/${c.treatmentKey}/${c.durationMinutes}`))
    expect(keys.size).toBe(DOCS_13_PRICE_POINT_COUNT)
  })

  it('covers every style, every treatment and every duration with a positive whole price', () => {
    for (const style of TREATMENT_STYLES) {
      for (const treatmentKey of TREATMENT_KEYS) {
        for (const durationMinutes of SERVICE_DURATIONS) {
          const aed = DOCS_13_PRICES_AED[style][treatmentKey][durationMinutes]
          // A missing cell is a compile error, so this is about the VALUE: 0 would pass a
          // non-negative check, invoice as 0.00 and reconcile to nothing, and a fraction of a dirham
          // cannot be an integer number of fils.
          expect(Number.isInteger(aed), `${style}/${treatmentKey} ${durationMinutes}min`).toBe(true)
          expect(aed, `${style}/${treatmentKey} ${durationMinutes}min`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('converts to fils by the one multiplication and nothing else', () => {
    for (const cell of cells) {
      expect(cell.grossPriceFils).toBe(cell.aed * FILS_PER_AED)
      expect(Number.isInteger(cell.grossPriceFils)).toBe(true)
    }
    // The cell the acceptance criterion names, spelled out: Arabic Morocco Bath, 90 minutes, 520 AED.
    const arabicBath90 = cells.find(
      (c) =>
        c.style === 'arabic' &&
        c.treatmentKey === 'morocco_bath_jacuzzi' &&
        c.durationMinutes === 90,
    )
    // Labelled with the cell, so a corrupted figure names WHICH price is wrong. Every number in that
    // table is exactly as plausible as every other, so "expected 52500 to be 52000" on its own sends the
    // reader looking through 32 cells.
    expect(arabicBath90?.aed, 'docs/13 §4: arabic/morocco_bath_jacuzzi 90min is 520 AED').toBe(520)
    expect(
      arabicBath90?.grossPriceFils,
      'docs/13 §4: arabic/morocco_bath_jacuzzi 90min is 52000 fils',
    ).toBe(52000)
  })

  it('prices longer treatments no lower than shorter ones, within a treatment', () => {
    // Not a rule of the business — it is a property every column of docs/13 §4 happens to have, which
    // makes it a cheap trap for a transposed pair of figures. It is asserted per treatment rather than
    // across the menu, because an Asian 120-minute massage is legitimately cheaper than an Arabic
    // 45-minute bath.
    for (const style of TREATMENT_STYLES) {
      for (const treatmentKey of TREATMENT_KEYS) {
        const row = DOCS_13_PRICES_AED[style][treatmentKey]
        for (let i = 1; i < SERVICE_DURATIONS.length; i += 1) {
          const shorter = SERVICE_DURATIONS[i - 1] as (typeof SERVICE_DURATIONS)[number]
          const longer = SERVICE_DURATIONS[i] as (typeof SERVICE_DURATIONS)[number]
          expect(row[longer], `${style}/${treatmentKey} ${longer} vs ${shorter}`).toBeGreaterThan(
            row[shorter],
          )
        }
      }
    }
  })

  it('prices the Arabic menu above the Asian one, which is what docs/13 §4 shows', () => {
    // The same kind of trap in the other direction: the two tables are near-identical in shape, so the
    // likeliest transcription error is a row copied from the wrong menu. Every Arabic cell is strictly
    // higher than its Asian counterpart in docs/13, so a copied row shows up here.
    for (const treatmentKey of TREATMENT_KEYS) {
      for (const durationMinutes of SERVICE_DURATIONS) {
        expect(
          DOCS_13_PRICES_AED.arabic[treatmentKey][durationMinutes],
          `${treatmentKey} ${durationMinutes}min`,
        ).toBeGreaterThan(DOCS_13_PRICES_AED.asian[treatmentKey][durationMinutes])
      }
    }
  })
})

describe('comparePriceCells — the control', () => {
  const stored: readonly StoredPricePoint[] = cells.map((c) => ({
    style: c.style,
    treatmentKey: c.treatmentKey,
    durationMinutes: c.durationMinutes,
    grossPriceFils: c.grossPriceFils,
  }))

  it('reports nothing when the stored set is docs/13', () => {
    expect(comparePriceCells(stored)).toEqual([])
  })

  it('names the one cell that is wrong, rather than only exiting non-zero', () => {
    const corrupted = stored.map((row) =>
      row.style === 'arabic' &&
      row.treatmentKey === 'morocco_bath_jacuzzi' &&
      row.durationMinutes === 90
        ? { ...row, grossPriceFils: 52500 }
        : row,
    )
    const mismatches = comparePriceCells(corrupted)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]).toEqual({
      cell: 'arabic/morocco_bath_jacuzzi 90min',
      expectedFils: 52000,
      actualFils: 52500,
      reason: 'wrong_price',
    })
  })

  it('reports a missing cell as missing, not as a pass', () => {
    const short = stored.filter((row) => row.durationMinutes !== 45)
    const mismatches = comparePriceCells(short)
    expect(mismatches).toHaveLength(8)
    expect(mismatches.every((m) => m.reason === 'missing')).toBe(true)
    expect(mismatches.map((m) => m.cell)).toContain('asian/normal_massage 45min')
  })

  it('reports a 33rd price point, which a count of 32 would not', () => {
    const extra = [
      ...stored,
      {
        style: 'asian',
        treatmentKey: 'normal_massage',
        durationMinutes: 30,
        grossPriceFils: 12000,
      },
    ]
    const mismatches = comparePriceCells(extra)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.reason).toBe('not_in_docs_13')
    expect(mismatches[0]?.cell).toBe('asian/normal_massage 30min')
  })
})

describe('the price-on-request seed carries no price', () => {
  it('lists exactly the three offerings docs/13 §4 prices on request', () => {
    expect(PRICE_ON_REQUEST_SEED.map((item) => item.menuLabel)).toEqual([
      'Four Hands Massage',
      'Couple Massage',
      'Full Body Shaving',
    ])
  })

  it('has no price-like field at all, on any row', () => {
    // The point of 0032 is the absence. Asserted over the seed's own keys because a `grossPriceFils`
    // added here would be a derived figure — and a derived figure is quoted to a customer and printed
    // on a tax invoice with nothing marking it as a guess.
    for (const item of PRICE_ON_REQUEST_SEED) {
      for (const key of Object.keys(item)) {
        expect(/price|fils|amount|aed/i.test(key), `${item.menuLabel} carries "${key}"`).toBe(false)
      }
    }
  })

  it('names an open question and states why, on every row', () => {
    for (const item of PRICE_ON_REQUEST_SEED) {
      expect(item.openQuestionId).toMatch(/^Y[0-9]+-[a-z][a-z0-9-]*$/)
      expect(item.provisionalNote.trim().length).toBeGreaterThan(20)
      // The note has to say what is missing, or the panel shows an assumption nobody can act on.
      expect(item.provisionalNote).toContain('price on request')
    }
  })

  it('models the two-therapist footprints as shapes and leaves Full Body Shaving unmodelled', () => {
    const byLabel = new Map(PRICE_ON_REQUEST_SEED.map((item) => [item.menuLabel, item]))
    expect(byLabel.get('Four Hands Massage')?.shape).toBe('four_hands')
    expect(byLabel.get('Couple Massage')?.shape).toBe('couple')
    // Not a treatment key, not a shape of one, and named once with no style — so a (style × treatment)
    // row would invent an Asian and an Arabic version of it.
    expect(byLabel.get('Full Body Shaving')?.modelledAs).toBe('not_modelled')
    expect(byLabel.get('Full Body Shaving')?.shape).toBeNull()
  })
})

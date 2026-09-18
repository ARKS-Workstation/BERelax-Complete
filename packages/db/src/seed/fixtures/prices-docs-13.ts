import {
  SERVICE_DURATIONS,
  type ServiceDuration,
  TREATMENT_KEYS,
  TREATMENT_STYLES,
  type TreatmentKey,
  type TreatmentStyle,
} from '@berelax/shared'

/**
 * The 32 prices of docs/13 §4, transcribed.
 *
 * This file is a **transcription and nothing else**. Every figure below is read off one of the two
 * tables in docs/13 §4 — "Asian menu" and "Arabic menu", four treatments each, four durations each —
 * and no figure is derived, interpolated or rounded from another. If a cell here disagrees with the
 * document, the document wins and this file is wrong.
 *
 * ## Why the numbers are here and not in the migration
 *
 * 0017_catalogue.sql seeds the 8 services and deliberately not their prices, and says why: a price is
 * business data that changes, and a migration cannot be re-run when it does. It also says "two sources
 * for the same 32 numbers is one source too many", which is why nothing else in this repository may
 * carry a second copy of this table. The fixture salon in `packages/fixtures/src/salon.ts` holds a
 * 12-row *subset* for the demo dataset and is not a second source: it is under the fixture-digest gate
 * and its own comment says the full catalogue belongs here.
 *
 * ## Why AED and not fils
 *
 * The columns below are written in the unit docs/13 prints — whole dirhams — so a reader can compare the
 * file to the document cell by cell without doing arithmetic in their head. Fils is what the database
 * stores, and the conversion is the single multiplication in {@link docs13PriceCells}. Writing 17000
 * here would make the transcription unreviewable, which is the only property this file has.
 *
 * ## Why a nested Record rather than a list of rows
 *
 * `Record<TreatmentStyle, Record<TreatmentKey, Record<ServiceDuration, number>>>` is total over all
 * three enums, so a missing cell is a **compile error** and the count is 2 × 4 × 4 = 32 by
 * construction. A list of 32 objects would let a dropped line pass `tsc` and be discovered as a service
 * with three durations on the live menu.
 */

/** Minor units per dirham. A price is integer fils (ADR 0007); 0.05 AED cannot be a float. */
export const FILS_PER_AED = 100

/**
 * docs/13 §4, verbatim.
 *
 * Read down a column to compare with the document: the treatment order here is the document's order,
 * and so is the style order.
 */
export const DOCS_13_PRICES_AED: Readonly<
  Record<TreatmentStyle, Readonly<Record<TreatmentKey, Readonly<Record<ServiceDuration, number>>>>>
> = Object.freeze({
  // docs/13 §4 — "Asian menu"
  asian: Object.freeze({
    normal_massage: Object.freeze({ 45: 170, 60: 200, 90: 300, 120: 400 }),
    hot_oil_balm_massage: Object.freeze({ 45: 200, 60: 250, 90: 350, 120: 450 }),
    morocco_bath_jacuzzi: Object.freeze({ 45: 250, 60: 300, 90: 440, 120: 550 }),
    massage_with_shaving: Object.freeze({ 45: 200, 60: 250, 90: 350, 120: 450 }),
  }),
  // docs/13 §4 — "Arabic menu"
  arabic: Object.freeze({
    normal_massage: Object.freeze({ 45: 200, 60: 250, 90: 350, 120: 450 }),
    hot_oil_balm_massage: Object.freeze({ 45: 250, 60: 300, 90: 400, 120: 500 }),
    morocco_bath_jacuzzi: Object.freeze({ 45: 330, 60: 380, 90: 520, 120: 620 }),
    massage_with_shaving: Object.freeze({ 45: 300, 60: 350, 90: 450, 120: 550 }),
  }),
})

/** One `(style, treatment, duration)` price point, in both units. */
export interface Docs13PriceCell {
  readonly style: TreatmentStyle
  readonly treatmentKey: TreatmentKey
  readonly durationMinutes: ServiceDuration
  /** As docs/13 prints it, for a human comparing the two. */
  readonly aed: number
  /** As the database stores it: VAT-inclusive gross, integer fils. */
  readonly grossPriceFils: number
}

/**
 * The 32 cells, flattened in a fixed order: style, then treatment, then ascending duration.
 *
 * The order is fixed rather than incidental because the seed inserts in this order and the determinism
 * assertion compares one run's rows against the next's.
 */
export function docs13PriceCells(): readonly Docs13PriceCell[] {
  const cells: Docs13PriceCell[] = []
  for (const style of TREATMENT_STYLES) {
    for (const treatmentKey of TREATMENT_KEYS) {
      for (const durationMinutes of SERVICE_DURATIONS) {
        const aed = DOCS_13_PRICES_AED[style][treatmentKey][durationMinutes]
        cells.push({
          style,
          treatmentKey,
          durationMinutes,
          aed,
          grossPriceFils: aed * FILS_PER_AED,
        })
      }
    }
  }
  return Object.freeze(cells)
}

/** How many price points docs/13 §4 states: 8 services × 4 durations. Asserted, not assumed. */
export const DOCS_13_PRICE_POINT_COUNT = 32

/** One price point as it was actually found, wherever it was read from. */
export interface StoredPricePoint {
  readonly style: string
  readonly treatmentKey: string
  readonly durationMinutes: number
  readonly grossPriceFils: number
}

/** A cell that does not match docs/13, named so the failure says which one. */
export interface PriceMismatch {
  /** `arabic/morocco_bath_jacuzzi 90min`. The spelling a failure message should carry. */
  readonly cell: string
  readonly expectedFils: number | null
  readonly actualFils: number | null
  readonly reason: 'wrong_price' | 'missing' | 'not_in_docs_13'
}

/**
 * Compares a set of stored price points against docs/13 §4 and names every cell that disagrees.
 *
 * Written as a function over an argument rather than as assertions inside a test, for two reasons that
 * are the same reason twice. The caller that matters is the integration test, which passes the 32 rows
 * it read out of `service_variant` — so the comparison is "the database against the document", not the
 * document against itself, which is what a test asserting the fixture table's own contents would be.
 * And because it takes an argument, the test can pass a deliberately corrupted copy and assert that the
 * one wrong cell is reported by name: a comparison nobody has seen fail is not a comparison.
 *
 * All three reasons are reported, not just the first, and `not_in_docs_13` is one of them: a 33rd price
 * point is as wrong as a missing one and would otherwise pass a test that only looked for the 32.
 */
export function comparePriceCells(stored: readonly StoredPricePoint[]): readonly PriceMismatch[] {
  const label = (style: string, key: string, minutes: number) => `${style}/${key} ${minutes}min`
  const expected = new Map(
    docs13PriceCells().map((cell) => [
      label(cell.style, cell.treatmentKey, cell.durationMinutes),
      cell.grossPriceFils,
    ]),
  )
  const mismatches: PriceMismatch[] = []
  const seen = new Set<string>()

  for (const row of stored) {
    const cell = label(row.style, row.treatmentKey, row.durationMinutes)
    seen.add(cell)
    const want = expected.get(cell)
    if (want === undefined) {
      mismatches.push({
        cell,
        expectedFils: null,
        actualFils: row.grossPriceFils,
        reason: 'not_in_docs_13',
      })
    } else if (want !== row.grossPriceFils) {
      mismatches.push({
        cell,
        expectedFils: want,
        actualFils: row.grossPriceFils,
        reason: 'wrong_price',
      })
    }
  }

  for (const [cell, want] of expected) {
    if (!seen.has(cell)) {
      mismatches.push({ cell, expectedFils: want, actualFils: null, reason: 'missing' })
    }
  }

  return Object.freeze(mismatches)
}

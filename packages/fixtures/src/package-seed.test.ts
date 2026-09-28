import { isPlaceholderText } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  assertFixturePackageNamesAreMarked,
  FIXTURE_PACKAGE_MARKER,
  FIXTURE_PACKAGE_OPEN_QUESTION,
  FIXTURE_PACKAGE_SHAPES,
  fixturePackageName,
} from './package-seed.ts'

/**
 * The one property the whole seeded-package approach rests on (M-TILL-13).
 *
 * What this business sells as a package is a fact nobody has stated, and the screens where an invented product
 * name would appear in a screenshot are M-TILL-13's. So the fixture's answer is not "pick a plausible menu and
 * hope nobody mistakes it": it is that **every seeded package name is a name the schema itself would refuse on
 * a document**. `is_placeholder_text()` (0026) is the function that stops `TRN-PENDING-Y1-TRN` reaching
 * `invoice.issuer_trn`, and `isPlaceholderText` in `@berelax/core` is its other statement; a name that matches
 * it cannot be printed on a tax document as though it were a product.
 *
 * That property is checkable, cheap, and invisible to every other test in the repository, which is why it has a
 * file of its own rather than a line inside the loader.
 */

describe('acceptance — no seeded package can be mistaken for a product the business sells', () => {
  it('marks every name so the schema would refuse it on a document', () => {
    const names = FIXTURE_PACKAGE_SHAPES.map((shape) => fixturePackageName(shape))
    expect(names).toHaveLength(4)
    for (const name of names) {
      // The marker, the question, and the sentence that says what it is not — all three in the name, because
      // the name is the only part of a package a screenshot reliably shows.
      expect(name, 'carries a marker is_placeholder_text recognises').toSatisfy(isPlaceholderText)
      expect(name).toContain(FIXTURE_PACKAGE_MARKER)
      expect(name).toContain(FIXTURE_PACKAGE_OPEN_QUESTION)
      expect(name).toContain('not a package this business sells')
    }
    // And they are DISTINCT, so four templates on the screen are four packages rather than one name four times.
    expect(new Set(names).size).toBe(4)
    assertFixturePackageNamesAreMarked(names)
  })

  it('the control: a plausible product name is refused by name', () => {
    // Without this, `assertFixturePackageNamesAreMarked` could be a function that never throws and the case
    // above would prove nothing at all about the four names (ADR 0003, brief rule 3). The string below is
    // exactly the kind of thing a fixture would otherwise have invented.
    expect(() => assertFixturePackageNamesAreMarked(['6 Massage Package'])).toThrow(
      /could mistake it for a product/,
    )
    expect(isPlaceholderText('6 Massage Package')).toBe(false)
    // A marker in the middle counts too, so the check is not about a prefix.
    expect(isPlaceholderText('Six massages [confirm] — Y9-package-catalogue')).toBe(true)
  })

  it('names the four drawdown states docs/12 §5 asks the fixture salon to hold', () => {
    // Stated here as well as in the loader, because "several drawdown states" is the acceptance and a shape
    // quietly dropped from the list would leave a state seeded by nothing and asserted by nothing.
    expect([...FIXTURE_PACKAGE_SHAPES.map((shape) => shape.state)].sort()).toEqual([
      'expired with a balance',
      'fully used',
      'part used',
      'untouched',
    ])
    // The expired shape is the only one that overrides its terms, and the arithmetic is why: the seeded
    // business-day range opens 2026-05-21 and the frozen clock's today is 2026-09-18, so six months from the
    // earliest day the premises traded has not expired yet.
    const overridden = FIXTURE_PACKAGE_SHAPES.filter((shape) => shape.validityMonths !== undefined)
    expect(overridden).toHaveLength(1)
    expect(overridden[0]?.state).toBe('expired with a balance')
    expect(overridden[0]?.validityMonths).toBe(3)
    // Every shape draws down no more than it sold, which is `package_balance_cannot_overdraw` restated where a
    // reader of the fixture will look — a shape asking for five redemptions of a three-session package would
    // fail at the seed with a constraint name rather than here with its own sentence.
    for (const shape of FIXTURE_PACKAGE_SHAPES) {
      expect(shape.redeemed, shape.templateKey).toBeLessThanOrEqual(shape.sessions)
    }
  })
})
